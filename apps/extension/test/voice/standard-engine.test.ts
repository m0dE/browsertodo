import { describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS } from "@browsertodo/shared";
import type { AudioSource } from "../../src/voice/dictation.js";
import type { EngineEvents } from "../../src/voice/engine.js";
import { HANDS_FREE } from "../../src/voice/hands-free.js";
import { StandardEngine } from "../../src/voice/standard-engine.js";

class FakeMic implements AudioSource {
  deliver: ((s: Float32Array) => void) | null = null;
  async start(onSamples: (s: Float32Array) => void): Promise<void> {
    this.deliver = onSamples;
  }
  stop(): void {
    this.deliver = null;
  }
  /** `ms` of a voice-like tone (loud) or near silence, in 20 ms chunks. */
  play(ms: number, loud: boolean): void {
    const n = Math.round((VOICE_LIMITS.sampleRate * 20) / 1000);
    for (let t = 0; t < ms; t += 20) {
      const chunk = new Float32Array(n);
      for (let i = 0; i < n; i++) chunk[i] = loud ? 0.3 * Math.sin((2 * Math.PI * 220 * (t * 16 + i)) / VOICE_LIMITS.sampleRate) : 0.0005 * Math.sin(i);
      this.deliver?.(chunk);
    }
  }
}

function events(): EngineEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    speech: () => void log.push("speech"),
    heard: (text, forward) => void log.push(`heard:${text}:${forward}`),
    partial: () => {},
    level: () => {},
    narrating: () => {},
    said: () => void log.push("said"),
    narratorText: () => {},
    forward: () => {},
    cancelRequest: () => false,
    stopTask: async () => "",
    endVoice: () => {},
    failed: (err) => void log.push(`failed:${String(err)}`),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(speaking = false) {
  const mic = new FakeMic();
  const ev = events();
  const speaker = { speaking, speak: vi.fn(async () => {}), cancel: vi.fn() };
  const transcribe = vi.fn(async () => "open gmail");
  const engine = new StandardEngine({ createSource: () => mic, transcribe, speaker, events: ev });
  return { mic, ev, speaker, transcribe, engine };
}

describe("StandardEngine", () => {
  it("an utterance followed by a pause is reported once as speech, then heard (for the agent)", async () => {
    const { mic, ev, engine } = setup();
    await engine.start();
    engine.setTranscribing(true);
    await settle();
    mic.play(300, false);
    mic.play(900, true);
    expect(ev.log).toEqual(["speech"]);
    mic.play(1500, false);
    await settle();
    await settle();
    expect(ev.log).toEqual(["speech", "heard:open gmail:true"]);
    engine.stop();
  });

  it("while a line is said nothing is transcribed; only speech longer than HANDS_FREE.bargeInMs is reported (barge-in)", async () => {
    const { mic, ev, engine, transcribe } = setup(true);
    await engine.start();
    engine.setTranscribing(false);
    mic.play(HANDS_FREE.bargeInMs - 100, true);
    mic.play(1500, false);
    expect(ev.log).toEqual([]);
    mic.play(HANDS_FREE.bargeInMs + 100, true);
    expect(ev.log).toEqual(["speech"]);
    mic.play(1500, false);
    await settle();
    expect(transcribe).not.toHaveBeenCalled();
    engine.stop();
  });

  it("says lines; a line cut off by hush (or a newer line) does not report its end", async () => {
    const { ev, engine, speaker } = setup();
    let finish!: () => void;
    speaker.speak.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    engine.speak("Opening x.com");
    engine.hush();
    finish();
    await settle();
    expect(ev.log).toEqual([]);
    engine.speak("Done.");
    await settle();
    expect(ev.log).toEqual(["said"]);
    expect(speaker.cancel).toHaveBeenCalled();
  });
});
