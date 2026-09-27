/**
 * When the Realtime narrator speaks (narrator-policy.ts), unit by unit and through the real engine (client + feed)
 * with OpenAI's events in their real order. Regression for the owner's report "the agent responds to what I'm saying,
 * then it transcribes what I said and re-responds to the transcription after": the agent's first words restate the
 * request, and a timed progress note made the narrator say them again (a second reply for one utterance); and for the
 * trace of 2026-09-27: a result spoken over the user, a talked-over summary still heard, progress piled on the answer
 * to the user, a reply to noise.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@browsertodo/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import {
  floor,
  freshMemory,
  isNoise,
  MAX_MILESTONES_PER_REQUEST,
  narrationOf,
  NARRATOR_MILESTONE_GAP_MS,
  NOISE_MAX_SPEECH_MS,
  type Floor,
} from "../../src/voice/narrator-policy.js";
import { ACKNOWLEDGE_INSTRUCTIONS, NARRATOR_INSTRUCTIONS, type RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";

const GAP = NARRATOR_MILESTONE_GAP_MS;
const nav = (url: string): AgentEvent => ({ type: "tool_call", id: "t", name: "navigate", args: { url } });

describe("narrationOf: what may make the narrator speak", () => {
  it("never the user's message or words, the agent's text, status lines or routine steps", () => {
    const m = freshMemory(0);
    const quiet: AgentEvent[] = [
      { type: "user_message", text: "Check my inbox.", voice: true },
      { type: "user_message", text: "Check my inbox." },
      { type: "heard", text: "Check my inbox.", sent: "Check my inbox." },
      { type: "assistant_text", text: "I'll open your Gmail inbox and summarize it." },
      { type: "status", text: "Claude API" },
      nav("https://mail.google.com/"),
      ...["read_page", "screenshot", "click", "act", "scroll", "type", "paste", "switch_tab"].map((name): AgentEvent => ({ type: "tool_call", id: "t", name, args: {} })),
    ];
    for (const [i, ev] of quiet.entries()) expect(narrationOf(ev, m, GAP * (i + 1)), ev.type).toBeNull();
  });

  it("the result, the agent's question and a problem, each once", () => {
    const m = freshMemory(0);
    expect(narrationOf({ type: "task_end", outcome: "done", summary: "x", spoken: "You have 3 new emails; one is from your accountant." }, m, 1)).toEqual({
      kind: "result",
      line: "You have 3 new emails; one is from your accountant.",
    });
    expect(narrationOf({ type: "task_end", outcome: "done", summary: "x", spoken: "You have 3 new emails; one is from your accountant." }, m, 2)).toBeNull();
    expect(narrationOf({ type: "task_end", outcome: "paused", reason: "Which account?" }, m, 3)).toEqual({ kind: "question", line: "Which account?" });
    expect(narrationOf({ type: "error", text: "Claude API rate limit (HTTP 429)" }, m, 4)?.kind).toBe("error");
  });

  it("a meaningful step (another site, an account switch, a sign-in): not the first site, NARRATOR_MILESTONE_GAP_MS apart, MAX_MILESTONES_PER_REQUEST", () => {
    const m = freshMemory(0);
    expect(narrationOf(nav("https://mail.google.com/"), m, GAP)).toBeNull();
    expect(narrationOf(nav("https://calendar.google.com/"), m, GAP)).toEqual({ kind: "milestone", line: "Opening calendar.google.com" });
    expect(narrationOf({ type: "tool_call", id: "t", name: "switch_x_account", args: { handle: "@acme" } }, m, GAP * 2 - 1)).toBeNull();
    expect(narrationOf({ type: "tool_call", id: "t", name: "switch_x_account", args: { handle: "@acme" } }, m, GAP * 2)).toEqual({ kind: "milestone", line: "Switching to @acme" });
    expect(MAX_MILESTONES_PER_REQUEST).toBe(2);
    expect(narrationOf(nav("https://drive.google.com/"), m, GAP * 10)).toBeNull();
  });
});

describe("floor: one speaker at a time", () => {
  const free: Floor = { userSpeaking: false, awaitingReply: false, replying: false, playing: false };
  const kinds = ["ack", "milestone", "result", "question", "error"] as const;

  it("the user speaking, or their reply about to start: every line is let go (their reply answers, with the news in it)", () => {
    for (const k of kinds) {
      expect(floor(k, { ...free, userSpeaking: true })).toBe("drop");
      expect(floor(k, { ...free, awaitingReply: true })).toBe("drop");
    }
  });

  it("a reply being made or audio playing: a milestone is let go, the rest wait", () => {
    for (const busy of [{ ...free, replying: true }, { ...free, playing: true }]) {
      expect(floor("milestone", busy)).toBe("drop");
      for (const k of ["ack", "result", "question", "error"] as const) expect(floor(k, busy)).toBe("later");
    }
  });

  it("a free floor: now", () => {
    for (const k of kinds) expect(floor(k, free)).toBe("now");
  });
});

describe("isNoise", () => {
  it("an empty transcript of a short sound is noise; words, or long speech, are not", () => {
    expect(isNoise("", 2_000)).toBe(true);
    expect(isNoise("  ", NOISE_MAX_SPEECH_MS)).toBe(true);
    expect(isNoise("", null)).toBe(true);
    expect(isNoise("", NOISE_MAX_SPEECH_MS + 1)).toBe(false);
    expect(isNoise("hi", 300)).toBe(false);
  });
});

it("the narrator is told to speak only with news", () => {
  expect(NARRATOR_INSTRUCTIONS).toContain("Speak only when you have news the user doesn't have: results, questions, blockers, errors. Never describe routine steps");
  expect(NARRATOR_INSTRUCTIONS).toContain("never repeat the user's request back to them");
});

// ---------------------------------------------------------------- the real engine

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
const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const socket = new FakeSocket();
  const mic: AudioSource = { start: async () => {}, stop: () => {} };
  const words: string[] = [];
  const noop = () => {};
  const events = {
    speech: noop,
    heard: noop,
    partial: noop,
    level: noop,
    narrating: noop,
    said: noop,
    narratorText: noop,
    forward: noop,
    userWords: (w: string) => void words.push(w),
    stopTask: async () => "ok",
    endVoice: noop,
    failed: noop,
  } as unknown as EngineEvents;
  const player = { play: vi.fn(), stop: vi.fn(() => null), close: vi.fn(), playing: false };
  const engine = new RealtimeEngine({ ticket: async () => ({ url: "wss://x", token: "t" }), createSource: () => mic, events, openSocket: () => socket, player });
  const start = engine.start();
  await settle();
  socket.readyState = 1;
  socket.onopen?.({});
  socket.event({ type: "session.created", session: {} });
  await start;
  let served = 0;
  const creates = () => socket.sent.filter((e) => e.type === "response.create");
  /** The server answers each response.create the client sent (created, audio, done). */
  const serve = () => {
    while (served < creates().length) {
      const id = `ours${++served}`;
      socket.event({ type: "response.created", response: { id } });
      socket.event({ type: "response.output_audio.delta", response_id: id, item_id: `a_${id}`, delta: "AAAA" });
      socket.event({ type: "response.done", response: { id, status: "completed" } });
    }
  };
  const played = () => player.play.mock.calls.map((c) => c[0] as string);
  return { s: socket, engine, player, serve, creates, played, words };
}

