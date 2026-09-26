import { describe, expect, it, vi } from "vitest";
import { REALTIME_CLOSE } from "@browsertodo/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";

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
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

class FakeMic implements AudioSource {
  deliver: ((s: Float32Array) => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.deliver = onSamples;
  }
  stop(): void {
    this.deliver = null;
  }
}

function setup() {
  const socket = new FakeSocket();
  const mic = new FakeMic();
  const log: string[] = [];
  const events: EngineEvents = {
    speech: () => void log.push("speech"),
    heard: (t, f) => void log.push(`heard:${t}:${f}`),
    partial: (t) => void log.push(`partial:${t}`),
    level: () => {},
    narrating: () => void log.push("narrating"),
    said: () => void log.push("said"),
    narratorText: (t) => void log.push(`narrator:${t}`),
    forward: (t) => void log.push(`forward:${t}`),
    cancelRequest: () => (log.push("cancel"), true),
    stopTask: async () => "Stopped the task.",
    endVoice: () => void log.push("end"),
    failed: (f) => void log.push(`failed:${(f as { kind: string }).kind}`),
  };
  const player = { play: vi.fn(), stop: vi.fn(() => ({ itemId: "a1", playedMs: 800 })), close: vi.fn(), playing: false };
  const engine = new RealtimeEngine({
    ticket: async () => ({ url: "wss://api.test/v1/ai/realtime", token: "tok" }),
    createSource: () => mic,
    events,
    openSocket: () => socket,
    player,
  });
  return { socket, mic, log, engine, player };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const t = setup();
  const start = t.engine.start();
  await settle();
  t.socket.readyState = 1;
  t.socket.onopen?.({});
  t.socket.event({ type: "session.created", session: { type: "realtime" } });
  await start;
  return t;
}

describe("RealtimeEngine", () => {
  it("starts once the narrator's session is configured, then streams the microphone in ~100 ms PCM16 chunks", async () => {
    const t = await started();
    expect(t.socket.sent[0]!.type).toBe("session.update");
    for (let i = 0; i < 5; i++) t.mic.deliver!(new Float32Array(512).fill(0.1));
    expect(t.socket.sent.filter((e) => e.type === "input_audio_buffer.append")).toHaveLength(1);
  });

  it("a refusal before the start rejects it with the failure (the panel falls back to Standard)", async () => {
    const t = setup();
    const start = t.engine.start();
    await settle();
    t.socket.readyState = 1;
    t.socket.onopen?.({});
    t.socket.event({ type: "browsertodo.error", error: "realtime_unavailable", message: "Realtime voice is not set up on this server yet" });
    t.socket.readyState = 3;
    t.socket.onclose?.({ code: REALTIME_CLOSE.unavailable, reason: "" });
    await expect(start).rejects.toMatchObject({ kind: "unavailable", fallback: true });
  });

  it("send_to_agent forwards the request to the panel (which sends it as a chat message) and answers the narrator", async () => {
    const t = await started();
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Post gm on X" }) });
    await settle();
    expect(t.log).toContain("forward:Post gm on X");
    expect(t.socket.sent.find((e) => e.type === "conversation.item.create" && e.item.type === "function_call_output")!.item.output).toMatch(/^Sent to the agent/);
  });

  it("stop_task and end_voice reach the panel", async () => {
    const t = await started();
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "stop_task", arguments: "{}" });
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c2", name: "end_voice", arguments: "{}" });
    await settle();
    await settle();
    const outputs = t.socket.sent.filter((e) => e.item?.type === "function_call_output").map((e) => e.item.output);
    expect(outputs).toContain("Stopped the task.");
    expect(t.log).toContain("end");
  });

  it("the user speaking cuts the narrator's audio off and trims what it remembers to what was heard", async () => {
    const t = await started();
    t.socket.event({ type: "response.output_audio.delta", delta: "AAAA", item_id: "a1" });
    expect(t.player.play).toHaveBeenCalledWith("AAAA", "a1");
    t.socket.event({ type: "input_audio_buffer.speech_started", audio_start_ms: 10, item_id: "u1" });
    expect(t.player.stop).toHaveBeenCalled();
    expect(t.socket.sent.at(-1)).toEqual({ type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 800 });
    expect(t.log).toContain("speech");
  });

  it("cancel_request takes back a request still waiting to be sent", async () => {
    const t = await started();
    t.socket.event({ type: "response.function_call_arguments.done", call_id: "c1", name: "cancel_request", arguments: "{}" });
    await settle();
    expect(t.log).toContain("cancel");
    expect(t.socket.sent.find((e) => e.item?.type === "function_call_output")!.item.output).toBe("Cancelled: the agent did not get it.");
  });

  it("the chat's events become notes for the narrator", async () => {
    const t = await started();
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Posted it." }, 0);
    const note = t.socket.sent.find((e) => e.type === "conversation.item.create" && e.item.role === "system")!;
    expect(note.item.content[0].text).toMatch(/Posted it\./);
    expect(t.socket.sent.at(-1)).toEqual({ type: "response.create" });
  });

  it("a failure after the start is reported; stop() closes without one", async () => {
    const t = await started();
    t.socket.event({ type: "browsertodo.error", error: "out_of_credit", message: "Out of usage credit" });
    t.socket.readyState = 3;
    t.socket.onclose?.({ code: REALTIME_CLOSE.credit, reason: "" });
    expect(t.log).toContain("failed:credit");
    const u = await started();
    u.engine.stop();
    await settle();
    expect(u.log.filter((l) => l.startsWith("failed"))).toEqual([]);
  });
});
