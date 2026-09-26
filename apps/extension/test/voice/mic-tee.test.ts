import { describe, expect, it, vi } from "vitest";
import type { AudioSource } from "../../src/voice/dictation.js";
import { MicTee } from "../../src/voice/mic-tee.js";

class FakeMic implements AudioSource {
  deliver: ((s: Float32Array) => void) | null = null;
  starts = 0;
  stops = 0;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.starts++;
    this.deliver = onSamples;
  }
  stop(): void {
    this.stops++;
    this.deliver = null;
  }
}

const chunk = (...v: number[]) => Float32Array.from(v);

describe("MicTee: one microphone for the speech detector and each utterance's dictation", () => {
  it("opens the microphone once; every branch gets the samples while it is started", async () => {
    const mic = new FakeMic();
    const tee = new MicTee(mic, 4);
    const all = vi.fn();
    await tee.start(all);
    const branch = tee.branch();
    const got: number[] = [];
    await branch.start((s) => got.push(...s));
    mic.deliver!(chunk(1, 2));
    branch.stop();
    mic.deliver!(chunk(3));
    expect(got).toEqual([1, 2]);
    expect(all.mock.calls.map((c) => [...c[0]])).toEqual([[1, 2], [3]]);
    expect(mic.starts).toBe(1);
    // A branch stopping never closes the microphone; the tee does.
    expect(mic.stops).toBe(0);
    tee.stop();
    expect(mic.stops).toBe(1);
  });

  it("a branch started with replay first gets the last few samples (the start of words said just before)", async () => {
    const mic = new FakeMic();
    const tee = new MicTee(mic, 4);
    await tee.start(() => {});
    mic.deliver!(chunk(1, 2, 3));
    mic.deliver!(chunk(4, 5, 6));
    const got: number[] = [];
    await tee.branch({ replay: true }).start((s) => got.push(...s));
    mic.deliver!(chunk(7));
    expect(got).toEqual([3, 4, 5, 6, 7]);
  });
});
