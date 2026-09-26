import { describe, expect, it, vi } from "vitest";
import { REALTIME_CLOSE, REALTIME_PROTOCOL, REALTIME_TOKEN_PROTOCOL_PREFIX } from "@browsertodo/shared";
import { base64ToBytes } from "../../src/base64.js";
import { errorHelp } from "../../src/sidepanel/error-help.js";
import {
  NARRATOR_TOOLS,
  REALTIME_SAMPLE_RATE,
  RealtimeClient,
  realtimeFailure,
  realtimeUrl,
  type RealtimeHandlers,
  type RealtimeSocketLike,
} from "../../src/voice/realtime-client.js";

/** A WebSocket the test drives: what the client sent, and the server's side. */
class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // The server's side.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  types(): string[] {
    return this.sent.map((e) => String(e.type));
  }
}

function setup(handlers: RealtimeHandlers = {}) {
  let socket!: FakeSocket;
  const client = new RealtimeClient({
    url: "wss://api.example.com/v1/ai/realtime",
    token: "tok123",
    instructions: "Be brief.",
    open: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    handlers,
  });
  client.connect();
  return { client, socket: () => socket };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("realtimeUrl", () => {
  it("is the account server's REALTIME_PATH over wss (ws for a local http server)", () => {
    expect(realtimeUrl("https://app.browsertodo.com")).toBe("wss://app.browsertodo.com/v1/ai/realtime");
    expect(realtimeUrl("http://127.0.0.1:8787/", "s-1")).toBe("ws://127.0.0.1:8787/v1/ai/realtime?session=s-1");
  });
});

describe("RealtimeClient: connecting", () => {
  it("offers the browsertodo subprotocol with the session token, then configures the narrator", () => {
    const { socket } = setup();
    expect(socket().protocols).toEqual([REALTIME_PROTOCOL, `${REALTIME_TOKEN_PROTOCOL_PREFIX}tok123`]);
    socket().open();
    const [update] = socket().sent as [{ type: string; session: Record<string, any> }];
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("realtime");
    expect(update.session.instructions).toBe("Be brief.");
    expect(update.session.model).toBeUndefined(); // the server picks the model
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: REALTIME_SAMPLE_RATE });
    expect(update.session.audio.output.format).toEqual({ type: "audio/pcm", rate: REALTIME_SAMPLE_RATE });
    expect(update.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", create_response: true, interrupt_response: true });
    // Input transcription is billed on top of the price the server states: off.
    expect(update.session.audio.input.transcription).toBeUndefined();
    expect(update.session.tools.map((t: { name: string }) => t.name)).toEqual(["send_to_agent", "cancel_request", "stop_task", "end_voice"]);
    expect(update.session.tools.every((t: { type: string }) => t.type === "function")).toBe(true);
    expect(NARRATOR_TOOLS).toHaveLength(4);
  });

  it("speaks in the default voice at normal speed, or the voice and speed from Settings (kept in OpenAI's range)", () => {
    const { socket } = setup();
    socket().open();
    expect((socket().sent[0] as { session: Record<string, any> }).session.audio.output).toMatchObject({ voice: "marin", speed: 1 });
    for (const [speed, sent] of [[1.2, 1.2], [9, 1.5], [0.1, 0.25]] as const) {
      let s!: FakeSocket;
      new RealtimeClient({ url: "wss://x/v1/ai/realtime", token: "t", voice: "cedar", speed, open: (u, p) => (s = new FakeSocket(u, p)), handlers: {} }).connect();
      s.open();
      expect((s.sent[0] as { session: Record<string, any> }).session.audio.output).toMatchObject({ voice: "cedar", speed: sent });
    }
  });

  it("is ready on OpenAI's first event (session.created), once, and streams microphone PCM16 as base64 input_audio_buffer.append", () => {
    const onReady = vi.fn();
    const { client, socket } = setup({ onReady });
    socket().open();
    socket().event({ type: "session.created", session: { type: "realtime", model: "gpt-realtime-2.1" } });
    socket().event({ type: "session.updated", session: {} });
    expect(onReady).toHaveBeenCalledTimes(1);
    client.appendAudio(new Int16Array([1, -1, 256]));
    const append = socket().sent.at(-1)!;
    expect(append.type).toBe("input_audio_buffer.append");
    expect([...base64ToBytes(String(append.audio))]).toEqual([1, 0, 0xff, 0xff, 0, 1]);
  });

  it("sends nothing before the socket is open", () => {
    const { client, socket } = setup();
    client.appendAudio(new Int16Array([1]));
    client.note("Agent update: x", true);
    expect(socket().sent).toEqual([]);
  });
});

