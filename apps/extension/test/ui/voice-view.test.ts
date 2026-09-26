import { describe, expect, it } from "vitest";
import type { VoiceEngine } from "@browsertodo/shared";
import { voiceView } from "../../src/options/voice-view.js";
import type { AccountView } from "../../src/ui-protocol.js";

const engines: VoiceEngine[] = [
  { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 5.3, assumption: "Per minute of conversation: you talk for 1 minute and it speaks for 18 seconds.", available: true },
  { id: "standard", name: "Standard", model: "whisper", approxCentsPerMinute: 0.05, assumption: "Per minute of speech transcribed.", available: true },
];
const base: AccountView = { signedIn: true, signInConfigured: true, apiBase: "https://api.test", dashboardUrl: "https://api.test/", billingUrl: "https://api.test/billing" };
const PLUS: AccountView = { ...base, plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } };
const FREE: AccountView = { ...base, plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } };

describe("voiceView: the voice engine choice in Settings", () => {
  it("offers Realtime (OpenAI) and Standard, each with its cost a minute from the server", () => {
    const v = voiceView({ engines, selected: "realtime", account: PLUS });
    expect(v.options.map((o) => [o.id, o.label])).toEqual([
      ["realtime", "Realtime (OpenAI)"],
      ["standard", "Standard"],
    ]);
    expect(v.options[0]!.cost).toBe("about 5¢ of usage credit a minute");
    expect(v.options[1]!.cost).toBe("about 0.05¢ of usage credit a minute");
    expect(v.options[0]!.title).toBe("Per minute of conversation: you talk for 1 minute and it speaks for 18 seconds.");
    expect(v.note).toBeNull();
  });

  it("while the prices load, and when they cannot be loaded, says so instead of guessing", () => {
    expect(voiceView({ engines: "loading", selected: "realtime", account: PLUS }).options[0]!.cost).toBe("Loading the price…");
    expect(voiceView({ engines: null, selected: "realtime", account: PLUS }).options[1]!.cost).toBe("The price couldn't be loaded right now.");
  });

  it("an engine the server cannot run says Standard is used instead", () => {
    const v = voiceView({ engines: [{ ...engines[0]!, available: false }, engines[1]!], selected: "realtime", account: PLUS });
    expect(v.options[0]!.cost).toBe("Not available on this server right now: Standard is used instead.");
  });

  it("without a plan that includes voice, says which plans do", () => {
    expect(voiceView({ engines, selected: "realtime", account: FREE }).note).toBe("Voice needs the Plus or Pro plan");
    expect(voiceView({ engines, selected: "realtime", account: { ...base, signedIn: false } }).note).toBe("Voice needs the Plus or Pro plan");
  });
});
