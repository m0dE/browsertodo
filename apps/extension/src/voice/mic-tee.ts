/**
 * One microphone, several listeners: hands-free voice keeps the microphone
 * open for the whole session (its speech detector hears everything) and
 * gives each utterance's Dictation a branch of it. A branch can start with
 * the last `replaySamples` samples, so words begun just before it (the user
 * cutting in while a line is said) are not lost. Stopping a branch never
 * closes the microphone; stopping the tee does.
 */
import type { AudioSource } from "./dictation.js";

export class MicTee {
  private readonly branches = new Set<(s: Float32Array) => void>();
  private recent: Float32Array[] = [];
  private recentLength = 0;

  constructor(
    private readonly source: AudioSource,
    private readonly replaySamples: number,
  ) {}

  /** Opens the microphone; `onSamples` gets everything until stop(). */
  start(onSamples: (s: Float32Array) => void): Promise<void> {
    return this.source.start((s) => {
      this.remember(s);
      onSamples(s);
      for (const b of this.branches) b(s);
    });
  }

  stop(): void {
    this.branches.clear();
    this.source.stop();
  }

  /** A listener as an AudioSource (for a Dictation); `replay`: it starts with the most recent samples. */
  branch(opts: { replay?: boolean } = {}): AudioSource {
    let fn: ((s: Float32Array) => void) | null = null;
    return {
      start: async (onSamples) => {
        if (opts.replay) {
          const all = new Float32Array(this.recentLength);
          let at = 0;
          for (const r of this.recent) {
            all.set(r, at);
            at += r.length;
          }
          const tail = all.subarray(Math.max(0, all.length - this.replaySamples));
          if (tail.length) onSamples(tail);
        }
        fn = onSamples;
        this.branches.add(fn);
      },
      stop: () => {
        if (fn) this.branches.delete(fn);
        fn = null;
      },
    };
  }

  private remember(s: Float32Array): void {
    this.recent.push(s);
    this.recentLength += s.length;
    while (this.recent.length > 1 && this.recentLength - this.recent[0]!.length >= this.replaySamples) {
      this.recentLength -= this.recent.shift()!.length;
    }
  }
}