describe("RealtimeClient: the feed, the narrator's replies and its tools", () => {
  const ready = (handlers: RealtimeHandlers = {}) => {
    const s = setup(handlers);
    s.socket().open();
    s.socket().sent.length = 0;
    return s;
  };

  it("a note is a system message item; respond asks for a reply, but never while one is being made", () => {
    const { client, socket } = ready();
    client.note("Agent update (progress): Opening x.com.", true);
    expect(socket().sent).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "Agent update (progress): Opening x.com." }] } },
      { type: "response.create" },
    ]);
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.note("Agent update (progress): Typing.", true);
    client.note("Agent update: more", true);
    expect(socket().types()).toEqual(["conversation.item.create", "response.create", "conversation.item.create", "conversation.item.create"]);
    // One reply for both, once the current one is done.
    socket().event({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(socket().types().at(-1)).toBe("response.create");
    expect(socket().types().filter((t) => t === "response.create")).toHaveLength(2);
  });

  it("the user starting to talk drops a reply we were about to ask for (their turn gets one anyway)", () => {
    const onUserSpeech = vi.fn();
    const { client, socket } = ready({ onUserSpeech });
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.note("Agent update: x", true);
    socket().event({ type: "input_audio_buffer.speech_started", audio_start_ms: 100, item_id: "u1" });
    expect(onUserSpeech).toHaveBeenCalledTimes(1);
    socket().event({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
    expect(socket().types().filter((t) => t === "response.create")).toHaveLength(0);
  });

  it("passes the narrator's audio and its words on", () => {
    const onAudio = vi.fn();
    const onNarratorText = vi.fn();
    const { socket } = ready({ onAudio, onNarratorText });
    socket().event({ type: "response.output_audio.delta", delta: "AAEC", item_id: "a1", response_id: "r1", content_index: 0 });
    socket().event({ type: "response.output_audio_transcript.delta", delta: "On ", item_id: "a1" });
    socket().event({ type: "response.output_audio_transcript.delta", delta: "it.", item_id: "a1" });
    expect(onAudio).toHaveBeenCalledWith("AAEC", "a1");
    expect(onNarratorText.mock.calls.map((c) => c[0])).toEqual(["On ", "On it."]);
  });

  it("send_to_agent runs through onTool, its output goes back, and the narrator may then reply", async () => {
    const onTool = vi.fn(async () => "Sent to the agent.");
    const { socket } = ready({ onTool });
    socket().event({ type: "response.created", response: { id: "r1" } });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: '{"text":"Post gm on X"}', item_id: "f1" });
    await flush();
    expect(onTool).toHaveBeenCalledWith("send_to_agent", { text: "Post gm on X" });
    expect(socket().sent.at(-1)).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "Sent to the agent." } });
    socket().event({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(socket().types().at(-1)).toBe("response.create");
  });

  it("a tool that throws answers with its error; unknown tools and bad arguments are answered, not run", async () => {
    const onTool = vi.fn(async () => {
      throw new Error("No chat to stop");
    });
    const { socket } = ready({ onTool });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c1", name: "stop_task", arguments: "{}" });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c2", name: "rm_rf", arguments: "{}" });
    socket().event({ type: "response.function_call_arguments.done", call_id: "c3", name: "send_to_agent", arguments: "{not json" });
    await flush();
    const outputs = socket().sent.filter((e) => e.type === "conversation.item.create").map((e) => e.item as { call_id: string; output: string })
      .sort((a, b) => a.call_id.localeCompare(b.call_id));
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "c1", output: "Error: No chat to stop" },
      { type: "function_call_output", call_id: "c2", output: "Error: unknown tool rm_rf" },
      { type: "function_call_output", call_id: "c3", output: "Error: the arguments are not valid JSON" },
    ]);
    expect(onTool).toHaveBeenCalledTimes(1);
  });

  it("cancelling (the user's Esc, the shortcut) stops the reply being made; truncate says how much was heard", () => {
    const { client, socket } = ready();
    client.cancelResponse();
    expect(socket().sent).toEqual([]); // nothing to cancel
    socket().event({ type: "response.created", response: { id: "r1" } });
    client.cancelResponse();
    client.truncate("a1", 1234.6);
    expect(socket().sent).toEqual([{ type: "response.cancel" }, { type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 1235 }]);
  });
});

