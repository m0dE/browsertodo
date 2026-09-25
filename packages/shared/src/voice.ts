import { z } from "zod";

/**
 * Voice input: the one place for its contract, limits and tuning. The API
 * (apps/api/src/transcribe.ts) enforces the limits; the extension
 * (apps/extension/src/voice/) captures, detects speech and dictates live with
 * the same numbers. Prices are in apps/api/src/pricing.ts, the plans that
 * include voice in PLAN_CATALOG (`voice`), request rates in apps/api/src/ratelimit.ts.
 */

/** POST: a WAV clip in, its text out (session token; paid plans). */
export const TRANSCRIBE_PATH = "/v1/ai/transcribe";
export const TRANSCRIBE_CONTENT_TYPE = "audio/wav";

/** Query parameters of TRANSCRIBE_PATH. */
export const TRANSCRIBE_QUERY = {
  /** Language hint ("en", "ko", "pt-BR"); absent = the model detects it. */
  language: "language",
  /** Milliseconds of speech the client's detector heard (0 = silence: nothing is sent to the model). */
  speechMs: "speech_ms",
  /** Text said just before this clip (live dictation), for consistent wording. */
  context: "context",
} as const;

/** 200 of TRANSCRIBE_PATH. */
export const TranscribeResponse = z.object({
  text: z.string(),
  /** Audio length billed. */
  seconds: z.number(),
  /** Charged for this clip, in (fractional) cents. */
  chargedCents: z.number(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

/** Limits both sides agree on. */
export const VOICE_LIMITS = {
  /** Sample rate of the clips (Whisper's native rate), mono 16-bit PCM. */
  sampleRate: 16_000,
  /** Longest clip, and longest listening session. */
  maxClipMs: 60_000,
  /** Largest request body: 60 s at 16 kHz mono 16-bit is 1.92 MB plus the header. */
  maxClipBytes: 2 * 1024 * 1024,
  /** Shorter clips are not sent to the model and cost nothing. */
  minClipMs: 250,
  /** Whisper's stock phrases ("Thank you.") on less speech than this are treated as silence. */
  hallucinationSpeechMs: 1_500,
  /** Most characters of `context` the model is given. */
  contextChars: 300,
} as const;

/** Capture, speech detection and live dictation tuning (extension). */
export const VOICE_TUNING = {
  /** Analysis frame of the speech detector. */
  frameMs: 20,
  /** A frame is speech when its RMS is this many times the running noise floor... */
  speechOverNoise: 3,
  /** ...and at least this loud (RMS of samples in -1..1). */
  minSpeechRms: 0.012,
  /** Loud audio for this long starts speech (debounces clicks and taps). */
  speechStartMs: 80,
  /** Speech lasts until it has been quiet this long (bridges the dips between syllables). */
  speechHangoverMs: 200,
  /**
   * The noise floor tracks the quietest input: it drops this fast (per frame,
   * 0..1) to a quieter frame, like the dips between syllables...
   */
  noiseFloorFall: 0.2,
  /** ...and otherwise rises this slowly, so a new steady noise (a fan) stops counting as speech after a few seconds. */
  noiseFloorRise: 0.002,
  /** Audio kept before the first and after the last speech frame of a clip. */
  preRollMs: 200,
  postRollMs: 300,
  /** Live text: send the audio heard so far this often while someone speaks (one request in flight). */
  partialIntervalMs: 1_000,
  /** Re-transcribe at most about this much audio: older speech is finalised at a pause. */
  windowMs: 10_000,
  /** Quiet (after the hangover) at least this long is a pause where finalised text may end. */
  commitPauseMs: 200,
  /** With no such pause for this long, finalise at the quietest moment anyway. */
  forceCommitMs: 20_000,
  /** Offer to stop after this much silence (listening stops; the text is kept, not sent). */
  longSilenceMs: 8_000,
  /** Level meter smoothing (0..1 per frame; higher follows faster). */
  levelSmoothing: 0.35,
  /** Holding the mic button at least this long is push-to-talk: letting go stops listening. */
  pushToTalkMs: 400,
} as const;
