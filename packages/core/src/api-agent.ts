/**
 * Claude API brain: the agent loop over the Anthropic Messages API, with the
 * shared tool executor. act replaces click and type, so a turn can do several
 * steps.
 *
 * A session is a conversation: after a turn ends (task_* call, failure or
 * abort) its message history stays in memory, and continueWith(text) runs
 * the next turn on top of it, like a chat.
 */
import { ANTHROPIC_MESSAGES_URL, delay, DeltaBatcher, errorMessage, OUT_OF_CREDIT, toolsFor, type AgentEvent, type RunConfig, type Sleep, type TaskRunResult, type ToolName } from "@browsertodo/shared";
import type { AgentSession, ApiAgentOptions } from "./types.js";
import { createToolExecutor } from "./executor.js";
import { agentError, CLAUDE_DECLINED, ENDED_WITHOUT_RESULT } from "./failures.js";
import { buildSystemPrompt, buildTaskPrompt, FOLLOW_UP_PREFIX, humanMessage } from "./prompts.js";
import { isTaskEndTool, timeLimitReached, toolBudget, toolCallLimitExceeded, toolCallLimitReached, turnEndEvents } from "./turn-rules.js";
import {
  buildRequest,
  postMessages,
  type MessagesTransport,
  toolResultBlock,
  type ContentBlock,
  type MessageParam,
  type MessagesResponse,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./anthropic.js";

export const RETRY_DELAYS_MS = [1000, 3000, 9000];
/** Screenshots kept in the conversation; older ones are replaced by a note to save tokens. */
export const MAX_IMAGES_IN_HISTORY = 3;
export const KEY_REJECTED = "Claude API key rejected";
/** Result text for tool calls a stopped turn never ran, so the history stays valid for the next turn. */
export const NOT_RUN = "Not run: the turn was stopped before this tool ran.";

export interface ApiAgentInternals {
  /** Delays between retries of one request. Default 1 s, 3 s, 9 s. */
  retryDelaysMs?: number[];
  /** Used for retry backoff and by the tool executor. */
  sleep?: Sleep;
}

export function startApiAgent(opts: ApiAgentOptions): AgentSession {
  return startApiAgentWith(opts, {});
}

export function startApiAgentWith(opts: ApiAgentOptions, internals: ApiAgentInternals): AgentSession {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = internals.sleep ?? delay;
  const delays = internals.retryDelaysMs ?? RETRY_DELAYS_MS;
  const jevOn = opts.jev !== null;
  const label = opts.label ?? "Claude API";
  const transport: MessagesTransport = {
    url: opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, "")}/messages` : ANTHROPIC_MESSAGES_URL,
    auth: opts.auth ?? "x-api-key",
    label,
  };
  if (opts.headers) transport.headers = opts.headers;

  // Stream text as it is written: on by default for the Anthropic API; the hosted AI (bearer) answers whole messages.
  const streaming = opts.stream ?? transport.auth !== "bearer";
  // Live text goes out in ~50 ms batches; every other event first sends what is pending.
  const batcher = new DeltaBatcher((e) => {
    try {
      opts.onEvent(e);
    } catch {
      /* listeners must not break the loop */
    }
  });
  const emit = (e: AgentEvent) => batcher.emit(e);
  const streamText = streaming ? { onText: (messageId: string, index: number, text: string) => batcher.delta(`${messageId}:${index}`, text) } : undefined;

  /** The running turn's task_* result sink (the executor is shared by every turn). */
  let onTaskEnd: (r: TaskRunResult) => void = () => {};
  const executor = createToolExecutor({
    browser: opts.browser,
    jev: opts.jev,
    jevThreshold: opts.config.jevThreshold,
    onEvent: emit,
    onTaskEnd: (r) => onTaskEnd(r),
    mediaPaths: opts.mediaPaths,
    sleep,
  });

  const tools = toolsFor();
  const system = buildSystemPrompt({ tools, jev: jevOn });
  /** The whole conversation, across turns. */
  const messages: MessageParam[] = [];
  /** Results of the last assistant message's tool calls when its turn ended before they were sent. */
  let unsent: ContentBlock[] = [];
  let turnRunning = false;

  /** Keep only the newest MAX_IMAGES_IN_HISTORY images in tool results. */
  const pruneImages = () => {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const block of messages[i]!.content) {
        if (block.type !== "tool_result") continue;
        const tr = block as ToolResultBlock;
        tr.content = tr.content.map((c) => {
          if (c.type !== "image") return c;
          seen++;
          return seen > MAX_IMAGES_IN_HISTORY ? { type: "text" as const, text: "[older screenshot removed]" } : c;
        });
      }
    }
  };

  /**
   * Adds the next user text. The history must alternate and answer every
   * tool_use: after a turn that ended on a tool call, its results (or NOT_RUN
   * for the ones a stop skipped) go first in the same user message.
   */
  const addUserText = (text: string) => {
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const uses = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const answered = new Map(unsent.map((b) => [(b as ToolResultBlock).tool_use_id, b]));
      const results = uses.map((u) => answered.get(u.id) ?? toolResultBlock(u.id, { text: NOT_RUN, isError: true }));
      messages.push({ role: "user", content: [...results, { type: "text", text }] });
    } else if (last?.role === "user") {
      last.content.push({ type: "text", text });
    } else {
      messages.push({ role: "user", content: [{ type: "text", text }] });
    }
    unsent = [];
  };

  const runTurn = (config: RunConfig): AgentSession => {
    turnRunning = true;
    const controller = new AbortController();
    const pendingUser: string[] = [];
    let ended = false;
    let resolveDone!: (r: TaskRunResult) => void;
    const done = new Promise<TaskRunResult>((r) => (resolveDone = r));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let taskResult: TaskRunResult | null = null;
    onTaskEnd = (r) => {
      if (!taskResult) taskResult = r;
    };

    const finish = (r: TaskRunResult) => {
      if (ended) return;
      ended = true;
      turnRunning = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      // Messages typed while the turn was ending still reach Claude with the next turn.
      for (const t of pendingUser.splice(0)) addUserText(humanMessage(t));
      // Who picked this turn's elements (Jev, or Claude after Jev was unsure), then task_end.
      for (const e of turnEndEvents(r, jevOn ? executor.takePicks() : null)) emit(e);
      resolveDone(r);
    };

    const takeUserText = (): TextBlock[] => pendingUser.splice(0).map((t) => ({ type: "text" as const, text: humanMessage(t) }));

    /** One request with retries. null means the turn already ended. */
    const request = async (): Promise<MessagesResponse | null> => {
      const body = buildRequest({ model: opts.model, system, tools, messages, jev: jevOn });
      for (let attempt = 0; ; attempt++) {
        const r = await postMessages(doFetch, opts.apiKey, body, controller.signal, transport, streamText);
        batcher.flush();
        if (ended) return null;
        if (r.kind === "ok") return r.message;
        if (r.kind === "credit") {
          emit({ type: "error", text: r.reason });
          try {
            opts.onOutOfCredit?.(r.topupUrl ? { message: r.reason, topupUrl: r.topupUrl } : { message: r.reason });
          } catch {
            /* the listener must not break the loop */
          }
          finish({ outcome: "paused", reason: OUT_OF_CREDIT });
          return null;
        }
        if (r.kind === "auth") {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "failed", reason: transport.auth === "bearer" ? r.reason : KEY_REJECTED });
          return null;
        }
        if (r.kind === "error") {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "failed", reason: r.reason });
          return null;
        }
        if (attempt >= delays.length) {
          emit({ type: "error", text: r.reason });
          finish({ outcome: "retry", reason: `${r.reason}; gave up after ${attempt + 1} attempts` });
          return null;
        }
        const wait = delays[attempt]!;
        emit({ type: "status", text: `${r.reason}; retrying in ${Math.round(wait / 1000)} s` });
        await sleep(wait);
        if (ended) return null;
      }
    };

    const loop = async () => {
      const max = config.maxToolCalls;
      let toolCalls = 0;
      while (!ended) {
        const pending = takeUserText();
        if (pending.length) messages[messages.length - 1]!.content.push(...pending);
        pruneImages();
        const msg = await request();
        if (!msg || ended) return;
        const content = Array.isArray(msg.content) ? msg.content : [];
        messages.push({ role: "assistant", content });
        content.forEach((b, i) => {
          if (b.type === "text" && typeof (b as TextBlock).text === "string" && (b as TextBlock).text.trim()) {
            // The id of the streamed block this text completes (the chat swaps its live text for it).
            emit(streaming && msg.id ? { type: "assistant_text", text: (b as TextBlock).text, id: `${msg.id}:${i}` } : { type: "assistant_text", text: (b as TextBlock).text });
          }
        });
        const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (uses.length === 0) {
          if (pendingUser.length) {
            // The human said something while Claude was finishing; let Claude answer it.
            messages.push({ role: "user", content: takeUserText() });
            continue;
          }
          const why = msg.stop_reason === "refusal" ? CLAUDE_DECLINED : ENDED_WITHOUT_RESULT;
          finish({ outcome: "failed", reason: why });
          return;
        }

        const results: ContentBlock[] = [];
        // Shared so a turn that ends mid-way still answers what already ran.
        unsent = results;
        for (const use of uses) {
          if (ended) return;
          const name = use.name as ToolName;
          if (taskResult) {
            results.push(toolResultBlock(use.id, { text: "The task already ended. Stop now.", isError: true }));
            continue;
          }
          if (!tools.includes(name)) {
            const hint = name === "click" || name === "type" ? " Use act; a step can name the element index to run directly." : "";
            results.push(toolResultBlock(use.id, { text: `Tool ${use.name} is not available.${hint}`, isError: true }));
            continue;
          }
          const budget = isTaskEndTool(name) ? "run" : toolBudget(++toolCalls, max);
          if (budget === "stop") {
            finish({ outcome: "failed", reason: toolCallLimitExceeded(max) });
            return;
          }
          if (budget === "refuse") {
            results.push(toolResultBlock(use.id, { text: toolCallLimitReached(max), isError: true }));
            continue;
          }
          const r = await executor.call(name, use.input);
          // Recorded even when the turn was stopped meanwhile: it did run.
          results.push(toolResultBlock(use.id, r));
          if (ended) return;
        }
        if (taskResult) {
          finish(taskResult);
          return;
        }
        unsent = [];
        messages.push({ role: "user", content: results });
      }
    };

    timer = setTimeout(
      () => finish({ outcome: "failed", reason: timeLimitReached(config.maxTaskMinutes) }),
      Math.max(0, config.maxTaskMinutes * 60_000),
    );
    loop().catch((e) => {
      emit({ type: "error", text: `Agent loop error: ${errorMessage(e)}` });
      finish({ outcome: "failed", reason: agentError(errorMessage(e)) });
    });

    return {
      sessionId: opts.sessionId,
      done,
      sendUserMessage(text: string) {
        if (ended || !text.trim()) return;
        pendingUser.push(text);
        emit({ type: "user_message", text });
      },
      abort(reason: string, outcome: "paused" | "failed" | "retry" = "failed") {
        finish({ outcome, reason });
      },
      continueWith,
    };
  };

  /** The next user message once the current turn has ended: a new turn with the whole history. */
  function continueWith(text: string, next: { config?: RunConfig } = {}): AgentSession {
    if (turnRunning) throw new Error("busy");
    if (!text.trim()) throw new Error("empty message");
    emit({ type: "user_message", text });
    addUserText(`${FOLLOW_UP_PREFIX}${text}`);
    return runTurn(next.config ?? opts.config);
  }

  messages.push({ role: "user", content: [{ type: "text", text: buildTaskPrompt(opts.task, opts.mediaPaths, { isRetry: opts.config.isRetry }) }] });
  emit({ type: "status", text: `${label} (${opts.model})${jevOn ? " with Jev" : ""}` });
  return runTurn(opts.config);
}
