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
  repeatsRequest,
  speechTurnOf,
  type Floor,
} from "../../src/voice/narrator-policy.js";
import { ACK_MAX_OUTPUT_TOKENS, ackResponse, ACKNOWLEDGE_INSTRUCTIONS, HOLD_FOR_WORDS_MS, MAKE_AGAIN_RESPONSE, NARRATOR_INSTRUCTIONS, type RealtimeSocketLike } from "../../src/voice/realtime-client.js";
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
  /** What the panel was shown as said (each reply's words as they grow) and sent to the agent. */
  const shown: string[] = [];
  const forwarded: string[] = [];
  const paired: [string, string | null][] = [];
  const noop = () => {};
  const events = {
    speech: noop,
    heard: noop,
    partial: noop,
    level: noop,
    narrating: noop,
    said: noop,
    narratorText: (text: string) => void shown.push(text),
    forward: (text: string) => void forwarded.push(text),
    userWords: (w: string, sent: string | null) => {
      words.push(w);
      paired.push([w, sent]);
    },
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
  return { s: socket, engine, player, serve, creates, played, words, shown, forwarded, paired };
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
      expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("Check my inbox.") }]);
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
    transcribed(t.s, "in3", "Are you still there?");
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

/** The reply `id` (to the user's speech) starts saying `line`: its words, then its audio. */
function speaks(s: FakeSocket, id: string, line: string, audio = "AAAA"): void {
  s.event({ type: "response.output_audio_transcript.delta", response_id: id, delta: line });
  s.event({ type: "response.output_audio.delta", response_id: id, item_id: `a_${id}`, delta: audio });
}
const cancels = (s: FakeSocket) => s.sent.filter((e) => e.type === "response.cancel").length;
const truncations = (s: FakeSocket) => s.sent.filter((e) => e.type === "conversation.item.truncate").map((e) => [e.item_id, e.audio_end_ms]);

