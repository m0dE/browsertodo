/**
 * Runs Claude Code headless for one task, with stream-json in and out, so
 * every assistant message is a structured event for the side panel's
 * Activity view. The task prompt is the first stdin message; stdin stays
 * open so the human can add messages while it runs. Single-turn: stdin is
 * closed after a task_* tool call (or when Claude ends its turn without
 * one). Persistent: stdin stays open for follow-up turns until the runner
 * ends the session. Claude only gets the browsertodo MCP tools: no shell,
 * file or web access.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { clipEventText, type AgentEvent } from "@browsertodo/shared";
import { claudeEnv, killTree } from "../claude-process.js";
import { LineSplitter } from "../line-framing.js";
import type { Brain, BrainContext } from "./brain.js";

export function buildClaudeArgs(opts: { systemPrompt: string; mcpConfigPath: string; allowedTools: string[]; model: string }): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--append-system-prompt",
    opts.systemPrompt,
    "--no-session-persistence",
    "--model",
    opts.model,
  ];
}

/** One stream-json input line carrying a user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * AgentEvents for one Claude Code stream-json event. Tool calls and results
 * are not mapped: the helper's tool executor already emits them.
 */
export function mapStreamEvent(ev: any): AgentEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    return ev.message.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
      .map((b: any) => ({ type: "assistant_text", text: clipEventText(b.text) }));
  }
  if (ev.type === "result" && (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success"))) {
    const detail = typeof ev.result === "string" && ev.result.trim() ? ev.result : (ev.subtype ?? "error");
    return [{ type: "error", text: clipEventText(`Claude Code: ${detail}`) }];
  }
  if (ev.type === "system" && ev.subtype === "init") {
    return [{ type: "status", text: `Claude Code started${ev.model ? ` (${ev.model})` : ""}` }];
  }
  return [];
}

export class ClaudeCodeBrain implements Brain {
  constructor(
    private readonly opts: {
      claudePath: string;
      model: string;
      /** Extra leading args, for tests that run a fake claude script with node. */
      prefixArgs?: string[];
      /**
       * Keep stdin open after a turn (follow-up messages continue the same
       * session); the runner closes the input to end it. Otherwise stdin is
       * closed once every message has its result, so claude exits.
       */
      persistent?: boolean;
    },
  ) {}

  get persistent(): boolean {
    return this.opts.persistent === true;
  }

  run(ctx: BrainContext): Promise<void> {
    // The extension's model setting wins over BROWSERTODO_MODEL / "sonnet".
    const model = ctx.model?.trim() || this.opts.model;
    const args = buildClaudeArgs({
      systemPrompt: ctx.systemPrompt,
      mcpConfigPath: ctx.mcpConfigPath,
      allowedTools: ctx.allowedTools,
      model,
    });
    ctx.log({ type: "claude_start", claudePath: this.opts.claudePath, model, allowedTools: ctx.allowedTools });
    return new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return resolve();
      let child: ChildProcess;
      try {
        child = spawn(this.opts.claudePath, [...(this.opts.prefixArgs ?? []), ...args], {
          cwd: dirname(ctx.mcpConfigPath),
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: claudeEnv(),
        });
      } catch (e) {
        return reject(e);
      }
      const stdin = child.stdin!;
      stdin.on("error", (e) => ctx.log({ type: "claude_stdin_error", message: e.message }));

      // Every user message gets one result event; when all are answered and
      // no task_* was called, Claude has stopped: close stdin so it exits.
      let sent = 0;
      let started = false;
      let results = 0;
      const send = (text: string) => {
        if (stdin.destroyed || stdin.writableEnded) return;
        sent++;
        stdin.write(userMessageLine(text));
      };
      send(ctx.prompt);
      ctx.input.onMessage((text, kind) => {
        ctx.log({ type: "claude_user_message", kind, chars: text.length });
        // Follow-ups come framed by the runner; messages typed mid-turn get their own framing.
        send(kind === "followup" ? text : `Message from the human (they are watching this run): ${text}`);
      });
      ctx.input.onClose(() => {
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      });

      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const lines = new LineSplitter();
      child.stdout!.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "claude_stdout", text: line.slice(0, 2000) });
            continue;
          }
          ctx.log({ type: "claude", event });
          // Claude Code repeats its init event for every turn; "started" is said once per session.
          const isInit = event?.type === "system" && event?.subtype === "init";
          if (!(isInit && started)) for (const e of mapStreamEvent(event)) ctx.emit(e);
          if (isInit) started = true;
          if (event?.type === "result") {
            results++;
            if (results >= sent && !ctx.input.closed) {
              ctx.log({ type: "claude_turns_done", sent, results });
              if (this.persistent) ctx.idle?.();
              else ctx.input.close();
            }
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => ctx.log({ type: "claude_stderr", text: chunk.toString("utf8").slice(0, 2000) }));
      child.on("error", (e) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_error", message: e.message });
        reject(e);
      });
      child.on("close", (code, signal) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_exit", code, signal });
        resolve();
      });
    });
  }
}
