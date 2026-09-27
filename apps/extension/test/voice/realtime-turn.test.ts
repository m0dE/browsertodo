/**
 * A Realtime hands-free turn, end to end in the extension: the narrator's send_to_agent reaches the chat at once
 * (no sending window, nothing written into the box), the narrator acknowledges at most once, the user's own words
 * (the input transcription) are kept with the request sent for them whatever order they arrive in, and stopping
 * while the engine starts leaves nothing open.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, VoiceEngineId, VoiceEnginesResponse } from "@browsertodo/shared";
import { initHandsFree, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { VoiceTip } from "../../src/sidepanel/voice-input.js";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents, HandsFreeEngine } from "../../src/voice/engine.js";
import { HANDS_FREE } from "../../src/voice/hands-free.js";
import { ACKNOWLEDGE_INSTRUCTIONS, NARRATOR_INSTRUCTIONS, RealtimeClient, type RealtimeHandlers, type RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import { RealtimeTurns } from "../../src/voice/realtime-turns.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
  replies(): Record<string, any>[] {
    return this.sent.filter((e) => e.type === "response.create");
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The server's side of one user turn: their audio committed (item `input`), then the reply to it begins. */
function userTurn(socket: FakeSocket, input: string, reply: string): void {
  socket.event({ type: "input_audio_buffer.speech_started", item_id: input });
  socket.event({ type: "input_audio_buffer.speech_stopped", item_id: input });
  socket.event({ type: "input_audio_buffer.committed", item_id: input, previous_item_id: null });
  socket.event({ type: "response.created", response: { id: reply } });
}

const callSend = (socket: FakeSocket, text: string, callId = "c1") =>
  socket.event({ type: "response.function_call_arguments.done", call_id: callId, name: "send_to_agent", arguments: JSON.stringify({ text }) });
const transcribed = (socket: FakeSocket, input: string, transcript: string) =>
  socket.event({ type: "conversation.item.input_audio_transcription.completed", item_id: input, content_index: 0, transcript });
const replyDone = (socket: FakeSocket, reply: string) => socket.event({ type: "response.done", response: { id: reply, status: "completed", output: [] } });

describe("the narrator: tool first, at most one acknowledgement", () => {
  function client(handlers: RealtimeHandlers = {}) {
    let socket!: FakeSocket;
    const c = new RealtimeClient({ url: "wss://x/v1/ai/realtime", token: "t", open: () => (socket = new FakeSocket()), handlers });
    c.connect();
    socket.open();
    return { c, socket };
  }

  it("is told to call send_to_agent before saying anything, and to acknowledge at most once after", () => {
    expect(NARRATOR_INSTRUCTIONS).toContain("When the user asks for something, call send_to_agent immediately, before saying anything. After it returns, say at most one short acknowledgement.");
    const { socket } = client();
    expect(socket.sent[0]!.session.audio.input.transcription).toEqual({ model: "gpt-transcribe" });
  });

  it("a reply that only called send_to_agent is followed by exactly one short acknowledgement", async () => {
    const { socket } = client({ onTool: () => "Sent to the agent. Its updates will follow." });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    await flush();
    // Still replying: nothing yet (a second reply would be refused while one is being made).
    expect(socket.replies()).toEqual([]);
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([{ type: "response.create", response: { instructions: ACKNOWLEDGE_INSTRUCTIONS } }]);
    // The acknowledgement itself asks for nothing more.
    socket.event({ type: "response.created", response: { id: "r2" } });
    socket.event({ type: "response.output_audio.delta", item_id: "a2", delta: "AAAA" });
    replyDone(socket, "r2");
    expect(socket.replies()).toHaveLength(1);
  });

  it("the tool's output arriving after its reply is done still gets one acknowledgement", async () => {
    let answer!: (s: string) => void;
    const { socket } = client({ onTool: () => new Promise<string>((r) => (answer = r)) });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    replyDone(socket, "r1");
    answer("Sent to the agent.");
    await flush();
    expect(socket.replies()).toEqual([{ type: "response.create", response: { instructions: ACKNOWLEDGE_INSTRUCTIONS } }]);
  });

  it("a reply that already spoke gets no acknowledgement", async () => {
    const { socket } = client({ onTool: () => "Sent to the agent." });
    userTurn(socket, "in1", "r1");
    socket.event({ type: "response.output_audio.delta", item_id: "a1", delta: "AAAA" });
    callSend(socket, "Open Gmail");
    await flush();
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([]);
  });

  it("an agent update asking for a reply meanwhile makes the one reply (no acknowledgement on top)", async () => {
    const { c, socket } = client({ onTool: () => "Sent to the agent." });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    await flush();
    c.note("Agent update (problem): the page did not load.", true);
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([{ type: "response.create" }]);
  });

  it("the user talking again drops the acknowledgement (their turn gets its own reply)", async () => {
    const { socket } = client({ onTool: () => "Sent to the agent." });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    await flush();
    socket.event({ type: "input_audio_buffer.speech_started", item_id: "in2" });
    replyDone(socket, "r1");
    expect(socket.replies()).toEqual([]);
  });

  it("names the user's input item: with the tool call, with their words, and when its reply is done", async () => {
    const onTool = vi.fn(() => "ok");
    const onUserWords = vi.fn();
    const onTurnDone = vi.fn();
    const { socket } = client({ onTool, onUserWords, onTurnDone });
    userTurn(socket, "in1", "r1");
    callSend(socket, "Open Gmail");
    transcribed(socket, "in1", " um, open my gmail ");
    replyDone(socket, "r1");
    socket.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "in2", error: { message: "x" } });
    await flush();
    expect(onTool).toHaveBeenCalledWith("send_to_agent", { text: "Open Gmail" }, "in1");
    expect(onUserWords.mock.calls).toEqual([
      ["in1", "um, open my gmail"],
      ["in2", ""],
    ]);
    expect(onTurnDone.mock.calls).toEqual([["in1"]]);
    // A reply we asked for (the acknowledgement) answers no input item.
    socket.event({ type: "response.created", response: { id: "r2" } });
    callSend(socket, "And archive it", "c2");
    replyDone(socket, "r2");
    await flush();
    expect(onTool).toHaveBeenLastCalledWith("send_to_agent", { text: "And archive it" }, null);
    expect(onTurnDone).toHaveBeenCalledTimes(1);
  });
});

