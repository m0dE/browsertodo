/**
 * The Standard hands-free engine: the microphone stays open (one MicTee),
 * the speech detector and the endpointer (endpointing.ts) decide where each
 * utterance ends, a Dictation per utterance turns it into text with Whisper
 * (live partials through voice.transcribe), and lines are said with the
 * browser's own speech (Speaker). Half-duplex: no dictation runs while a
 * line is said; speech long enough (HANDS_FREE.bargeInMs) cuts the line off,
 * and the next dictation starts with the audio just before, so the first
 * words are kept.
 */
import { VOICE_LIMITS, VOICE_TUNING, type AgentEvent } from "@browsertodo/shared";
import { Dictation, isFatal, type AudioSource, type TranscribeClip } from "./dictation.js";
import { Endpointer } from "./endpointing.js";
import type { EngineEvents, HandsFreeEngine } from "./engine.js";
import { HANDS_FREE } from "./hands-free.js";
import { MicTee } from "./mic-tee.js";
import type { Speaker } from "./speaker.js";
import { meterLevel, SpeechDetector } from "./speech.js";

/** Audio replayed to the dictation that starts after a barge-in. */
const BARGE_IN_REPLAY_MS = 600;

export interface StandardEngineDeps {
  /** The microphone at VOICE_LIMITS.sampleRate. */
  createSource(): AudioSource;
  transcribe: TranscribeClip;
  speaker: Pick<Speaker, "speak" | "cancel" | "speaking">;
  events: EngineEvents;
}

export class StandardEngine implements HandsFreeEngine {
  readonly id = "standard" as const;
  readonly halfDuplex = true;
  private tee: MicTee | null = null;
  private dictation: Dictation | null = null;
  private transcribing = false;
  private readonly detector = new SpeechDetector();
  private readonly endpointer = new Endpointer(VOICE_TUNING.frameMs);
  private readonly frameSamples = Math.round((VOICE_LIMITS.sampleRate * VOICE_TUNING.frameMs) / 1000);
  private pending = new Float32Array(0);
  private level = 0;
  /** This utterance was reported (speech()). */
  private reported = false;
  /** Loud frames in this utterance (its speech without the detector's hangover). */
  private loudFrames = 0;
  /** The line being said (a newer line or hush() makes an older one's end moot). */
  private line = 0;
  /** hush() cut a line off: the next dictation replays the audio just before. */
  private cutIn = false;
  private stopped = false;

  constructor(private readonly deps: StandardEngineDeps) {}

  async start(): Promise<void> {
    this.tee = new MicTee(this.deps.createSource(), Math.round((VOICE_LIMITS.sampleRate * BARGE_IN_REPLAY_MS) / 1000));
    await this.tee.start((s) => this.onSamples(s));
  }

  stop(): void {
    this.stopped = true;
    this.dictation?.cancel();
    this.dictation = null;
    this.hush();
    this.tee?.stop();
    this.tee = null;
  }

  speak(text: string): void {
    const id = ++this.line;
    void this.deps.speaker.speak(text).then(() => {
      if (id === this.line && !this.stopped) this.deps.events.said();
    });
  }

  hush(): void {
    if (this.deps.speaker.speaking) this.cutIn = true;
    this.line++;
    this.deps.speaker.cancel();
  }

  setTranscribing(on: boolean): void {
    this.transcribing = on;
    if (!on) {
      this.dictation?.cancel();
      this.dictation = null;
      return;
    }
    if (!this.dictation) this.listen(this.cutIn);
    this.cutIn = false;
  }

  agentEvent(_ev: AgentEvent, _now: number): void {
    // The panel picks the lines to say (narration.ts).
  }

  cancelled(): void {}

  tick(_now: number): void {}

  /** Starts the next utterance's dictation (with the audio just before, after a barge-in). */
  private listen(replay: boolean): void {
    if (!this.tee || this.stopped) return;
    const d = new Dictation({
      source: this.tee.branch({ replay }),
      transcribe: this.deps.transcribe,
      events: { onText: (t) => this.dictation === d && this.deps.events.partial(t) },
    });
    this.dictation = d;
    d.run().then(
      (r) => {
        if (this.dictation === d) this.dictation = null;
        // Stopped at an utterance's end (send), or by itself (long silence, the clip cap).
        if (r.reason !== "cancel" && !this.stopped) {
          if (r.reason !== "silence" || r.text) this.deps.events.heard(r.text, true);
          if (this.transcribing && !this.dictation) this.listen(false);
        }
      },
      (err) => {
        if (this.dictation === d) this.dictation = null;
        if (this.stopped) return;
        if (isFatal(err)) return this.deps.events.failed(err);
        if (this.transcribing && !this.dictation) this.listen(false);
      },
    );
  }

  private onSamples(samples: Float32Array): void {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let at = 0;
    for (; at + this.frameSamples <= joined.length; at += this.frameSamples) this.onFrame(joined.subarray(at, at + this.frameSamples));
    this.pending = joined.slice(at);
    this.deps.events.level(this.level);
  }

  private onFrame(frame: Float32Array): void {
    const v = this.detector.push(frame);
    this.level += (meterLevel(v.rms) - this.level) * VOICE_TUNING.levelSmoothing;
    const signal = this.endpointer.push(v.speech);
    if (v.loud) this.loudFrames++;
    // Quiet (past the hangover) starts the count over.
    if (!v.speech) this.loudFrames = 0;
    if (signal === "end") {
      this.reported = false;
      // The utterance is over: its dictation finishes the text and reports it.
      const d = this.dictation;
      this.dictation = null;
      if (d) void d.stop("send");
      if (this.transcribing) this.listen(false);
      return;
    }
    if (this.reported || !v.speech) return;
    // Reported once it is an utterance; over a line only once it is long enough to be the user cutting in.
    const barge = this.deps.speaker.speaking;
    if (barge ? this.loudFrames * VOICE_TUNING.frameMs >= HANDS_FREE.bargeInMs : signal === "start") {
      this.reported = true;
      this.deps.events.speech();
    }
  }
}
