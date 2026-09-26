/**
 * The hands-free session as a state machine: the voice shortcut starts it,
 * the microphone stays on, what the user says goes to the agent, and short
 * lines are said back.
 *
 *   listening --heard--> sending --sendDelayMs--> listening / working
 *   listening / working --say--> speaking --said--> listening / working
 *   speaking --speech (barge-in)--> listening / working
 *
 * "working" is listening while the agent runs a task: what the user says
 * then goes into that task as a message. "sending" is the short window in
 * which an utterance can still be cancelled (saying "cancel", or Esc).
 * Saying "stop" / "stop listening", the shortcut or Esc end the session, as
 * does HANDS_FREE.silenceTimeoutMs without speech while nothing runs.
 *
 * Half-duplex (the Standard engine): nothing is transcribed while a line is
 * said, so it never hears itself; the speech detector still runs, so the
 * user can cut in. The Realtime engine hears through the narrator's own
 * turn detection, so it is not half-duplex.
 *
 * Pure: events in (with the time), the next state and effects out. The
 * side panel (sidepanel/hands-free.ts) runs the effects and the clock.
 */

export const HANDS_FREE = {
  /** The "Sending…" window after an utterance, in which it can still be cancelled. */
  sendDelayMs: 1_200,
  /** No speech for this long, while no task runs, ends the session. */
  silenceTimeoutMs: 3 * 60_000,
  /** Speech this long while a line is said interrupts it (shorter is taken for the speaker's own echo). */
  bargeInMs: 350,
  /** How often the clock ticks (the sending window and the silence timeout). */
  tickMs: 100,
} as const;

export type HandsFreePhase = "off" | "listening" | "sending" | "working" | "speaking";

/** Why a session ended. */
export type EndReason = "shortcut" | "button" | "voice" | "escape" | "silence" | "narrator" | "error";

export interface HandsFreeState {
  phase: HandsFreePhase;
  /** Stop transcribing while a line is said (Standard engine). */
  halfDuplex: boolean;
  /** A task of this chat is running. */
  agentWorking: boolean;
  /** What the user said that waits in the sending window. */
  pending: string;
  /** When the sending window closes; null while held (the user is speaking again). */
  sendAt: number | null;
  /** The next line to say, once the user is done and the current line is over (the newest one wins). */
  queued: string | null;
  /** The speech detector heard the user start and the words are not in yet. */
  userSpeaking: boolean;
  /** The last speech, message, line or agent activity, for the silence timeout. */
  lastActivityAt: number;
}

export type HandsFreeEvent =
  | { type: "start"; now: number; halfDuplex: boolean }
  | { type: "stop"; reason: EndReason }
  /** The user started speaking (detector or the narrator's turn detection). */
  | { type: "speech"; now: number }
  /** What the user said. forward: it is a message for the agent (Standard); else it is only checked for stop and cancel words. */
  | { type: "heard"; text: string; forward: boolean; now: number }
  /** A message for the agent from the Realtime narrator (its send_to_agent tool). */
  | { type: "forward"; text: string; now: number }
  /** Esc. */
  | { type: "cancel"; now: number }
  | { type: "tick"; now: number }
  /** A task of this chat started or ended. */
  | { type: "agent"; working: boolean; now: number }
  /** A line to say (Standard engine). */
  | { type: "say"; text: string; now: number }
  /** The Realtime narrator started talking by itself. */
  | { type: "narrating"; now: number }
  /** The line (or the narrator) is done. */
  | { type: "said"; now: number };

export type HandsFreeEffect =
  | { type: "send"; text: string }
  | { type: "speak"; text: string }
  /** Stop talking now. */
  | { type: "hush" }
  /** Half-duplex: stop or start turning speech into text. */
  | { type: "transcribe"; on: boolean }
  /** A waiting message was cancelled. */
  | { type: "cancelled" }
  | { type: "end"; reason: EndReason };

export interface HandsFreeStep {
  state: HandsFreeState;
  effects: HandsFreeEffect[];
}

export function initialHandsFree(): HandsFreeState {
  return { phase: "off", halfDuplex: true, agentWorking: false, pending: "", sendAt: null, queued: null, userSpeaking: false, lastActivityAt: 0 };
}

const bare = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP_PHRASES = new Set(["stop", "stop listening", "stop it", "end voice", "stop voice", "goodbye", "bye"]);
const CANCEL_PHRASES = new Set(["cancel", "cancel that", "cancel it", "never mind", "nevermind", "don't send", "don't send it", "do not send"]);

/** The whole utterance asks to end the session ("stop", "stop listening"). */
export const isStopPhrase = (text: string): boolean => STOP_PHRASES.has(bare(text));
/** The whole utterance takes back the message waiting to be sent ("cancel", "never mind"). */
export const isCancelPhrase = (text: string): boolean => CANCEL_PHRASES.has(bare(text));

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(" ");

/** Listening, or working while a task runs. */
const resting = (s: HandsFreeState): HandsFreePhase => (s.agentWorking ? "working" : "listening");