/** The user's turn as server VAD reports it (speech of `ms`), and the reply the server makes for it (create_response). */
function userTurn(s: FakeSocket, input: string, reply: string, ms = 3_000): void {
  s.event({ type: "input_audio_buffer.speech_started", item_id: input, audio_start_ms: 1_000 });
  s.event({ type: "input_audio_buffer.speech_stopped", item_id: input, audio_end_ms: 1_000 + ms });
  s.event({ type: "input_audio_buffer.committed", item_id: input, previous_item_id: null });
  s.event({ type: "response.created", response: { id: reply } });
}
const transcribed = (s: FakeSocket, input: string, transcript: string) =>
  s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: input, content_index: 0, transcript, usage: { type: "duration", seconds: 3 } });

describe("one reply per spoken request (the owner's report)", () => {
  for (const order of ["before", "after"] as const) {
    it(`the transcript ${order} response.done: the acknowledgement only, whatever the agent does next`, async () => {
      const t = await started();
      const T0 = Date.now();
      userTurn(t.s, "in1", "r1");
      t.s.event({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Check my inbox." }) });
      await settle();
      if (order === "before") transcribed(t.s, "in1", "Check my inbox.");
      t.s.event({ type: "response.done", response: { id: "r1", status: "completed" } });
      if (order === "after") transcribed(t.s, "in1", "Check my inbox.");
      t.serve();
      // The agent's first events for the request (the panel feeds them), its steps, and the clock.
      const evs: AgentEvent[] = [
        { type: "user_message", text: "Check my inbox.", voice: true },
        { type: "assistant_text", text: "I'll open your Gmail inbox and summarize the important emails." },
        nav("https://mail.google.com/mail/u/0/#inbox"),
        { type: "heard", text: "Check my inbox.", sent: "Check my inbox." },
        { type: "tool_call", id: "t2", name: "read_page", args: {} },
        { type: "assistant_text", text: "I'm still working through the inbox." },
        { type: "tool_call", id: "t3", name: "act", args: { steps: [{ goal: "open the first email" }] } },
      ];
      evs.forEach((e, i) => {
        t.engine.agentEvent(e, T0 + 500 + i * 3_000);
        t.serve();
      });
      for (let ms = 0; ms <= 30_000; ms += 1_000) {
        t.engine.tick(T0 + ms);
        t.serve();
      }
      expect(t.creates()).toEqual([{ type: "response.create", response: { instructions: ACKNOWLEDGE_INSTRUCTIONS } }]);
      expect(t.words).toEqual(["Check my inbox."]);
      // The result is news: it is said, once.
      t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have 3 new emails; one is from your accountant." }, T0 + 40_000);
      t.serve();
      expect(t.creates()).toHaveLength(2);
      expect(t.s.sent.filter((e) => e.item?.role === "system").map((e) => e.item.content[0].text)).toEqual([
        'Agent update (finished): The task is done. Tell the user in one to three short sentences: "You have 3 new emails; one is from your accountant."',
      ]);
    });
  }
});

describe("the owner's trace of 2026-09-27", () => {
  it("(a) a result arriving while the user speaks is not said over them: their reply answers, with it", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in2", audio_start_ms: 1_000 });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    expect(t.creates()).toHaveLength(0);
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in2", audio_end_ms: 4_000 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in2" });
    t.s.event({ type: "response.created", response: { id: "r2" } });
    transcribed(t.s, "in2", "You're looking at the wrong inbox.");
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    t.serve();
    expect(t.creates()).toHaveLength(0);
  });

  it("(a) a summary the user talked over is not heard afterwards, and not said again", async () => {
    const t = await started();
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    expect(t.creates()).toHaveLength(1);
    t.s.event({ type: "response.created", response: { id: "sum" } });
    t.s.event({ type: "response.output_audio.delta", response_id: "sum", item_id: "a_sum", delta: "AAAA" });
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in2", audio_start_ms: 1_000 });
    t.s.event({ type: "response.output_audio.delta", response_id: "sum", item_id: "a_sum", delta: "BBBB" });
    t.s.event({ type: "response.done", response: { id: "sum", status: "cancelled" } });
    expect(t.played()).toEqual(["AAAA"]);
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in2", audio_end_ms: 4_000 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in2" });
    t.s.event({ type: "response.created", response: { id: "r2" } });
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Summarized", spoken: "You have over 7,000 unread emails." }, Date.now());
    t.serve();
    expect(t.creates()).toHaveLength(1);
  });

  it("(b) progress is never said on a clock, and routine steps never", async () => {
    const t = await started();
    const T0 = Date.now();
    for (let i = 0; i < 20; i++) {
      t.engine.agentEvent({ type: "tool_call", id: `t${i}`, name: i % 2 ? "read_page" : "act", args: {} }, T0 + i * 5_000);
      t.engine.agentEvent({ type: "assistant_text", text: "Still working on it." }, T0 + i * 5_000 + 1);
      t.engine.tick(T0 + i * 5_000 + 2);
    }
    expect(t.creates()).toHaveLength(0);
  });

  it("(c) progress while the narrator answers the user is let go; a result waits until the answer has been heard", async () => {
    const t = await started();
    t.engine.agentEvent(nav("https://mail.google.com/"), Date.now());
    userTurn(t.s, "in3", "ans");
    t.s.event({ type: "response.output_audio.delta", response_id: "ans", item_id: "a_ans", delta: "AAAA" });
    t.engine.agentEvent(nav("https://calendar.google.com/"), Date.now() + GAP * 2);
    t.engine.tick(Date.now() + GAP * 3);
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Switched", spoken: "Switched to admin@runhq.io; 2 emails need you." }, Date.now());
    t.player.playing = true;
    t.s.event({ type: "response.done", response: { id: "ans", status: "completed" } });
    // The answer is still playing: nothing starts over it.
    expect(t.creates()).toHaveLength(0);
    t.player.playing = false;
    (t.engine as unknown as { client: { playbackIdle(): void } }).client.playbackIdle();
    expect(t.creates()).toEqual([{ type: "response.create" }]);
  });

  it("(d) an empty transcript of a short sound: its reply is cancelled and never heard, and it is no message", async () => {
    const t = await started();
    userTurn(t.s, "in0", "r0", 2_000);
    transcribed(t.s, "in0", "");
    t.s.event({ type: "response.output_audio.delta", response_id: "r0", item_id: "a0", delta: "AAAA" });
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    expect(t.played()).toEqual([]);
    expect(t.words).toEqual([]);
  });

  it("(d) the transcript of noise arriving before its reply starts: that reply is cancelled when it does", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in0", audio_start_ms: 0 });
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in0", audio_end_ms: 800 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in0" });
    transcribed(t.s, "in0", "");
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(0);
    t.s.event({ type: "response.created", response: { id: "r0" } });
    t.s.event({ type: "response.output_audio.delta", response_id: "r0", item_id: "a0", delta: "AAAA" });
    expect(t.s.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    expect(t.played()).toEqual([]);
  });

  it("(d) news let go for a turn that was noise is said after all", async () => {
    const t = await started();
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in0", audio_start_ms: 0 });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "Posted", spoken: "Posted it." }, Date.now());
    t.s.event({ type: "input_audio_buffer.speech_stopped", item_id: "in0", audio_end_ms: 700 });
    t.s.event({ type: "input_audio_buffer.committed", item_id: "in0" });
    t.s.event({ type: "response.created", response: { id: "r0" } });
    transcribed(t.s, "in0", "");
    expect(t.creates()).toHaveLength(0);
    t.s.event({ type: "response.done", response: { id: "r0", status: "cancelled" } });
    expect(t.creates()).toEqual([{ type: "response.create" }]);
  });
});