describe("RealtimeClient: how a session ends", () => {
  it("closing it ourselves ends without a failure", () => {
    const onClose = vi.fn();
    const { client, socket } = setup({ onClose });
    socket().open();
    client.close();
    expect(socket().closed?.code).toBe(1000);
    socket().serverClose(1000);
    expect(onClose).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the server's browsertodo.error names the failure the close then reports", () => {
    const onClose = vi.fn();
    const { socket } = setup({ onClose });
    socket().open();
    socket().event({ type: "browsertodo.error", error: "session_open", message: "Another realtime session is open" });
    socket().serverClose(REALTIME_CLOSE.concurrent, "session_open");
    expect(onClose.mock.calls[0]![0]).toMatchObject({ kind: "busy", fallback: true });
  });

  it("a 'denied' event is only logged (the session goes on); OpenAI's own error events too", () => {
    const log = vi.fn();
    const onClose = vi.fn();
    const { socket } = setup({ log, onClose });
    socket().open();
    socket().event({ type: "browsertodo.error", error: "denied", message: "session.tracing is not allowed" });
    socket().event({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "bad voice" } });
    expect(onClose).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0])).toEqual(["realtime denied: session.tracing is not allowed", "realtime error: invalid_value: bad voice"]);
  });

  it("a socket that never opened (no relay, no network) falls back to Standard", () => {
    const onClose = vi.fn();
    const { socket } = setup({ onClose });
    socket().onerror?.({});
    socket().serverClose(1006);
    expect(onClose.mock.calls[0]![0]).toMatchObject({ kind: "network", fallback: true });
  });
});

describe("realtimeFailure: close codes and server errors -> what the panel says and offers", () => {
  const fixes = (code: number) => errorHelp(realtimeFailure({ closeCode: code, opened: true }).message).fixes.map((f) => f.kind);

  it("auth, credit and plan end the session with the error card's fix (Log in, Top up, Choose a plan)", () => {
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.auth, opened: true })).toMatchObject({ kind: "auth", fallback: false });
    expect(fixes(REALTIME_CLOSE.auth)).toEqual(["login"]);
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.credit, opened: true })).toMatchObject({ kind: "credit", fallback: false });
    expect(fixes(REALTIME_CLOSE.credit)).toContain("topup");
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.plan, opened: true })).toMatchObject({ kind: "plan", fallback: false });
    expect(fixes(REALTIME_CLOSE.plan)).toEqual(["plans"]);
  });

  it("another session open, Realtime unavailable, upstream and protocol trouble fall back to Standard", () => {
    for (const code of [REALTIME_CLOSE.concurrent, REALTIME_CLOSE.unavailable, REALTIME_CLOSE.upstream, REALTIME_CLOSE.tooBig]) {
      const f = realtimeFailure({ closeCode: code, opened: true });
      expect(f.fallback, `close ${code}`).toBe(true);
      expect(f.message).toMatch(/Using Standard\.$/);
    }
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.concurrent, opened: true }).message).toBe("Realtime voice is open in another window. Using Standard.");
  });

  it("idle and the session limit end quietly with a note, without switching engines", () => {
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.idle, opened: true })).toMatchObject({ kind: "idle", fallback: false });
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.sessionLimit, opened: true })).toMatchObject({ kind: "limit", fallback: false });
    expect(realtimeFailure({ closeCode: REALTIME_CLOSE.sessionLimit, opened: true }).message).toBe("Hands-free stopped: a Realtime session lasts up to 30 minutes.");
  });

  it("the server's error code wins over the close code; an unknown close after opening falls back", () => {
    expect(realtimeFailure({ closeCode: 1011, error: "out_of_credit", opened: true }).kind).toBe("credit");
    expect(realtimeFailure({ closeCode: 1011, opened: true })).toMatchObject({ kind: "upstream", fallback: true });
    expect(realtimeFailure({ closeCode: 1006, opened: false })).toMatchObject({ kind: "network", fallback: true });
  });
});
