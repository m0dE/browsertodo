/**
 * Where the background memory writer (episodes.ts) sends its one model call, chosen by the brain the conversation
 * ran on, so it is paid the same way as the conversation itself:
 *
 * - BrowserTODO AI: the account server's Messages proxy (`${apiBase}/v1/ai/messages`, the session token as a bearer,
 *   SESSION_HEADER naming the conversation), metered to the account's credit like every hosted call.
 * - Claude API: Anthropic's Messages API with the user's own key.
 * - Claude Code: the helper's memory.summarize (one headless `claude -p` on the user's own login).
 *
 * All run the writer's model (MEMORY_WRITER_MODEL, or Claude Code's alias for it). Other brains (the scripted
 * test brain) have no writer.
 */
import { postMessages, type MessagesRequest, type MessagesTransport } from "@browsertodo/core";
import {
  MEMORY_SUMMARIZE_TIMEOUT_MS,
  MEMORY_WRITER_MAX_TOKENS,
  MEMORY_WRITER_MODEL,
  SESSION_HEADER,
  type BrainKind,
  type ExtensionSettings,
  type HelperMethods,
} from "@browsertodo/shared";
import { HOSTED_LABEL } from "../engine/brain-resolver.js";

/** One writer call: the system prompt and the prompt, for the conversation `sessionId`. */
export type Summarize = (req: { system: string; prompt: string; sessionId: string }) => Promise<HelperMethods["memory.summarize"]["result"]>;

/** How much longer than the helper's own limit the extension waits for its answer (the helper reports the timeout). */
const HELPER_ANSWER_MARGIN_MS = 15_000;

export interface SummarizerDeps {
  settings(): Promise<Pick<ExtensionSettings, "anthropicApiKey">>;
  /** The signed-in account's session (null: signed out). */
  hosted(): { token: string; apiBase: string } | null;
  helper: {
    readonly connected: boolean;
    connect(): Promise<unknown>;
    call(method: "memory.summarize", params: HelperMethods["memory.summarize"]["params"], opts: { timeoutMs: number }): Promise<HelperMethods["memory.summarize"]["result"]>;
  };
  fetch?: typeof fetch;
}

/** The writer's call for conversations on this brain, or null when it has none. */
export function memorySummarizer(brain: BrainKind, deps: SummarizerDeps): Summarize | null {
  switch (brain) {
    case "browsertodo":
      return async ({ system, prompt, sessionId }) => {
        const s = deps.hosted();
        if (!s) throw new Error(`Not signed in: ${HOSTED_LABEL} cannot write memory`);
        const transport: MessagesTransport = { url: `${s.apiBase.replace(/\/+$/, "")}/v1/ai/messages`, auth: "bearer", headers: { [SESSION_HEADER]: sessionId }, label: HOSTED_LABEL };
        return messagesCall(deps, s.token, system, prompt, transport);
      };
    case "claude-api":
      return async ({ system, prompt }) => {
        const key = (await deps.settings()).anthropicApiKey.trim();
        if (!key) throw new Error("No Anthropic API key in Settings");
        return messagesCall(deps, key, system, prompt, {});
      };
    case "claude-code":
      return async ({ system, prompt }) => {
        if (!deps.helper.connected) await deps.helper.connect();
        return deps.helper.call("memory.summarize", { system, prompt }, { timeoutMs: MEMORY_SUMMARIZE_TIMEOUT_MS + HELPER_ANSWER_MARGIN_MS });
      };
    default:
      return null;
  }
}

async function messagesCall(deps: SummarizerDeps, key: string, system: string, prompt: string, transport: MessagesTransport): Promise<{ text: string }> {
  const body: MessagesRequest = {
    model: MEMORY_WRITER_MODEL,
    max_tokens: MEMORY_WRITER_MAX_TOKENS,
    system: [{ type: "text", text: system }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  };
  const signal = AbortSignal.timeout(MEMORY_SUMMARIZE_TIMEOUT_MS);
  const r = await postMessages(deps.fetch ?? fetch.bind(globalThis), key, body, signal, transport);
  if (r.kind !== "ok") throw new Error(r.reason);
  const text = r.message.content.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("");
  if (!text.trim()) throw new Error("The memory writer's answer was empty");
  return { text };
}