export function handsFree(s: HandsFreeState, e: HandsFreeEvent): HandsFreeStep {
  if (s.phase === "off") {
    if (e.type !== "start") return { state: s, effects: [] };
    return {
      state: { ...initialHandsFree(), phase: "listening", halfDuplex: e.halfDuplex, lastActivityAt: e.now },
      effects: [{ type: "transcribe", on: true }],
    };
  }
  switch (e.type) {
    case "start":
      return { state: s, effects: [] };
    case "stop":
      return end(s, e.reason);
    case "speech":
      return speech(s, e.now);
    case "heard":
      return heard(s, e.text, e.forward, e.now);
    case "forward":
      return e.text.trim() ? waitToSend({ ...s, lastActivityAt: e.now }, e.text, e.now) : { state: s, effects: [] };
    case "cancel":
      if (s.phase === "sending") return cancelPending(s);
      if (s.phase === "speaking") return interrupt(s, e.now);
      return end(s, "escape");
    case "tick":
      return tick(s, e.now);
    case "agent": {
      const next = { ...s, agentWorking: e.working, lastActivityAt: e.now };
      if (s.phase === "listening" || s.phase === "working") next.phase = resting(next);
      return { state: next, effects: [] };
    }
    case "say":
      return say({ ...s, lastActivityAt: e.now }, e.text);
    case "narrating":
      return { state: { ...s, phase: s.phase === "sending" ? s.phase : "speaking", lastActivityAt: e.now }, effects: [] };
    case "said": {
      if (s.phase !== "speaking") return { state: s, effects: [] };
      const next = { ...s, phase: resting(s), lastActivityAt: e.now };
      const effects: HandsFreeEffect[] = s.halfDuplex ? [{ type: "transcribe", on: true }] : [];
      const queued = sayQueued(next);
      return { state: queued.state, effects: [...effects, ...queued.effects] };
    }
  }
}

function end(s: HandsFreeState, reason: EndReason): HandsFreeStep {
  const effects: HandsFreeEffect[] = s.phase === "speaking" ? [{ type: "hush" }] : [];
  effects.push({ type: "end", reason });
  return { state: { ...initialHandsFree(), lastActivityAt: s.lastActivityAt }, effects };
}

/** The user cut in: the line stops, and what was queued is dropped (they have the floor). */
function interrupt(s: HandsFreeState, now: number): HandsFreeStep {
  const effects: HandsFreeEffect[] = [{ type: "hush" }];
  if (s.halfDuplex) effects.push({ type: "transcribe", on: true });
  return { state: { ...s, phase: resting(s), queued: null, lastActivityAt: now }, effects };
}

function speech(s: HandsFreeState, now: number): HandsFreeStep {
  if (s.phase === "speaking") {
    const r = interrupt(s, now);
    return { state: { ...r.state, userSpeaking: true }, effects: r.effects };
  }
  // In the sending window the user goes on talking: hold it until their next words are in.
  const sendAt = s.phase === "sending" ? null : s.sendAt;
  return { state: { ...s, userSpeaking: true, sendAt, lastActivityAt: now }, effects: [] };
}

function heard(s: HandsFreeState, text: string, forward: boolean, now: number): HandsFreeStep {
  // Half-duplex never transcribes while speaking; anything heard then is the speaker's own voice.
  if (s.phase === "speaking" && s.halfDuplex) return { state: s, effects: [] };
  const next: HandsFreeState = { ...s, userSpeaking: false, lastActivityAt: now };
  if (isStopPhrase(text)) return end(next, "voice");
  if (isCancelPhrase(text)) return next.pending ? cancelPending(next) : sayQueued(next);
  if (forward && text.trim()) return waitToSend(next, text, now);
  // Nothing for the agent: a held window opens again for what was waiting.
  if (next.phase === "sending") return { state: { ...next, sendAt: now + HANDS_FREE.sendDelayMs }, effects: [] };
  return sayQueued(next);
}

function waitToSend(s: HandsFreeState, text: string, now: number): HandsFreeStep {
  const effects: HandsFreeEffect[] = s.phase === "speaking" ? [{ type: "hush" }] : [];
  return { state: { ...s, phase: "sending", pending: join(s.pending, text), sendAt: now + HANDS_FREE.sendDelayMs }, effects };
}

function cancelPending(s: HandsFreeState): HandsFreeStep {
  const next = { ...s, phase: resting(s), pending: "", sendAt: null };
  const queued = sayQueued(next);
  return { state: queued.state, effects: [{ type: "cancelled" }, ...queued.effects] };
}

function tick(s: HandsFreeState, now: number): HandsFreeStep {
  if (s.phase === "sending" && s.sendAt !== null && now >= s.sendAt) {
    const next = { ...s, phase: resting(s), pending: "", sendAt: null, lastActivityAt: now };
    const queued = sayQueued(next);
    return { state: queued.state, effects: [{ type: "send", text: s.pending }, ...queued.effects] };
  }
  const idle = (s.phase === "listening" || s.phase === "sending") && !s.agentWorking;
  if (idle && now - s.lastActivityAt >= HANDS_FREE.silenceTimeoutMs) return end(s, "silence");
  return { state: s, effects: [] };
}

/** Says `text` now, or queues it while the user talks, a message waits or another line is said. */
function say(s: HandsFreeState, text: string): HandsFreeStep {
  if (!text.trim()) return { state: s, effects: [] };
  if (s.phase === "speaking" || s.phase === "sending" || s.userSpeaking) return { state: { ...s, queued: text }, effects: [] };
  const effects: HandsFreeEffect[] = s.halfDuplex ? [{ type: "transcribe", on: false }] : [];
  effects.push({ type: "speak", text });
  return { state: { ...s, phase: "speaking", queued: null }, effects };
}

function sayQueued(s: HandsFreeState): HandsFreeStep {
  return s.queued ? say(s, s.queued) : { state: s, effects: [] };
}