describe("RealtimeTurns: the user's words with the request sent for them, in either order", () => {
  const turns = () => {
    const out: [string, string | null][] = [];
    return { out, t: new RealtimeTurns((w, s) => void out.push([w, s])) };
  };

  it("the request first, then the words; or the words first, then the request", () => {
    const a = turns();
    a.t.sent("in1", "Open Gmail");
    expect(a.out).toEqual([]);
    a.t.words("in1", "could you open gmail");
    a.t.replied("in1");
    expect(a.out).toEqual([["could you open gmail", "Open Gmail"]]);
    const b = turns();
    b.t.words("in1", "could you open gmail");
    expect(b.out).toEqual([]);
    b.t.sent("in1", "Open Gmail");
    expect(b.out).toEqual([["could you open gmail", "Open Gmail"]]);
  });

  it("a turn without a request is known once its reply is done, before or after the words", () => {
    const a = turns();
    a.t.words("in1", "what is it doing?");
    a.t.replied("in1");
    const b = turns();
    b.t.replied("in1");
    b.t.words("in1", "what is it doing?");
    expect(a.out).toEqual([["what is it doing?", null]]);
    expect(b.out).toEqual([["what is it doing?", null]]);
  });

  it("turns do not mix; words that could not be transcribed, and late events of a settled turn, give nothing", () => {
    const { out, t } = turns();
    t.sent("in2", "Archive it");
    t.words("in1", "hello");
    t.replied("in1");
    t.words("in2", "and archive it");
    t.words("in3", "");
    t.replied("in3");
    t.sent("in2", "late");
    t.replied("in2");
    t.sent(null, "not for a turn");
    expect(out).toEqual([
      ["hello", null],
      ["and archive it", "Archive it"],
    ]);
  });
});

