/**
 * File logging. Nothing in the helper may write to stdout (it carries native
 * messaging frames), so every diagnostic goes here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const LIVE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Combined human-readable log, one line per event, tailed by the options page. */
export class LiveLog {
  readonly path: string;

  constructor(
    readonly dir: string,
    private readonly maxBytes = LIVE_LOG_MAX_BYTES,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "live.log");
  }

  write(line: string): void {
    const clean = line.replace(/\r?\n/g, " | ");
    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, `${new Date().toISOString()} ${clean}\n`);
    } catch {
      /* logging must never crash the helper */
    }
  }

  tail(lines: number): string {
    if (!existsSync(this.path)) return "";
    const n = Math.max(0, Math.min(Math.floor(lines) || 0, 5000));
    const all = readFileSync(this.path, "utf8").split("\n");
    if (all[all.length - 1] === "") all.pop();
    let text = n === 0 ? "" : all.slice(-n).join("\n");
    // Keep getLog responses well under the 1 MB native messaging cap.
    if (text.length > 400_000) text = text.slice(-400_000);
    return text;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path) || statSync(this.path).size < this.maxBytes) return;
    const old = this.path + ".1";
    rmSync(old, { force: true });
    renameSync(this.path, old);
  }
}

/** Short one-line summary of an event for live.log. */
export function summarize(event: Record<string, unknown>, max = 300): string {
  const { type, ...rest } = event;
  let body: string;
  try {
    body = JSON.stringify(rest);
  } catch {
    body = String(rest);
  }
  if (body.length > max) body = body.slice(0, max) + "...";
  return `${String(type ?? "event")} ${body}`;
}

export type EventLogger = (event: Record<string, unknown>) => void;

/** Per-run JSONL log (`runs/<task>-<stamp>/log.jsonl`), mirrored to live.log. */
export class RunLog {
  constructor(
    readonly path: string,
    private readonly live: LiveLog | null,
    private readonly taskId: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  event(event: Record<string, unknown>): void {
    const record = { ts: new Date().toISOString(), taskId: this.taskId, ...event };
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch {
      /* ignore */
    }
    this.live?.write(`${this.taskId} ${summarize(event)}`);
  }
}

/** Safety net: route console.* to the live log so nothing reaches stdout. */
export function redirectConsole(live: LiveLog): void {
  const to =
    (level: string) =>
    (...args: unknown[]) =>
      live.write(`console.${level} ${args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")}`);
  console.log = to("log");
  console.info = to("info");
  console.warn = to("warn");
  console.error = to("error");
  console.debug = to("debug");
  console.trace = to("trace");
}

/** The message of a thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
