/**
 * Anthropic Messages API wire format and one-request transport over fetch.
 * https://docs.anthropic.com/en/api/messages, tool use and prompt caching.
 */
import { z } from "zod";
import { toolArgsSchema, toolDescription, type ToolName, type ToolResult } from "@browsertodo/shared";
import { errorMessage } from "./util.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MAX_TOKENS = 4096;

export type CacheControl = { type: "ephemeral" };
export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: (TextBlock | ImageBlock)[];
  is_error?: boolean;
}
/** Blocks we send or receive. Unknown response blocks (e.g. thinking) are passed back untouched. */
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export interface MessageParam {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system: TextBlock[];
  tools: AnthropicTool[];
  messages: MessageParam[];
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: Record<string, unknown>;
}

const schemaCache = new Map<string, Record<string, unknown>>();

/** JSON schema of a tool's input, from ToolArgs (ToolArgsJev with Jev on: other field descriptions). */
export function toolInputSchema(name: ToolName, jev = false): Record<string, unknown> {
  const key = `${name}:${jev}`;
  let s = schemaCache.get(key);
  if (!s) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(toolArgsSchema(name, jev), { io: "input" }) as Record<string, unknown>;
    s = rest;
    schemaCache.set(key, s);
  }
  return s;
}

/** Tool definitions in the given order; the last one carries the cache breakpoint. */
export function toolDefinitions(names: ToolName[], jev = false): AnthropicTool[] {
  return names.map((name, i) => {
    const t: AnthropicTool = { name, description: toolDescription(name, jev), input_schema: toolInputSchema(name, jev) };
    if (i === names.length - 1) t.cache_control = { type: "ephemeral" };
    return t;
  });
}

export function buildRequest(opts: { model: string; system: string; tools: ToolName[]; messages: MessageParam[]; jev?: boolean }): MessagesRequest {
  return {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: toolDefinitions(opts.tools, opts.jev === true),
    messages: opts.messages,
  };
}

export function toolResultBlock(toolUseId: string, r: ToolResult): ToolResultBlock {
  const content: (TextBlock | ImageBlock)[] = [];
  if (r.text) content.push({ type: "text", text: r.text });
  if (r.image) content.push({ type: "image", source: { type: "base64", media_type: r.image.mimeType, data: r.image.base64 } });
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  const block: ToolResultBlock = { type: "tool_result", tool_use_id: toolUseId, content };
  if (r.isError) block.is_error = true;
  return block;
}

export type PostResult =
  | { kind: "ok"; message: MessagesResponse }
  /** 402 from the browsertodo API: the account has no AI credit left. */
  | { kind: "credit"; reason: string; topupUrl?: string }
  /** 429, 529, 5xx, network: worth retrying. */
  | { kind: "transient"; reason: string }
  /** 401/403. */
  | { kind: "auth"; reason: string }
  | { kind: "error"; reason: string };

function apiErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string | { type?: string; message?: string }; message?: string };
    // The browsertodo API answers { error: "code or text", message? }.
    if (typeof j.error === "string") return j.message ? `${j.error}: ${j.message}` : j.error;
    if (j.error?.message) return `${j.error.type ? `${j.error.type}: ` : ""}${j.error.message}`;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

/**
 * Where Messages requests go and how they authenticate. Default: Anthropic
 * with x-api-key. The browsertodo hosted AI takes the same body at
 * `${apiBase}/v1/ai/messages` with the session token as a bearer.
 */
export interface MessagesTransport {
  /** Full URL of the Messages endpoint. Default ANTHROPIC_MESSAGES_URL. */
  url?: string;
  /** "x-api-key" (Anthropic, default) or "bearer" (Authorization: Bearer <key>). */
  auth?: "x-api-key" | "bearer";
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Name used in error reasons. Default "Claude API". */
  label?: string;
}

/** Reads { error, message, topupUrl } from a 402 body. */
function creditInfo(body: string): { message?: string; topupUrl?: string } {
  try {
    const j = JSON.parse(body) as { message?: unknown; topupUrl?: unknown };
    const out: { message?: string; topupUrl?: string } = {};
    if (typeof j.message === "string" && j.message) out.message = j.message;
    if (typeof j.topupUrl === "string" && j.topupUrl) out.topupUrl = j.topupUrl;
    return out;
  } catch {
    return {};
  }
}

export const OUT_OF_CREDIT = "Out of AI credit";

/** One POST /v1/messages. Never throws (an abort comes back as an error result). */
export async function postMessages(
  doFetch: typeof fetch,
  apiKey: string,
  body: MessagesRequest,
  signal?: AbortSignal,
  transport: MessagesTransport = {},
): Promise<PostResult> {
  const label = transport.label ?? "Claude API";
  let res: Response;
  try {
    const headers: Record<string, string> = { "content-type": "application/json", ...(transport.headers ?? {}) };
    if (transport.auth === "bearer") headers.authorization = `Bearer ${apiKey}`;
    else {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
    if (signal) init.signal = signal;
    res = await doFetch(transport.url ?? ANTHROPIC_MESSAGES_URL, init);
  } catch (e) {
    if (signal?.aborted) return { kind: "error", reason: "aborted" };
    return { kind: "transient", reason: `${label} network error: ${errorMessage(e)}` };
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { kind: "transient", reason: `${label} network error while reading the response: ${errorMessage(e)}` };
  }
  const s = res.status;
  if (res.ok) {
    try {
      return { kind: "ok", message: JSON.parse(text) as MessagesResponse };
    } catch {
      return { kind: "transient", reason: `${label} returned an unreadable response (HTTP ${s})` };
    }
  }
  if (s === 402) {
    const c = creditInfo(text);
    const r: PostResult = { kind: "credit", reason: c.message ? `${OUT_OF_CREDIT}: ${c.message}` : OUT_OF_CREDIT };
    if (c.topupUrl) r.topupUrl = c.topupUrl;
    return r;
  }
  const detail = apiErrorMessage(text);
  const rejected = transport.auth === "bearer" ? `${label} rejected the sign-in` : `${label} key rejected`;
  if (s === 401 || s === 403) return { kind: "auth", reason: `${rejected} (HTTP ${s}: ${detail})` };
  if (s === 429) return { kind: "transient", reason: `${label} rate limit (HTTP 429: ${detail})` };
  if (s === 529) return { kind: "transient", reason: `${label} overloaded (HTTP 529: ${detail})` };
  if (s >= 500) return { kind: "transient", reason: `${label} server error (HTTP ${s}: ${detail})` };
  return { kind: "error", reason: `${label} error (HTTP ${s}: ${detail})` };
}
