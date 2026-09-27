/**
 * What the voice bar at the top of the side panel says while a hands-free
 * session is on (sidepanel/voice-bar.ts draws it): one state word with its
 * icon, a line under it (the engine, how long it has been on, what to do),
 * the live meter (the microphone's level, or the speaker while a line is
 * said), and which buttons show. On another tab it names the tab the session
 * listens in instead, with Go to tab and Use voice here; in another tab's
 * panel (remoteBarView) the same, with nothing live.
 *
 * "Hearing you…" comes from the microphone's level (VoiceActivity), the
 * same for both engines. The polite announcement for screen readers leaves
 * it out, so a voice going on and off is not read out again and again.
 *
 * Pure.
 */
import type { VoiceEngineId } from "@browsertodo/shared";
import type { HandsFreePhase } from "./hands-free.js";
import { elsewhereLabel } from "./hands-free-tab.js";

/** A session's phase as the bar knows it: the state machine's, or still starting (microphone, connection). */
export type VoiceBarPhase = Exclude<HandsFreePhase, "off"> | "starting";

export type VoiceBarState = "starting" | "listening" | "hearing" | "sending" | "working" | "speaking" | "elsewhere";

export interface VoiceBarInput {
  phase: VoiceBarPhase;
  /** The microphone hears a voice now (VoiceActivity). */
  hearing: boolean;
  /** The engine running (null: not chosen yet). */
  engine: VoiceEngineId | null;
  /** How long the session has been on. */
  elapsedMs: number;
  /** The session listens in another tab than the one shown: that tab's title (null: not known). */
  elsewhere: { title: string | null } | null;
  /** The voice shortcut's label (null: none assigned). */
  shortcut: string | null;
}

export interface VoiceBarView {
  state: VoiceBarState;
  /** The state word, e.g. "Listening". */
  title: string;
  /** Under it: the engine, the time on, and what to do. */
  detail: string;
  /** mic: the microphone's level; speaker: the line being said; none: nothing live yet. */
  meter: "mic" | "speaker" | "none";
  /** For screen readers (polite): changes only with the state, not with the voice going on and off. */
  announce: string;
  /** The line being said can be cut off (Interrupt). */
  interrupt: boolean;
  /** Go to tab and Use voice here (the session listens in another tab). */
  elsewhere: boolean;
  /** The Stop button's tooltip and accessible name. */
  stopLabel: string;
  /** The voice shortcut, shown by Stop (null: none assigned). */
  shortcut: string | null;
}

export const ENGINE_NAMES: Record<VoiceEngineId, string> = { realtime: "Realtime", standard: "Standard" };

/** A session's time on: "0:07", "12:34", "1:02:03". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const TITLES: Record<Exclude<VoiceBarState, "elsewhere">, string> = {
  starting: "Starting…",
  listening: "Listening",
  hearing: "Hearing you…",
  sending: "Sending",
  working: "Agent working",
  speaking: "Speaking",
};

const HINTS: Record<Exclude<VoiceBarState, "elsewhere">, string> = {
  starting: "Turning on the microphone",
  listening: "Just talk · say “stop” to end",
  hearing: "Just talk · say “stop” to end",
  sending: "Say “cancel” or press Esc to take it back",
  working: "Still listening: talk to add to the task",
  speaking: "Tap Interrupt, or just talk",
};

function stateOf(input: VoiceBarInput): VoiceBarState {
  if (input.elsewhere) return "elsewhere";
  const { phase, hearing } = input;
  // The voice counts while the microphone is what is live: listening, or listening while the agent works.
  if (hearing && (phase === "listening" || phase === "working")) return "hearing";
  return phase;
}

export function voiceBarView(input: VoiceBarInput): VoiceBarView {
  const state = stateOf(input);
  const { shortcut } = input;
  const stopLabel = shortcut ? `Stop hands-free · ${shortcut}` : "Stop hands-free";
  const time = elapsedText(input.elapsedMs);
  const engine = input.engine ? `${ENGINE_NAMES[input.engine]} · ` : "";
  if (state === "elsewhere") {
    const title = elsewhereLabel(input.elsewhere?.title ?? null);
    return { state, title, detail: `${engine}${time}`, meter: "mic", announce: title, interrupt: false, elsewhere: true, stopLabel, shortcut };
  }
  const title = TITLES[state];
  const meter = state === "speaking" ? "speaker" : state === "starting" ? "none" : "mic";
  // "Hearing you…" comes and goes with the voice: it is announced as listening.
  const announced = state === "hearing" ? (input.phase === "working" ? TITLES.working : TITLES.listening) : title;
  return {
    state,
    title,
    detail: state === "starting" ? HINTS.starting : `${engine}${time} · ${HINTS[state]}`,
    meter,
    announce: `Hands-free: ${announced}`,
    interrupt: state === "speaking",
    elsewhere: false,
    stopLabel,
    shortcut,
  };
}

/** Under the title in another tab's panel: the session runs elsewhere, this panel does not listen. */
export const NOT_HERE_TEXT = "Not listening in this tab";

/**
 * The bar in a panel that runs no session while one runs for another tab (its panel reports it through the
 * background): where, with Go to tab, Use voice here and Stop; no meter, no time, no shortcut (here it would move
 * the session, not stop it).
 */
export function remoteBarView(input: { title: string | null; engine: VoiceEngineId | null }): VoiceBarView {
  const title = elsewhereLabel(input.title);
  const engine = input.engine ? `${ENGINE_NAMES[input.engine]} · ` : "";
  return { state: "elsewhere", title, detail: `${engine}${NOT_HERE_TEXT}`, meter: "none", announce: title, interrupt: false, elsewhere: true, stopLabel: "Stop voice in that tab", shortcut: null };
}

/** How loud (the 0..1 meter level) counts as a voice, and how long "Hearing you…" stays after it. */
export const HEARING = { level: 0.5, holdMs: 600 } as const;

/** Whether the microphone hears a voice now, from its level; held a little so the word does not flicker. */
export class VoiceActivity {
  private lastVoiceAt = Number.NEGATIVE_INFINITY;

  /** A level (0..1) at `now`. */
  push(level: number, now: number): void {
    if (level >= HEARING.level) this.lastVoiceAt = now;
  }

  hearing(now: number): boolean {
    return now - this.lastVoiceAt < HEARING.holdMs;
  }

  reset(): void {
    this.lastVoiceAt = Number.NEGATIVE_INFINITY;
  }
}