describe("the owner's trace of 2026-09-27, gpt-realtime-2.1 with Claude Code: the narrator answering by itself", () => {
  const CORRECTION = "No, you're being a jerk. I'm talking about like yesterday.";
  const MADE_UP = "Yesterday, I told you about two Chrome Web Store emails";

  it("(1, 5) a correction the narrator starts answering from its own notes: never heard or shown, cancelled, made again with a tool call required, and it reaches the agent", async () => {
    const t = await started();
    userTurn(t.s, "in3", "r3", 3_500);
    speaks(t.s, "r3", MADE_UP);
    transcribed(t.s, "in3", CORRECTION);
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(cancels(t.s)).toBe(1);
    t.s.event({ type: "response.done", response: { id: "r3", status: "cancelled" } });
    // What it began is out of its memory too (nothing of it was heard), and the turn is asked again: a tool must answer.
    expect(truncations(t.s)).toEqual([["a_r3", 0]]);
    expect(t.creates()).toEqual([{ type: "response.create", response: MAKE_AGAIN_RESPONSE }]);
    t.s.event({ type: "response.created", response: { id: "r3b" } });
    t.s.event({ type: "response.output_item.added", response_id: "r3b", item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: "r3b", call_id: "c3", name: "send_to_agent", arguments: JSON.stringify({ text: "I'm talking about yesterday." }) });
    await settle();
    t.s.event({ type: "response.done", response: { id: "r3b", status: "completed" } });
    expect(t.forwarded).toEqual(["I'm talking about yesterday."]);
    expect(t.paired).toEqual([[CORRECTION, "I'm talking about yesterday."]]);
    // Then the one short acknowledgement, and nothing of the made-up answer was ever played.
    expect(t.creates().slice(1)).toEqual([{ type: "response.create", response: ackResponse("I'm talking about yesterday.") }]);
    expect(t.played()).toEqual([]);
  });

  it("(5) the words arriving after that reply is done: it is still never heard, and made again at once", async () => {
    const t = await started();
    userTurn(t.s, "in3", "r3");
    speaks(t.s, "r3", "It asked you to add a privacy policy.");
    t.s.event({ type: "response.done", response: { id: "r3", status: "completed" } });
    expect(t.played()).toEqual([]);
    expect(t.words).toEqual([]);
    transcribed(t.s, "in3", "What did the second email say exactly?");
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(truncations(t.s)).toEqual([["a_r3", 0]]);
    expect(t.creates()).toEqual([{ type: "response.create", response: MAKE_AGAIN_RESPONSE }]);
  });

  it("a request whose reply says a made-up answer and then calls send_to_agent (live, 2026-09-27): the call goes, nothing it said is heard, the acknowledgement is ours", async () => {
    for (const wordsFirst of [true, false]) {
      const t = await started();
      userTurn(t.s, "in3", "r3");
      if (wordsFirst) transcribed(t.s, "in3", "What did the second email say exactly?");
      else speaks(t.s, "r3", "It says you need to add a privacy policy.");
      t.s.event({ type: "response.output_item.added", response_id: "r3", item: { type: "function_call", name: "send_to_agent" } });
      t.s.event({ type: "response.function_call_arguments.done", response_id: "r3", call_id: "c3", name: "send_to_agent", arguments: JSON.stringify({ text: "What did the second email say exactly?" }) });
      await settle();
      t.s.event({ type: "response.done", response: { id: "r3", status: "completed" } });
      if (!wordsFirst) transcribed(t.s, "in3", "What did the second email say exactly?");
      expect(t.forwarded).toEqual(["What did the second email say exactly?"]);
      expect(t.played()).toEqual([]);
      expect(t.shown).toEqual([]);
      expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("What did the second email say exactly?") }]);
    }
  });

  it("a request whose reply calls send_to_agent first is not held or asked again: the call runs at once (0 ms added)", async () => {
    const t = await started();
    userTurn(t.s, "in1", "r1");
    t.s.event({ type: "response.output_item.added", response_id: "r1", item: { type: "function_call", name: "send_to_agent" } });
    t.s.event({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Check my Chrome Web Store emails." }) });
    await settle();
    expect(t.forwarded).toEqual(["Check my Chrome Web Store emails."]);
    t.s.event({ type: "response.done", response: { id: "r1", status: "completed" } });
    transcribed(t.s, "in1", "Check my Chrome Web Store emails.");
    expect(t.creates()).toEqual([{ type: "response.create", response: ackResponse("Check my Chrome Web Store emails.") }]);
    expect(cancels(t.s)).toBe(0);
  });

  it("small talk is answered by the narrator itself: heard once the words are in, nothing goes to the agent", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2", 1_200);
    transcribed(t.s, "in2", "Hey, can you hear me?");
    speaks(t.s, "r2", "Yes, I can hear you.");
    t.s.event({ type: "response.done", response: { id: "r2", status: "completed" } });
    // Its words came first (as measured: 385-510 ms after the turn, its audio ~650 ms): played on arrival.
    expect(t.played()).toEqual(["AAAA"]);
    expect(t.shown).toEqual(["Yes, I can hear you."]);
    expect(t.forwarded).toEqual([]);
    expect(t.creates()).toEqual([]);
    expect(t.paired).toEqual([["Hey, can you hear me?", null]]);
  });

  it("small talk whose audio came before its words: held, then played in full once they are in", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2", 1_200);
    speaks(t.s, "r2", "Yes, ", "AAAA");
    speaks(t.s, "r2", "I can hear you.", "BBBB");
    expect(t.played()).toEqual([]);
    transcribed(t.s, "in2", "Can you hear me?");
    expect(t.played()).toEqual(["AAAA", "BBBB"]);
    expect(t.shown).toEqual(["Yes, I can hear you."]);
  });

  it("words that never come: what is held is heard after HOLD_FOR_WORDS_MS, as before", async () => {
    const t = await started();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      userTurn(t.s, "in2", "r2");
      speaks(t.s, "r2", "Hello!");
      vi.advanceTimersByTime(HOLD_FOR_WORDS_MS - 1);
      expect(t.played()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(t.played()).toEqual(["AAAA"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(2) the acknowledgement is capped (max_output_tokens) and told to say at most six words, no answer", async () => {
    // ~20 audio tokens a second: at most ~6 s even if its reasoning took nothing (the trace's ran 12.6 s, 492 tokens).
    const ack = ackResponse("What did the second email say exactly?");
    expect(ack).toMatchObject({ tool_choice: "none", max_output_tokens: ACK_MAX_OUTPUT_TOKENS, reasoning: { effort: "minimal" } });
    // Out of band with no context: it has none of the agent's updates (or the user's question) to answer from, and
    // keeps nothing of what it says; the request is only a sample of the user's language.
    expect(ack).toMatchObject({ conversation: "none", input: [] });
    expect(ack.instructions).toContain("a sample only: not something to answer): «What did the second email say exactly?»");
    expect(ackResponse(null).instructions).toBe(ACKNOWLEDGE_INSTRUCTIONS);
    expect(ACK_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(120);
    expect(ACKNOWLEDGE_INSTRUCTIONS).toContain("at most six words");
    expect(ACKNOWLEDGE_INSTRUCTIONS).toContain("no answer, no facts, no question");
    expect(NARRATOR_INSTRUCTIONS).toContain("Never answer those yourself from the updates, never guess dates or times");
  });

  it("(3) a reply cut off by noise shows nothing ('Said aloud: I don't have'), and the result that follows is the only line", async () => {
    const t = await started();
    userTurn(t.s, "in4", "r4", 900);
    speaks(t.s, "r4", "I don't have");
    transcribed(t.s, "in4", "");
    speaks(t.s, "r4", " the exact wording.");
    t.s.event({ type: "response.done", response: { id: "r4", status: "cancelled" } });
    t.engine.agentEvent({ type: "task_end", outcome: "done", summary: "x", spoken: "The second email asks you to add a privacy policy." }, Date.now());
    expect(t.creates()).toEqual([{ type: "response.create" }]);
    t.s.event({ type: "response.created", response: { id: "res" } });
    speaks(t.s, "res", "The second email asks for a privacy policy.", "RRRR");
    t.s.event({ type: "response.done", response: { id: "res", status: "completed" } });
    expect(t.shown).toEqual(["The second email asks for a privacy policy."]);
    expect(t.played()).toEqual(["RRRR"]);
  });

  it("(3) the words of a reply talked over are not shown past the point it was cut", async () => {
    const t = await started();
    userTurn(t.s, "in2", "r2");
    transcribed(t.s, "in2", "Hello?");
    speaks(t.s, "r2", "Hi! I'm");
    t.s.event({ type: "input_audio_buffer.speech_started", item_id: "in5", audio_start_ms: 9_000 });
    speaks(t.s, "r2", " still here and");
    expect(t.shown).toEqual(["Hi! I'm"]);
    expect(t.played()).toEqual(["AAAA"]);
  });

  it("(4) three replies to noise: none heard or shown, none made again, nothing sent; each cancelled", async () => {
    const t = await started();
    for (const n of [1, 2, 3]) {
      userTurn(t.s, `n${n}`, `rn${n}`, 600);
      speaks(t.s, `rn${n}`, "Sorry, I");
      transcribed(t.s, `n${n}`, "");
      t.s.event({ type: "response.done", response: { id: `rn${n}`, status: "cancelled" } });
    }
    expect(cancels(t.s)).toBe(3);
    expect(t.played()).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(t.creates()).toEqual([]);
    expect(t.words).toEqual([]);
  });
});

describe("speechTurnOf: what the narrator may answer by itself", () => {
  // Small talk only: it answers these itself (no agent turn). Everything else must go through a tool.
  const smallTalk = [
    "Hey, can you hear me?",
    "Hello?",
    "Hi there.",
    "Can you hear me now?",
    "Are you still there?",
    "Testing, testing.",
    "Thanks!",
    "Thank you so much.",
    "Okay.",
    "Okay, cool.",
    "Got it, thanks.",
    "Um...",
    "Hold on.",
    "What are you doing right now?",
    "Good morning!",
    "여보세요, 들려요?",
    "",
  ];
  // The owner's trace (2026-09-27) and the kinds of words that must reach the agent (or a tool).
  const requests = [
    "No, you're being a jerk. I'm talking about like yesterday.",
    "I'm talking about yesterday.",
    "What did the second email say exactly?",
    "What did you find?",
    "Do you remember what I asked you this morning?",
    "No, the other inbox.",
    "Hey, open my Gmail.",
    "Thanks, and now check my calendar.",
    "Stop.",
    "Cancel that.",
    "Yes.",
    "No.",
    "Goodbye.",
    "Use this tab.",
    "What's on this page?",
    "Check my inbox.",
  ];

  it("small talk is answered by the narrator; nothing of it starts an agent turn (false-forward risk: 0 of the corpus)", () => {
    const forwarded = smallTalk.filter((w) => speechTurnOf(w) !== "small_talk");
    expect(forwarded).toEqual([]);
  });

  it("anything about what the agent did, knows or remembers, a follow-up or correction, a question for the browser, a command: a tool call is required (0 answered alone)", () => {
    const answeredAlone = requests.filter((w) => speechTurnOf(w) !== "request");
    expect(answeredAlone).toEqual([]);
  });
});

describe("repeatsRequest: a request passed on again goes to the agent once", () => {
  const last = { inputId: "in1", text: "Resume from where I left off." };

  it("the same or nearly the same words in the same turn, or in a reply we asked for (no new words of the user's)", () => {
    expect(repeatsRequest("Resume from where I left off.", "in1", last)).toBe(true);
    expect(repeatsRequest("resume from where I left off", null, last)).toBe(true);
    expect(repeatsRequest("Please resume from where I left off", "in1", last)).toBe(true);
  });

  it("not another request in the same turn, the same words in a new turn, or nothing sent yet", () => {
    expect(repeatsRequest("And then open my calendar for tomorrow.", "in1", last)).toBe(false);
    expect(repeatsRequest("Resume from where I left off.", "in2", last)).toBe(false);
    expect(repeatsRequest("Resume from where I left off.", "in1", null)).toBe(false);
  });
});
