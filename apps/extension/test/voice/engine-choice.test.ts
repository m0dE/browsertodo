import { describe, expect, it } from "vitest";
import type { VoiceEngine } from "@browsertodo/shared";
import { chooseEngine, costPerMinuteText, LOW_CREDIT_MINUTES } from "../../src/voice/engine-choice.js";

const engine = (id: "realtime" | "standard", cents: number, available = true): VoiceEngine => ({
  id,
  name: id === "realtime" ? "Realtime (OpenAI)" : "Standard",
  model: id === "realtime" ? "gpt-realtime-2.1" : "whisper",
  approxCentsPerMinute: cents,
  assumption: "half talking, half listening",
  available,
});
const list = (...engines: VoiceEngine[]) => ({ engines, default: "realtime" as const });
const ENGINES = list(engine("realtime", 30), engine("standard", 0.2));

describe("chooseEngine", () => {
  it("uses the engine picked in Settings", () => {
    expect(chooseEngine({ preferred: "realtime", engines: ENGINES, creditCents: 1000 })).toEqual({ engine: "realtime", note: null });
    expect(chooseEngine({ preferred: "standard", engines: ENGINES, creditCents: 1000 })).toEqual({ engine: "standard", note: null });
  });

  it("falls back to Standard when the server cannot run Realtime", () => {
    const r = chooseEngine({ preferred: "realtime", engines: list(engine("realtime", 30, false), engine("standard", 0.2)), creditCents: 1000 });
    expect(r.engine).toBe("standard");
    expect(r.note).toBe("Realtime voice isn't available right now, so this uses Standard voice.");
    expect(chooseEngine({ preferred: "realtime", engines: list(engine("standard", 0.2)), creditCents: 1000 }).engine).toBe("standard");
    // The server's default says so too.
    expect(chooseEngine({ preferred: "realtime", engines: { ...ENGINES, default: "standard" }, creditCents: 1000 }).engine).toBe("standard");
  });

  it(`falls back to Standard when the credit left pays for less than ${LOW_CREDIT_MINUTES} minutes of Realtime`, () => {
    const low = chooseEngine({ preferred: "realtime", engines: ENGINES, creditCents: 30 * LOW_CREDIT_MINUTES - 1 });
    expect(low).toEqual({ engine: "standard", note: "Your usage credit is low, so this uses Standard voice (it costs much less)." });
    expect(chooseEngine({ preferred: "realtime", engines: ENGINES, creditCents: 30 * LOW_CREDIT_MINUTES }).engine).toBe("realtime");
  });

  it("without the engine list or the credit, tries Realtime (the relay says if it cannot)", () => {
    expect(chooseEngine({ preferred: "realtime", engines: null, creditCents: undefined })).toEqual({ engine: "realtime", note: null });
  });
});

describe("costPerMinuteText: the cost from the server's numbers", () => {
  it("says the approximate usage credit a minute", () => {
    expect(costPerMinuteText(30)).toBe("about 30¢ of usage credit a minute");
    expect(costPerMinuteText(125)).toBe("about $1.25 of usage credit a minute");
    expect(costPerMinuteText(0.42)).toBe("about 0.42¢ of usage credit a minute");
    expect(costPerMinuteText(0.004)).toBe("under 0.01¢ of usage credit a minute");
  });
});
