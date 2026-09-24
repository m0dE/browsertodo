/**
 * Claude API brain: the agent loop over the Anthropic Messages API, with the
 * shared tool executor. With Jev, act replaces click and type (steps can name
 * an exact element index to run directly), so a turn can do several steps.
 */
import { toolsFor, type AgentEvent, type TaskRunResult, type ToolName } from "@browsertodo/shared";
import type { AgentSession, ApiAgentOptions } from "./types.js";
import { createToolExecutor } from "./executor.js";
import { buildSystemPrompt, buildTaskPrompt } from "./prompts.js";
import {
  buildRequest,
  postMessages,
  toolResultBlock,
  type ContentBlock,
  type MessageParam,
  type MessagesResponse,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./anthropic.js";
import { defaultSleep, errorMessage } from "./util.js";

export const RETRY_DELAYS_MS = [1000, 3000, 9000];
/** Screenshots kept in the conversation; older ones are replaced by a note to save tokens. */
export const MAX_IMAGES_IN_HISTORY = 3;
export const KEY_REJECTED = "Claude API key rejected";
export const ENDED_WITHOUT_RESULT = "agent ended without reporting a result";

export interface ApiAgentInternals {
  /** Delays between retries of one request. Default 1 s, 3 s, 9 s. */
  retryDelaysMs?: number[];
  /** Used for retry backoff and by the tool executor. */
  sleep?: (ms: number) => Promise<void>;
}

const isTaskEnd = (n: string) => n === "task_complete" || n === "task_fail" || n === "task_pause";

export function startApiAgent(opts: ApiAgentOptions): AgentSession {
  return startApiAgentWith(opts, {});
}

export function startApiAgentWith(opts: ApiAgentOptions, internals: ApiAgentInternals): AgentSession {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = internals.sleep ?? defaultSleep;
  const delays = internals.retryDelaysMs ?? RETRY_DELAYS_MS;
  const jevOn = opts.jev !== null;
  const controller = new AbortController();
  const pendingUser: string[] = [];
  let ended = false;
  let resolveDone!: (r: TaskRunResult) => void;
  const done = new Promise<TaskRunResult>((r) => (resolveDone = r));

  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent(e);
    } catch {
      /* listeners must not break the loop */
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (r: TaskRunResult) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    controller.abort();
    const ev: AgentEvent = { type: "task_end", outcome: r.outcome };
    if (r.summary !== undefined) ev.summary = r.summary;
    if (r.url !== undefined) ev.url = r.url;
    if (r.reason !== undefined) ev.reason = r.reason;
    emit(ev);
    resolveDone(r);
  };

  let taskResult: TaskRunResult | null = null;
  const executor = createToolExecutor({
    browser: opts.browser,
    jev: opts.jev,
    jevThreshold: opts.config.jevThreshold,
    onEvent: emit,
    onTaskEnd: (r) => {
      if (!taskResult) taskResult = r;
    },
    mediaPaths: opts.mediaPaths,
    sleep,
  });

  /** With Jev, act (which can also target an exact index) replaces click and type. */
  const tools = toolsFor({ jev: jevOn });
  const currentTools = (): ToolName[] => tools;

  const system = buildSystemPrompt({ tools, jev: jevOn });
  const messages: MessageParam[] = [
    { role: "user", content: [{ type: "text", text: buildTaskPrompt(opts.task, opts.mediaPaths, { isRetry: opts.config.isRetry }) }] },
  ];

  const takeUserText = (): TextBlock[] =>
    pendingUser.splice(0).map((t) => ({ type: "text" as const, text: `Message from the human (they are watching this run): ${t}` }));

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

  /** One request with retries. null means the run already ended. */
  const request = async (): Promise<MessagesResponse | null> => {
    const body = buildRequest({ model: opts.model, system, tools: currentTools(), messages });
    for (let attempt = 0; ; attempt++) {
      const r = await postMessages(doFetch, opts.apiKey, body, controller.signal);
      if (ended) return null;
      if (r.kind === "ok") return r.message;
      if (r.kind === "auth") {
        emit({ type: "error", text: r.reason });
        finish({ outcome: "failed", reason: KEY_REJECTED });
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
    const max = opts.config.maxToolCalls;
    let toolCalls = 0;
    while (!ended) {
      const pending = takeUserText();
      if (pending.length) messages[messages.length - 1]!.content.push(...pending);
      pruneImages();
      const msg = await request();
      if (!msg || ended) return;
      const content = Array.isArray(msg.content) ? msg.content : [];
      messages.push({ role: "assistant", content });
      for (const b of content) {
        if (b.type === "text" && typeof (b as TextBlock).text === "string" && (b as TextBlock).text.trim()) {
          emit({ type: "assistant_text", text: (b as TextBlock).text });
        }
      }
      const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        if (pendingUser.length) {
          // The human said something while Claude was finishing; let Claude answer it.
          messages.push({ role: "user", content: takeUserText() });
          continue;
        }
        const why = msg.stop_reason === "refusal" ? "Claude declined the task" : ENDED_WITHOUT_RESULT;
        finish({ outcome: "failed", reason: why });
        return;
      }

      const results: ContentBlock[] = [];
      for (const use of uses) {
        if (ended) return;
        const name = use.name as ToolName;
        if (taskResult) {
          results.push(toolResultBlock(use.id, { text: "The task already ended. Stop now.", isError: true }));
          continue;
        }
        if (!currentTools().includes(name)) {
          const hint = name === "click" || name === "type" ? " Use act; a step can name the element index to run directly." : "";
          results.push(toolResultBlock(use.id, { text: `Tool ${use.name} is not available.${hint}`, isError: true }));
          continue;
        }
        if (!isTaskEnd(name)) {
          toolCalls++;
          if (toolCalls >= max + 5) {
            finish({ outcome: "failed", reason: `tool call limit exceeded (${max} calls)` });
            return;
          }
          if (toolCalls > max) {
            results.push(toolResultBlock(use.id, { text: `Tool call limit of ${max} reached. Call task_fail now with a short reason.`, isError: true }));
            continue;
          }
        }
        const r = await executor.call(name, use.input);
        if (ended) return;
        results.push(toolResultBlock(use.id, r));
      }
      if (taskResult) {
        finish(taskResult);
        return;
      }
      messages.push({ role: "user", content: results });
    }
  };

  timer = setTimeout(
    () => finish({ outcome: "failed", reason: `task time limit of ${opts.config.maxTaskMinutes} minutes reached` }),
    Math.max(0, opts.config.maxTaskMinutes * 60_000),
  );
  emit({ type: "status", text: `Claude API (${opts.model})${jevOn ? " with Jev" : ""}` });
  loop().catch((e) => {
    emit({ type: "error", text: `agent loop error: ${errorMessage(e)}` });
    finish({ outcome: "failed", reason: `agent error: ${errorMessage(e)}` });
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
  };
}
