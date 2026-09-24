/**
 * The interactive Claude Code terminal: one node-pty process at a time,
 * bytes piped both ways (the side panel's xterm.js is the terminal emulator
 * and answers the app's capability queries). Output is batched into
 * helper.terminal.data notifications.
 */
import { killPid } from "./brains/claude-code.js";

export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyLike;

/** node-pty's spawn, or null when the native module cannot be loaded. */
export async function loadNodePty(): Promise<PtyFactory | null> {
  try {
    const mod: any = await import("node-pty");
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== "function") return null;
    return (file, args, opts) => spawn(file, args, { ...opts, useConpty: true }) as PtyLike;
  } catch {
    return null;
  }
}

export const FLUSH_MS = 16;
export const MAX_CHUNK = 32 * 1024;

export interface TerminalDeps {
  factory: PtyFactory | null;
  /** Command and args to run; called on each start (writes the MCP config, builds the prompt). */
  command: () => { file: string; args: string[]; cwd: string; env: Record<string, string> };
  onData: (terminalId: string, data: string) => void;
  onExit: (terminalId: string, exitCode: number | null) => void;
  log?: (line: string) => void;
  flushMs?: number;
  maxChunk?: number;
  /** Kills the process tree (default: taskkill /T /F on Windows). */
  killTree?: (pid: number) => void;
}

interface Running {
  id: string;
  pty: PtyLike;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
}

export class TerminalManager {
  private current: Running | null = null;
  private seq = 0;

  constructor(private readonly deps: TerminalDeps) {}

  get available(): boolean {
    return this.deps.factory !== null;
  }

  get runningId(): string | null {
    return this.current?.id ?? null;
  }

  /** Starts a terminal; an already running one is stopped first (one at a time). */
  start(cols: number, rows: number): { terminalId: string } {
    const factory = this.deps.factory;
    if (!factory) throw new Error("the interactive terminal is not available: node-pty could not be loaded");
    if (this.current) this.stop(this.current.id);
    const cmd = this.deps.command();
    const id = `term-${Date.now().toString(36)}-${++this.seq}`;
    const pty = factory(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: clampSize(cols, 80),
      rows: clampSize(rows, 24),
      cwd: cmd.cwd,
      env: cmd.env,
    });
    const t: Running = { id, pty, buffer: "", timer: null, exited: false };
    this.current = t;
    this.deps.log?.(`terminal ${id} started pid=${pty.pid} ${cmd.file}`);
    pty.onData((data) => this.push(t, data));
    pty.onExit(({ exitCode }) => {
      if (t.exited) return;
      t.exited = true;
      this.flush(t);
      if (this.current === t) this.current = null;
      this.deps.log?.(`terminal ${id} exited code=${exitCode}`);
      this.deps.onExit(id, typeof exitCode === "number" ? exitCode : null);
    });
    return { terminalId: id };
  }

  input(terminalId: string, data: string): void {
    const t = this.get(terminalId);
    t.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const t = this.get(terminalId);
    try {
      t.pty.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch (e) {
      this.deps.log?.(`terminal resize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Kills the process tree. Unknown or finished terminals are ignored. */
  stop(terminalId: string): void {
    const t = this.current;
    if (!t || t.id !== terminalId) return;
    this.flush(t);
    this.current = null;
    (this.deps.killTree ?? killPid)(t.pty.pid);
    try {
      t.pty.kill();
    } catch {
      /* already gone */
    }
    // Some PTYs do not report an exit after kill; make sure the panel hears about it.
    if (!t.exited) {
      t.exited = true;
      this.deps.onExit(t.id, null);
    }
  }

  stopAll(): void {
    if (this.current) this.stop(this.current.id);
  }

  private get(terminalId: string): Running {
    const t = this.current;
    if (!t || t.id !== terminalId) throw new Error(`no running terminal ${terminalId}`);
    return t;
  }

  private push(t: Running, data: string): void {
    t.buffer += data;
    if (t.buffer.length >= (this.deps.maxChunk ?? MAX_CHUNK)) {
      this.flush(t);
      return;
    }
    if (!t.timer) t.timer = setTimeout(() => this.flush(t), this.deps.flushMs ?? FLUSH_MS);
  }

  private flush(t: Running): void {
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    const max = this.deps.maxChunk ?? MAX_CHUNK;
    while (t.buffer) {
      const chunk = t.buffer.slice(0, max);
      t.buffer = t.buffer.slice(max);
      this.deps.onData(t.id, chunk);
    }
  }
}

function clampSize(n: number, fallback: number): number {
  return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), 1000) : fallback;
}

/** A PTY stand-in that echoes input and exits on "exit\r" (BROWSERTODO_FAKE_PTY=1, tests only). */
export const fakePtyFactory: PtyFactory = (file, args) => {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  let line = "";
  let done = false;
  const exit = (code: number) => {
    if (done) return;
    done = true;
    setTimeout(() => exitCb({ exitCode: code }), 0);
  };
  // Each argument is shortened, not the whole line, so every flag stays visible to tests.
  const shown = [file, ...args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a))].join(" ");
  setTimeout(() => dataCb(`fake-pty: ${shown}\r\n`), 0);
  return {
    pid: -1,
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => (exitCb = cb),
    write: (d) => {
      if (done) return;
      dataCb(d);
      line += d;
      if (line.includes("exit\r")) exit(0);
      if (line.length > 1000) line = line.slice(-100);
    },
    resize: (c, r) => dataCb(`[resized ${c}x${r}]`),
    kill: () => exit(1),
  };
};

/** Keeps the most recent output of each terminal so a reopened panel can repaint. */
export class TerminalBacklog {
  private readonly buffers = new Map<string, string>();

  constructor(private readonly maxChars: number) {}

  append(terminalId: string, data: string): void {
    const next = (this.buffers.get(terminalId) ?? "") + data;
    this.buffers.set(terminalId, next.length > this.maxChars ? next.slice(next.length - this.maxChars) : next);
  }

  get(terminalId: string): string {
    return this.buffers.get(terminalId) ?? "";
  }

  clear(terminalId: string): void {
    this.buffers.delete(terminalId);
  }
}
