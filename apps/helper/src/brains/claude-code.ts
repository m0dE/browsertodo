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
import { DeltaBatcher, MAX_ASSISTANT_TEXT, clipEventText, type AgentEvent } from "@browsertodo/shared";
import { humanMessage } from "@browsertodo/core";
import { claudeEnv, isolatedClaudeArgs, killTree } from "../claude-process.js";
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
    // Text arrives as it is written (stream_event lines), for the chat to show live.
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--append-system-prompt",
    opts.systemPrompt,
    ...isolatedClaudeArgs(opts.model),
  ];
}

/** The fields of a Claude Code stream-json line the brain reads (untrusted JSON: each is checked before use). */
interface StreamLine {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  model?: unknown;
  message?: { id?: unknown; content?: unknown };
  /** stream_event lines: set for a subagent's stream. */
  parent_tool_use_id?: unknown;
  /** stream_event lines: the Messages API stream event. */
  event?: {
    type?: unknown;
    index?: unknown;
    message?: { id?: unknown };
    content_block?: { type?: unknown; text?: unknown };
    delta?: { type?: unknown; text?: unknown };
  };
}

function asStreamLine(value: unknown): StreamLine | null {
  return value && typeof value === "object" ? (value as StreamLine) : null;
}

/** One stream-json input line carrying a user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Claude Code stream-json events to AgentEvents. Stateful: with
 * --include-partial-messages, text arrives first as stream_event deltas
 * (content_block_delta / text_delta) and then once more, complete, in an
 * "assistant" event per content block. Each streamed text block gets the id
 * "<message id>:<block index>"; its assistant_text carries the same id so
 * the chat replaces the live text with it. Thinking deltas are ignored. Tool
 * calls and results are not mapped: the helper's tool executor emits them.
 */
export class ClaudeStreamMapper {
  private messageId: string | null = null;
  /** Streamed text blocks of the current message whose assistant event has not come yet, in order. */
  private open: string[] = [];

  map(line: unknown): AgentEvent[] {
    const ev = asStreamLine(line);
    if (!ev) return [];
    if (ev.type === "stream_event") return this.partial(ev);
    const content = ev.message?.content;
    if (ev.type === "assistant" && Array.isArray(content)) {
      const sameMessage = typeof ev.message?.id === "string" && ev.message.id === this.messageId;
      const out: AgentEvent[] = [];
      for (const block of content as unknown[]) {
        const b = block as { type?: unknown; text?: unknown } | null;
        if (b?.type !== "text" || typeof b.text !== "string") continue;
        const id = sameMessage ? this.open.shift() : undefined;
        if (!b.text.trim()) continue;
        const e: AgentEvent = { type: "assistant_text", text: clipEventText(b.text, MAX_ASSISTANT_TEXT) };
        if (id) e.id = id;
        out.push(e);
      }
      return out;
    }
    if (ev.type === "result" && (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success"))) {
      const detail = typeof ev.result === "string" && ev.result.trim() ? ev.result : typeof ev.subtype === "string" ? ev.subtype : "error";
      return [{ type: "error", text: clipEventText(`Claude Code: ${detail}`) }];
    }
    if (ev.type === "system" && ev.subtype === "init") {
      return [{ type: "status", text: `Claude Code started${typeof ev.model === "string" && ev.model ? ` (${ev.model})` : ""}` }];
    }
    return [];
  }

  private partial(ev: StreamLine): AgentEvent[] {
    // Subagents' streams (none today: Claude Code runs without its own tools).
    if (ev.parent_tool_use_id) return [];
    const e = ev.event;
    if (!e || typeof e !== "object") return [];
    if (e.type === "message_start") {
      this.messageId = typeof e.message?.id === "string" ? e.message.id : null;
      this.open = [];
      return [];
    }
    if (!this.messageId || typeof e.index !== "number") return [];
    const id = `${this.messageId}:${e.index}`;
    if (e.type === "content_block_start" && e.content_block?.type === "text") {
      this.open.push(id);
      const text = e.content_block.text;
      return typeof text === "string" && text ? [{ type: "assistant_text_delta", id, text }] : [];
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string" && e.delta.text && this.open.includes(id)) {
      return [{ type: "assistant_text_delta", id, text: e.delta.text }];
    }
    return [];
  }
}

/** Raw stream lines kept out of the run log (and so the Raw Log): the partial-message deltas; the full text follows in "assistant". */
export function isNoisyStreamLine(line: unknown): boolean {
  const ev = asStreamLine(line);
  return ev?.type === "stream_event" || (ev?.type === "system" && ev.subtype === "thinking_tokens");
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
        send(kind === "followup" ? text : humanMessage(text));
      });
      ctx.input.onClose(() => {
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      });

      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const mapper = new ClaudeStreamMapper();
      // Live text goes out in ~50 ms batches; every other event first sends what is pending.
      const out = new DeltaBatcher(ctx.emit);
      const lines = new LineSplitter();
      child.stdout!.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "claude_stdout", text: line.slice(0, 2000) });
            continue;
          }
          if (!isNoisyStreamLine(event)) ctx.log({ type: "claude", event });
          // Claude Code repeats its init event for every turn; "started" is said once per session.
          const ev = asStreamLine(event);
          const isInit = ev?.type === "system" && ev.subtype === "init";
          if (!(isInit && started))
            for (const e of mapper.map(event)) {
              if (e.type === "assistant_text_delta") out.delta(e.id, e.text);
              else out.emit(e);
            }
          if (isInit) started = true;
          if (ev?.type === "result") {
            out.flush();
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
        out.flush();
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_exit", code, signal });
        resolve();
      });
    });
  }
}
