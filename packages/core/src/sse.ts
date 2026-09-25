/**
 * Streaming Messages responses (stream: true) over plain fetch: a
 * server-sent events reader and the accumulator that rebuilds the final
 * message from the stream's events.
 * https://docs.anthropic.com/en/api/messages-streaming
 */
import type { ContentBlock, MessagesResponse } from "./anthropic.js";

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits an SSE byte stream into events (event: / data: fields, blank line ends one). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const line = function* (l: string): Generator<SseEvent> {
    if (l === "") {
      if (data.length || event) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A lone \r at the end may be the first half of \r\n: wait for more.
      let m: RegExpExecArray | null;
      const re = /\r\n|\n|\r(?!$)/g;
      let start = 0;
      while ((m = re.exec(buf))) {
        yield* line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
      if (done) {
        if (buf.endsWith("\r")) buf = buf.slice(0, -1);
        if (buf) yield* line(buf);
        yield* line("");
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** An `error` event in the stream, or a stream that makes no sense. */
export class StreamError extends Error {
  constructor(
    message: string,
    /** The API's error type, e.g. overloaded_error. */
    readonly errorType: string,
  ) {
    super(message);
  }
}

/**
 * Rebuilds a MessagesResponse from stream events. Text deltas are passed to
 * onText as they come; tool_use input is the joined input_json_delta parts,
 * parsed when the block stops; thinking text and signatures are kept so the
 * block can be sent back.
 */
export class MessageAccumulator {
  private msg: MessagesResponse | null = null;
  private json = new Map<number, string>();
  private stopped = false;

  constructor(private readonly onText?: (messageId: string, index: number, text: string) => void) {}

  /** True once message_stop came. */
  get done(): boolean {
    return this.stopped;
  }

  /** The message so far (complete once done). */
  get message(): MessagesResponse | null {
    return this.msg;
  }

  apply(ev: SseEvent): void {
    if (ev.event === "ping") return;
    let d: any;
    try {
      d = JSON.parse(ev.data);
    } catch {
      throw new StreamError(`unreadable stream event (${ev.event})`, "stream_error");
    }
    const type = typeof d?.type === "string" ? d.type : ev.event;
    if (type === "error") {
      const e = d?.error ?? {};
      throw new StreamError(`${e.type ? `${e.type}: ` : ""}${e.message ?? "stream error"}`, typeof e.type === "string" ? e.type : "error");
    }
    if (type === "message_start") {
      const m = d.message ?? {};
      this.msg = { ...m, content: Array.isArray(m.content) ? [...m.content] : [] } as MessagesResponse;
      return;
    }
    const msg = this.msg;
    if (!msg) {
      if (type === "message_stop") this.stopped = true;
      return;
    }
    switch (type) {
      case "content_block_start": {
        const block = { ...(d.content_block ?? {}) } as ContentBlock & Record<string, unknown>;
        if (block.type === "tool_use") this.json.set(d.index, "");
        msg.content[d.index] = block;
        if (block.type === "text" && typeof block.text === "string" && block.text) this.onText?.(msg.id, d.index, block.text);
        return;
      }
      case "content_block_delta": {
        const block = msg.content[d.index] as (ContentBlock & Record<string, any>) | undefined;
        const delta = d.delta ?? {};
        if (!block) return;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = String(block.text ?? "") + delta.text;
          if (delta.text) this.onText?.(msg.id, d.index, delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          this.json.set(d.index, (this.json.get(d.index) ?? "") + delta.partial_json);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = String(block.thinking ?? "") + delta.thinking;
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = delta.signature;
        } else if (delta.type === "citations_delta" && delta.citation) {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        }
        return;
      }
      case "content_block_stop": {
        const block = msg.content[d.index] as (ContentBlock & Record<string, any>) | undefined;
        const raw = this.json.get(d.index);
        if (block && raw !== undefined) {
          this.json.delete(d.index);
          try {
            block.input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            throw new StreamError(`unreadable tool input for ${String(block.name)}`, "stream_error");
          }
        }
        return;
      }
      case "message_delta": {
        if (d.delta && "stop_reason" in d.delta) msg.stop_reason = d.delta.stop_reason ?? null;
        if (d.usage && typeof d.usage === "object") msg.usage = { ...(msg.usage ?? {}), ...d.usage };
        return;
      }
      case "message_stop":
        this.stopped = true;
        return;
      default:
        return;
    }
  }
}
