/**
 * Anthropic Messages API wire format and one-request transport over fetch.
 * https://docs.anthropic.com/en/api/messages, tool use and prompt caching.
 */
import { z } from "zod";
import { ToolArgs, TOOL_DESCRIPTIONS, type ToolName, type ToolResult } from "@browsertodo/shared";
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

const schemaCache = new Map<ToolName, Record<string, unknown>>();

/** JSON schema of a tool's input, from ToolArgs. */
export function toolInputSchema(name: ToolName): Record<string, unknown> {
  let s = schemaCache.get(name);
  if (!s) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(ToolArgs[name], { io: "input" }) as Record<string, unknown>;
    s = rest;
    schemaCache.set(name, s);
  }
  return s;
}

/** Tool definitions in the given order; the last one carries the cache breakpoint. */
export function toolDefinitions(names: ToolName[]): AnthropicTool[] {
  return names.map((name, i) => {
    const t: AnthropicTool = { name, description: TOOL_DESCRIPTIONS[name], input_schema: toolInputSchema(name) };
    if (i === names.length - 1) t.cache_control = { type: "ephemeral" };
    return t;
  });
}

export function buildRequest(opts: { model: string; system: string; tools: ToolName[]; messages: MessageParam[] }): MessagesRequest {
  return {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: toolDefinitions(opts.tools),
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
  /** 429, 529, 5xx, network: worth retrying. */
  | { kind: "transient"; reason: string }
  /** 401/403. */
  | { kind: "auth"; reason: string }
  | { kind: "error"; reason: string };

function apiErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
    if (j.error?.message) return `${j.error.type ? `${j.error.type}: ` : ""}${j.error.message}`;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

/** One POST /v1/messages. Never throws (an abort comes back as an error result). */
export async function postMessages(
  doFetch: typeof fetch,
  apiKey: string,
  body: MessagesRequest,
  signal?: AbortSignal,
): Promise<PostResult> {
  let res: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    res = await doFetch(ANTHROPIC_MESSAGES_URL, init);
  } catch (e) {
    if (signal?.aborted) return { kind: "error", reason: "aborted" };
    return { kind: "transient", reason: `Claude API network error: ${errorMessage(e)}` };
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { kind: "transient", reason: `Claude API network error while reading the response: ${errorMessage(e)}` };
  }
  const s = res.status;
  if (res.ok) {
    try {
      return { kind: "ok", message: JSON.parse(text) as MessagesResponse };
    } catch {
      return { kind: "transient", reason: `Claude API returned an unreadable response (HTTP ${s})` };
    }
  }
  const detail = apiErrorMessage(text);
  if (s === 401 || s === 403) return { kind: "auth", reason: `Claude API key rejected (HTTP ${s}: ${detail})` };
  if (s === 429) return { kind: "transient", reason: `Claude API rate limit (HTTP 429: ${detail})` };
  if (s === 529) return { kind: "transient", reason: `Claude API overloaded (HTTP 529: ${detail})` };
  if (s >= 500) return { kind: "transient", reason: `Claude API server error (HTTP ${s}: ${detail})` };
  return { kind: "error", reason: `Claude API error (HTTP ${s}: ${detail})` };
}