class FakeMic implements AudioSource {
  started = false;
  stopped = false;
  async start(): Promise<void> {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function engineEvents(log: string[]): EngineEvents {
  return {
    speech: () => void log.push("speech"),
    heard: (t, f) => void log.push(`heard:${t}:${f}`),
    partial: (t) => void log.push(`partial:${t}`),
    level: () => {},
    narrating: () => {},
    said: () => {},
    narratorText: () => {},
    forward: (t) => void log.push(`forward:${t}`),
    userWords: (w, s) => void log.push(`words:${w}|${s}`),
    stopTask: async () => (log.push("stopTask"), "Stopped the task."),
    endVoice: () => {},
    failed: (f) => void log.push(`failed:${(f as { kind: string }).kind}`),
  };
}

describe("RealtimeEngine: a turn, and stopping while it starts", () => {
  function engine(ticket: () => Promise<{ url: string; token: string }> = async () => ({ url: "wss://x", token: "t" })) {
    const log: string[] = [];
    const sockets: FakeSocket[] = [];
    const mic = new FakeMic();
    const player = { play: vi.fn(), stop: vi.fn(() => null), close: vi.fn(), playing: false };
    const e = new RealtimeEngine({ ticket, createSource: () => mic, events: engineEvents(log), openSocket: () => (sockets.push(new FakeSocket()), sockets.at(-1)!), player });
    return { e, log, sockets, mic };
  }

  it("send_to_agent goes to the panel at once; the user's words follow with it, whichever came first", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    const socket = t.sockets[0]!;
    socket.open();
    socket.event({ type: "session.created", session: {} });
    await start;
    userTurn(socket, "in1", "r1");
    transcribed(socket, "in1", "could you check what Sarah wrote me");
    expect(t.log).toEqual(["speech"]);
    callSend(socket, "Open Gmail and read the newest email from Sarah");
    await flush();
    expect(t.log).toEqual(["speech", "forward:Open Gmail and read the newest email from Sarah", "words:could you check what Sarah wrote me|Open Gmail and read the newest email from Sarah"]);
    expect(socket.sent.find((x) => x.item?.type === "function_call_output")!.item.output).toBe("Sent to the agent. Its updates will follow.");
    // A turn with no request: its words once its reply is done.
    userTurn(socket, "in2", "r2");
    replyDone(socket, "r2");
    transcribed(socket, "in2", "thanks");
    expect(t.log.at(-1)).toBe("words:thanks|null");
  });

  it("cancel_request stops the task: the request already went out", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    t.sockets[0]!.open();
    t.sockets[0]!.event({ type: "session.created", session: {} });
    await start;
    t.sockets[0]!.event({ type: "response.function_call_arguments.done", call_id: "c9", name: "cancel_request", arguments: "{}" });
    await flush();
    expect(t.log).toEqual(["stopTask"]);
  });

  it("stopped while the ticket is fetched: no connection, no microphone", async () => {
    let give!: (v: { url: string; token: string }) => void;
    const t = engine(() => new Promise((r) => (give = r)));
    const start = t.e.start();
    t.e.stop();
    give({ url: "wss://x", token: "t" });
    await start;
    expect(t.sockets).toHaveLength(0);
    expect(t.mic.started).toBe(false);
  });

  it("stopped while connecting: the start ends, the socket is closed, the microphone never opens", async () => {
    const t = engine();
    const start = t.e.start();
    await flush();
    const socket = t.sockets[0]!;
    socket.open();
    t.e.stop();
    await start;
    expect(socket.readyState).toBe(3);
    expect(t.mic.started).toBe(false);
    // The server's late "ready" changes nothing.
    socket.event({ type: "session.created", session: {} });
    expect(t.mic.started).toBe(false);
    expect(t.log).toEqual([]);
  });
});

/** An engine the panel drives; `hold`: its start waits until it is stopped (or opened). */
class FakeEngine implements HandsFreeEngine {
  readonly halfDuplex: boolean;
  ticks = 0;
  stopped = false;
  private release!: () => void;
  private readonly ready = new Promise<void>((r) => (this.release = r));
  constructor(
    readonly id: VoiceEngineId,
    readonly events: EngineEvents,
    private readonly hold: boolean,
  ) {
    this.halfDuplex = id === "standard";
  }
  start(): Promise<void> {
    if (!this.hold) this.release();
    return this.ready;
  }
  stop(): void {
    this.stopped = true;
    this.release();
  }
  speak(): void {}
  hush(): void {}
  setTranscribing(): void {}
  agentEvent(): void {}
  tick(): void {
    this.ticks++;
  }
}

const ENGINES: VoiceEnginesResponse = {
  default: "realtime",
  engines: [
    { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6.0762, assumption: "", available: true },
    { id: "standard", name: "Standard", model: "whisper-large-v3-turbo", approxCentsPerMinute: 0.0667, assumption: "", available: true },
  ],
};

