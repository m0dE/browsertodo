/**
 * Runs Claude Code for one task as a real interactive session in a task
 * terminal, so the user can watch it (and type into it) in the side panel's
 * Terminal tab. The task prompt is the positional prompt argument; human
 * messages are typed into the session. Claude only gets the browsertodo MCP
 * tools: no shell, file or web access. Each turn's result comes from the
 * task_* tool calls the TaskRunner records. The session stays open after
 * one, idle, for follow-up messages (typed in like the first); when the
 * runner closes the input, Claude gets a moment to finish printing, then the
 * session is ended with /exit (and killed if it lingers).
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Brain, BrainContext } from "./brain.js";
import { claudeEnv } from "./claude-code.js";
import type { TaskTerminal, TaskTerminalSpec } from "../terminal.js";
import { detectBlockingPrompt, ScreenText } from "../terminal-responder.js";

export interface TaskTerminals {
  openTask(spec: TaskTerminalSpec): TaskTerminal;
}

export interface ClaudePtyOptions {
  claudePath: string;
  model: string;
  terminals: TaskTerminals;
  /** Working folder (%LOCALAPPDATA%\browsertodo\workspace), the same one the user's session uses. */
  cwd: string;
  /** Extra leading args, for tests that run a fake claude script with node. */
  prefixArgs?: string[];
  /** When the session is ended: time Claude gets to finish printing before /exit. Default 3 s. */
  finishDelayMs?: number;
  /** After /exit: time before the process tree is killed. Default 5 s. */
  exitKillMs?: number;
  /** No output this long means Claude is waiting for input. Default 45 s. */
  quietMs?: number;
  /** Delay between typed text and its Enter, so the TUI does not take both as one paste. Default 150 ms. */
  enterDelayMs?: number;
  cols?: number;
  rows?: number;
}

/** Interactive-mode arguments. The prompt goes last, after a single-value option. */
export function buildInteractiveArgs(opts: { systemPrompt: string; mcpConfigPath: string; allowedTools: string[]; model: string; prompt: string }): string[] {
  return [
    "--mcp-config",
    opts.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    opts.allowedTools.join(","),
    "--tools",
    "",
    "--setting-sources",
    "",
    "--append-system-prompt",
    opts.systemPrompt,
    "--model",
    opts.model,
    opts.prompt,
  ];
}

export const NUDGE =
  "(browsertodo) Your turn ended without calling task_complete, task_fail or task_pause. Call exactly one of them now to report the result.";

/** One line of typed input: newlines would submit early, so they become spaces. */
export function typedLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").trim();
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export class ClaudePtyBrain implements Brain {
  readonly persistent = true;

  constructor(private readonly opts: ClaudePtyOptions) {}

  run(ctx: BrainContext): Promise<void> {
    const o = this.opts;
    const model = ctx.model?.trim() || o.model;
    const args = buildInteractiveArgs({
      systemPrompt: ctx.systemPrompt,
      mcpConfigPath: ctx.mcpConfigPath,
      allowedTools: ctx.allowedTools,
      model,
      prompt: ctx.prompt,
    });
    ctx.log({ type: "claude_start", mode: "terminal", claudePath: o.claudePath, model, allowedTools: ctx.allowedTools, cwd: o.cwd });
    return new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return resolve();
      let term: TaskTerminal;
      try {
        term = o.terminals.openTask({
          title: ctx.title ?? "Task",
          sessionId: ctx.taskId,
          file: o.claudePath,
          args: [...(o.prefixArgs ?? []), ...args],
          cwd: o.cwd,
          env: stringEnv(claudeEnv()),
          ...(o.cols ? { cols: o.cols } : {}),
          ...(o.rows ? { rows: o.rows } : {}),
        });
      } catch (e) {
        return reject(e);
      }
      ctx.log({ type: "claude_terminal", terminalId: term.terminalId, pid: term.pid });
      ctx.emit({ type: "status", text: `Claude Code is running in the Terminal tab (${model})` });

      // Raw transcript beside the run log.
      let transcript: WriteStream | null = null;
      try {
        transcript = createWriteStream(join(ctx.runDir ?? ".", "terminal.log"));
        transcript.on("error", () => (transcript = null));
      } catch {
        transcript = null;
      }

      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (ms: number, fn: () => void) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      };
      const typeLine = (text: string) => {
        term.write(text);
        later(o.enterDelayMs ?? 150, () => term.write("\r"));
      };

      let ending = false;
      let exited = false;
      /** Ends the session: /exit, then kill if it is still there. */
      const end = (why: string, delayMs: number) => {
        if (ending || exited) return;
        ending = true;
        ctx.log({ type: "claude_end", why });
        later(delayMs, () => {
          typeLine("/exit");
          later(o.exitKillMs ?? 5000, () => {
            ctx.log({ type: "claude_kill", reason: "did not exit after /exit" });
            term.kill();
          });
        });
      };

      const screen = new ScreenText();
      let blocked = false;
      let nudged = false;
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const armQuiet = () => {
        if (quiet) {
          clearTimeout(quiet);
          timers.delete(quiet);
        }
        if (ending || blocked) return;
        quiet = later(o.quietMs ?? 45_000, () => {
          quiet = null;
          if (ending || ctx.input.closed || ctx.signal.aborted || ctx.inTurn?.() === false) return;
          if (!nudged) {
            nudged = true;
            ctx.log({ type: "claude_idle", action: "nudge" });
            typeLine(NUDGE);
            armQuiet();
            return;
          }
          ctx.log({ type: "claude_idle", action: "turn over" });
          // The turn is over without a result; the session stays open for the next message.
          if (ctx.idle) ctx.idle();
          else end("idle after nudge", 0);
        });
      };

      term.onData((data) => {
        transcript?.write(data);
        armQuiet();
        if (blocked) return;
        const found = detectBlockingPrompt(screen.push(data));
        if (!found) return;
        blocked = true;
        ctx.log({ type: "claude_blocked", kind: found.kind, screen: screen.value.slice(-1500) });
        if (found.kind === "limit") {
          ctx.emit({ type: "error", text: found.error });
          term.kill();
        } else if (ctx.pause) {
          ctx.pause(found.reason);
        } else {
          ctx.emit({ type: "error", text: found.reason });
          term.kill();
        }
      });

      ctx.input.onMessage((text, kind) => {
        const line = typedLine(text);
        if (!line || ending) return;
        ctx.log({ type: "claude_user_message", kind, chars: line.length });
        // A new turn gets its own nudge.
        if (kind === "followup") nudged = false;
        typeLine(line);
        armQuiet();
      });
      // The TaskRunner closes the input to end the session.
      ctx.input.onClose(() => end("session ended", o.finishDelayMs ?? 3000));

      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        term.kill();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      armQuiet();

      term.onExit((exitCode) => {
        exited = true;
        ctx.signal.removeEventListener("abort", onAbort);
        for (const t of timers) clearTimeout(t);
        timers.clear();
        ctx.log({ type: "claude_exit", code: exitCode, screen: screen.value.slice(-1500) });
        transcript?.end();
        resolve();
      });
    });
  }
}
