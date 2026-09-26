/**
 * Which voice engine a hands-free session uses: the one picked in Settings
 * (Realtime by default), unless the server cannot run it or the usage credit
 * is too low for it, then Standard with a one-line note. Costs come from the
 * server (GET VOICE_ENGINES_PATH), never from here. Pure.
 */
import type { VoiceEngineId, VoiceEnginesResponse } from "@browsertodo/shared";

/** Realtime needs credit for at least this many minutes, else Standard is used. */
export const LOW_CREDIT_MINUTES = 3;

/** The engines' names (the owner's wording; the server's list gives their prices). */
export const ENGINE_NAMES: Record<VoiceEngineId, string> = { realtime: "Realtime (OpenAI)", standard: "Standard" };

export interface EngineChoice {
  engine: VoiceEngineId;
  /** Why the other engine is used than the one picked (shown once, one line). */
  note: string | null;
}

export const REALTIME_NOT_AVAILABLE_NOTE = "Realtime voice is unavailable. Using Standard.";
export const LOW_CREDIT_NOTE = "Usage credit is low. Using Standard voice (it costs much less).";

export function chooseEngine(opts: {
  preferred: VoiceEngineId;
  /** The server's engines and its default; null when they could not be loaded. */
  engines: VoiceEnginesResponse | null;
  /** Usage credit left, in cents (undefined: not known). */
  creditCents: number | undefined;
}): EngineChoice {
  if (opts.preferred === "standard") return { engine: "standard", note: null };
  if (!opts.engines) return { engine: "realtime", note: null };
  const realtime = opts.engines.engines.find((e) => e.id === "realtime");
  // The server offers Standard as its default only when it cannot run Realtime.
  if (!realtime?.available || opts.engines.default === "standard") return { engine: "standard", note: REALTIME_NOT_AVAILABLE_NOTE };
  if (opts.creditCents !== undefined && opts.creditCents < realtime.approxCentsPerMinute * LOW_CREDIT_MINUTES) {
    return { engine: "standard", note: LOW_CREDIT_NOTE };
  }
  return { engine: "realtime", note: null };
}

/** "about 30¢ of usage credit a minute", "about $1.25 of usage credit a minute". */
export function costPerMinuteText(cents: number): string {
  const unit = " of usage credit a minute";
  if (cents >= 100) return `about $${(cents / 100).toFixed(2)}${unit}`;
  if (cents >= 1) return `about ${Math.round(cents)}¢${unit}`;
  if (cents < 0.01) return `under 0.01¢${unit}`;
  return `about ${Number(cents.toPrecision(2))}¢${unit}`;
}