describe("the side panel's hands-free session on Realtime", () => {
  beforeAll(installMiniDom);

  function panel(opts: { costNoticed?: boolean; holdRealtime?: boolean } = {}) {
    const engines: FakeEngine[] = [];
    const tips: (VoiceTip & { key?: string })[] = [];
    const box = { draft: vi.fn(() => "half-typed note"), setDraft: vi.fn() };
    let finishSend!: (id: string) => void;
    const deps: HandsFreeDeps = {
      voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: () => {}, setLevel: () => {}, showTip: () => {}, ensureMic: async () => true },
      composer: box,
      notify: (tip) => void tips.push(tip),
      activeTab: () => 1,
      chatOf: () => null,
      tabsOf: () => [],
      send: vi.fn(() => new Promise<string>((r) => (finishSend = r))),
      tabTitle: async () => "Inbox",
      goToTab: () => {},
      onSpeaking: () => {},
      keepSpoken: vi.fn(),
      keepHeard: vi.fn(),
      settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: opts.costNoticed ?? true }) as ExtensionSettings,
      account: () => undefined,
      engines: async () => ENGINES,
      saveSettings: async () => {},
      createEngine: (id, events) => {
        const e = new FakeEngine(id, events, id === "realtime" && !!opts.holdRealtime);
        engines.push(e);
        return e;
      },
      stopTask: async () => "Stopped the task.",
      openBilling: () => {},
      signIn: () => {},
      onActive: () => {},
      host: new MiniElement("div") as unknown as HTMLElement,
    };
    const hf = initHandsFree(deps);
    return { hf, deps, engines, tips, box, finish: (id: string) => finishSend(id) };
  }

  it("a request goes to the chat at once, the box untouched; the user's words are kept with it in the chat it started", async () => {
    vi.useFakeTimers();
    try {
      const t = panel();
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      const rt = t.engines[0]!;
      expect(rt.id).toBe("realtime");
      expect(t.hf.phase).toBe("listening");
      rt.events.forward("Open Gmail and read the newest email from Sarah");
      // No sending window: out before any tick.
      expect(t.deps.send).toHaveBeenCalledWith("Open Gmail and read the newest email from Sarah", { tabId: 1, sessionId: null });
      expect(t.hf.phase).toBe("listening");
      rt.events.userWords("could you check what Sarah wrote me", "Open Gmail and read the newest email from Sarah");
      await vi.advanceTimersByTimeAsync(0);
      // The words wait for the chat their request is starting.
      expect(t.deps.keepHeard).not.toHaveBeenCalled();
      t.finish("s-new");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.deps.keepHeard).toHaveBeenCalledWith("s-new", "could you check what Sarah wrote me", "Open Gmail and read the newest email from Sarah");
      // Words with no request go to the session's chat.
      rt.events.userWords("thanks", null);
      await vi.advanceTimersByTimeAsync(HANDS_FREE.sendDelayMs * 2);
      expect(t.deps.keepHeard).toHaveBeenLastCalledWith("s-new", "thanks", null);
      expect(t.deps.send).toHaveBeenCalledTimes(1);
      expect(t.box.setDraft).not.toHaveBeenCalled();
      t.hf.toggle("button");
      expect(rt.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an engine replaced while it started (the cost notice's Use Standard) gets the clock: the session goes on", async () => {
    vi.useFakeTimers();
    try {
      const t = panel({ costNoticed: false, holdRealtime: true });
      t.hf.toggle("shortcut");
      await vi.advanceTimersByTimeAsync(0);
      const notice = t.tips.find((x) => x.action?.label === "Use Standard")!;
      notice.action!.run();
      await vi.advanceTimersByTimeAsync(HANDS_FREE.tickMs * 3);
      const [rt, std] = t.engines;
      expect(rt!.stopped).toBe(true);
      expect(std!.id).toBe("standard");
      expect(t.hf.phase).toBe("listening");
      expect(std!.ticks).toBeGreaterThanOrEqual(3);
      t.hf.toggle("shortcut");
      expect(t.hf.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopped while the engine starts: nothing runs on", async () => {
    vi.useFakeTimers();
    try {
      const t = panel({ holdRealtime: true });
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(0);
      t.hf.toggle("button");
      await vi.advanceTimersByTimeAsync(HANDS_FREE.tickMs * 3);
      expect(t.engines[0]!.stopped).toBe(true);
      expect(t.engines[0]!.ticks).toBe(0);
      expect(t.hf.active).toBe(false);
      expect(t.hf.phase).toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });
});
