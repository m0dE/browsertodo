/**
 * Terminals over node-pty: the user's interactive Claude Code session (one at
 * a time) and the Claude Code session of each running task, side by side.
 * Bytes are piped both ways; output is batched into helper.terminal.data
 * notifications. For the user's session the side panel's xterm.js is the
 * terminal emulator. Task terminals may run with no panel attached, so the
 * helper answers their capability queries itself (TerminalResponder).
 */
import type { TerminalInfo } from "@browsertodo/shared";
import { killPid } from "./brains/claude-code.js";
import { stripQueryReplies, TerminalResponder } from "./terminal-responder.js";

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

/**
 * One Windows command line from argv, quoted the way the C runtime (and
 * claude.exe) splits it: empty args and args with spaces, tabs, newlines or
 * quotes are wrapped in quotes, with backslashes before a quote doubled.
 * node-pty's own quoting leaves an arg alone when it already starts and ends
 * with a quote, which would break a prompt like `"hello there"`.
 */
export function windowsCommandLine(args: string[]): string {
  return args
    .map((a) => {
      if (a !== "" && !/[\s"]/.test(a)) return a;
      let out = '"';
      let slashes = 0;
      for (const ch of a) {
        if (ch === "\\") {
          slashes++;
          continue;
        }
        if (ch === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
        else out += "\\".repeat(slashes) + ch;
        slashes = 0;
      }
      return out + "\\".repeat(slashes * 2) + '"';
    })
    .join(" ");
}

/** node-pty's spawn, or null when the native module cannot be loaded. */
export async function loadNodePty(): Promise<PtyFactory | null> {
  try {
    const mod: any = await import("node-pty");
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== "function") return null;
    return (file, args, opts) =>
      spawn(file, process.platform === "win32" ? windowsCommandLine(args) : args, { ...opts, useConpty: true }) as PtyLike;
  } catch {
    return null;
  }
}

export const FLUSH_MS = 16;
export const MAX_CHUNK = 32 * 1024;
export const USER_TERMINAL_TITLE = "Claude Code";

export interface TerminalCommand {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalDeps {
  factory: PtyFactory | null;
  /** The user's session: command and args, called on each start (writes the MCP config, builds the prompt). */
  command: () => TerminalCommand;
  onData: (terminalId: string, data: string) => void;
  onExit: (terminalId: string, exitCode: number | null) => void;
  /** A terminal started (helper.terminal.opened). */
  onOpened?: (info: TerminalInfo) => void;
  log?: (line: string) => void;
  flushMs?: number;
  maxChunk?: number;
  /** Kills the process tree (default: taskkill /T /F on Windows). */
  killTree?: (pid: number) => void;
}

/** A task's terminal, as the brain that runs in it sees it. */
export interface TaskTerminal {
  readonly terminalId: string;
  readonly pid: number;
  /** Writes to the program, as if typed. */
  write(data: string): void;
  /** Raw output, unbatched, as it arrives. */
  onData(cb: (data: string) => void): void;
  /** Called once, when the program exits or the terminal is stopped. */
  onExit(cb: (exitCode: number | null) => void): void;
  /** Kills the process tree. */
  kill(): void;
}

export interface TaskTerminalSpec extends TerminalCommand {
  title: string;
  sessionId: string;
  cols?: number;
  rows?: number;
}

interface Running {
  info: TerminalInfo;
  pty: PtyLike;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  /** Task terminals answer the TUI's queries in the helper. */
  responder: TerminalResponder | null;
  dataListeners: ((data: string) => void)[];
  exitListeners: ((exitCode: number | null) => void)[];
}

export class TerminalManager {
  private readonly terminals = new Map<string, Running>();
  private userId: string | null = null;
  private seq = 0;

  constructor(private readonly deps: TerminalDeps) {}

  get available(): boolean {
    return this.deps.factory !== null;
  }

  /** The user's own session, when running. */
  get runningId(): string | null {
    return this.userId;
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => ({ ...t.info }));
  }

  /** Starts the user's session; an already running one is stopped first (one at a time). */
  start(cols: number, rows: number): { terminalId: string } {
    if (!this.deps.factory) throw new Error("the interactive terminal is not available: node-pty could not be loaded");
    if (this.userId) this.stop(this.userId);
    const t = this.spawn({ kind: "user", title: USER_TERMINAL_TITLE }, this.deps.command(), cols, rows, false);
    this.userId = t.info.terminalId;
    return { terminalId: t.info.terminalId };
  }

  /** Starts a task's Claude Code session. It runs beside the user's session. */
  openTask(spec: TaskTerminalSpec): TaskTerminal {
    if (!this.deps.factory) throw new Error("the task terminal is not available: node-pty could not be loaded");
    const t = this.spawn({ kind: "task", title: spec.title, sessionId: spec.sessionId }, spec, spec.cols ?? 120, spec.rows ?? 40, true);
    const id = t.info.terminalId;
    return {
      terminalId: id,
      pid: t.pty.pid,
      write: (data) => {
        if (!t.exited) t.pty.write(data);
      },
      onData: (cb) => void t.dataListeners.push(cb),
      onExit: (cb) => {
        if (t.exited) cb(null);
        else t.exitListeners.push(cb);
      },
      kill: () => this.stop(id),
    };
  }

  input(terminalId: string, data: string): void {
    const t = this.get(terminalId);
    const clean = t.responder ? stripQueryReplies(data) : data;
    if (clean) t.pty.write(clean);
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
    const t = this.terminals.get(terminalId);
    if (!t) return;
    (this.deps.killTree ?? killPid)(t.pty.pid);
    try {
      t.pty.kill();
    } catch {
      /* already gone */
    }
    // Some PTYs do not report an exit after kill; make sure everyone hears about it.
    this.finish(t, null);
  }

  stopAll(): void {
    for (const id of [...this.terminals.keys()]) this.stop(id);
  }

  private spawn(meta: Omit<TerminalInfo, "terminalId">, cmd: TerminalCommand, cols: number, rows: number, respond: boolean): Running {
    const factory = this.deps.factory!;
    const id = `${meta.kind === "task" ? "task" : "term"}-${Date.now().toString(36)}-${++this.seq}`;
    const pty = factory(cmd.file, cmd.args, {
      name: "xterm-256color",
      cols: clampSize(cols, 80),
      rows: clampSize(rows, 24),
      cwd: cmd.cwd,
      env: cmd.env,
    });
    const info: TerminalInfo = { terminalId: id, ...meta };
    const t: Running = {
      info,
      pty,
      buffer: "",
      timer: null,
      exited: false,
      responder: respond ? new TerminalResponder() : null,
      dataListeners: [],
      exitListeners: [],
    };
    this.terminals.set(id, t);
    this.deps.log?.(`terminal ${id} (${meta.kind}) started pid=${pty.pid} ${cmd.file}`);
    pty.onData((data) => {
      if (t.exited) return;
      const reply = t.responder?.feed(data);
      if (reply) {
        try {
          pty.write(reply);
        } catch {
          /* exiting */
        }
      }
      // Buffer first: a listener may stop the terminal, which flushes what was seen.
      this.push(t, data);
      for (const fn of t.dataListeners) {
        try {
          fn(data);
        } catch (e) {
          this.deps.log?.(`terminal ${id} listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
    pty.onExit(({ exitCode }) => this.finish(t, typeof exitCode === "number" ? exitCode : null));
    try {
      this.deps.onOpened?.({ ...info });
    } catch {
      /* the extension may be gone */
    }
    return t;
  }

  private finish(t: Running, exitCode: number | null): void {
    if (t.exited) return;
    t.exited = true;
    this.flush(t);
    this.terminals.delete(t.info.terminalId);
    if (this.userId === t.info.terminalId) this.userId = null;
    this.deps.log?.(`terminal ${t.info.terminalId} exited code=${exitCode}`);
    this.deps.onExit(t.info.terminalId, exitCode);
    for (const fn of t.exitListeners.splice(0)) {
      try {
        fn(exitCode);
      } catch {
        /* ignore */
      }
    }
  }

  private get(terminalId: string): Running {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`no running terminal ${terminalId}`);
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
      this.deps.onData(t.info.terminalId, chunk);
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
