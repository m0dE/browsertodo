import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type BrainMode, type HelperInfo } from "@browsertodo/shared";
import { needsHelper, NO_AI, resolveBrain } from "../src/engine/brain-resolver.js";

const base: HelperInfo = { version: "2", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "L" };
const ok: HelperInfo = { ...base, selfTest: { ok: true, ms: 900, at: "2026-09-24T00:00:00Z" } };
const failed: HelperInfo = { ...base, selfTest: { ok: false, error: "not logged in", ms: 900, at: "2026-09-24T00:00:00Z" } };
const noClaude: HelperInfo = { ...base, claudePath: null };
const notTested: HelperInfo = { ...base };
const scripted: HelperInfo = { ...base, brain: "scripted", claudePath: null };

function r(mode: BrainMode, helper: HelperInfo | null, key: boolean, extra: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return resolveBrain({ settings: { ...DEFAULT_SETTINGS, brain: mode, anthropicApiKey: key ? "sk" : "", ...extra }, helper, helperError: helper ? null : "host not found" });
}

describe("resolveBrain", () => {
  it.each([
    // mode, helper, api key, expected
    ["auto", ok, false, "claude-code"],
    ["auto", ok, true, "claude-code"],
    ["auto", scripted, false, "claude-code"],
    ["auto", failed, true, "claude-api"],
    ["auto", noClaude, true, "claude-api"],
    ["auto", notTested, true, "claude-api"],
    ["auto", null, true, "claude-api"],
    ["auto", null, false, null],
    ["auto", failed, false, null],
    ["claude-code", ok, false, "claude-code"],
    ["claude-code", failed, true, null],
    ["claude-code", null, true, null],
    ["claude-api", ok, true, "claude-api"],
    ["claude-api", ok, false, null],
  ] as const)("%s with helper %# -> %s", (mode, helper, key, expected) => {
    expect(r(mode, helper, key).effective).toBe(expected);
  });

  it("explains why nothing is usable", () => {
    const s = r("auto", null, false);
    expect(s.note).toMatch(new RegExp(`^${NO_AI}: .*Helper not connected: host not found`));
    expect(s.helperError).toBe("host not found");
    expect(r("claude-code", failed, true).note).toMatch(/self-test failed: not logged in/);
    expect(r("claude-code", noClaude, true).note).toMatch(/not found/);
    expect(r("claude-api", ok, false).note).toMatch(/No Claude API key/);
    expect(r("auto", failed, true).note).toMatch(/Using the Claude API key/);
    expect(r("auto", ok, false).note).toBeUndefined();
  });

  it("reports hasApiKey and helper info", () => {
    const s = r("auto", ok, true);
    expect(s.hasApiKey).toBe(true);
    expect(s.helper).toBe(ok);
  });

  it("jevActive: needs jevEnabled and a key (or the helper's own key for Claude Code)", () => {
    expect(r("claude-api", ok, true, { jevApiKey: "j" }).jevActive).toBe(true);
    expect(r("claude-api", ok, true, { jevApiKey: "j", jevEnabled: false }).jevActive).toBe(false);
    expect(r("claude-api", { ...ok, jevAvailable: true }, true).jevActive).toBe(false);
    expect(r("claude-code", { ...ok, jevAvailable: true }, false).jevActive).toBe(true);
    expect(r("claude-code", ok, false).jevActive).toBe(false);
    expect(r("auto", null, false, { jevApiKey: "j" }).jevActive).toBe(false);
  });
});

describe("resolveBrain with the browsertodo account", () => {
  const OUT = null;
  const signedOut = { signedIn: false, hostedUsable: false };
  const credit = { signedIn: true, hostedUsable: true };
  const noCredit = { signedIn: true, hostedUsable: false, outOfCredit: true };
  const ra = (mode: BrainMode, account: typeof credit | typeof signedOut | null, helper: HelperInfo | null, key: boolean) =>
    resolveBrain({ settings: { ...DEFAULT_SETTINGS, brain: mode, anthropicApiKey: key ? "sk" : "" }, helper, helperError: helper ? null : "host not found", account });

  it.each([
    // mode, account, helper, own key, expected
    ["auto", credit, ok, true, "browsertodo"],
    ["auto", credit, null, false, "browsertodo"],
    ["auto", noCredit, ok, true, "claude-code"],
    ["auto", noCredit, null, true, "claude-api"],
    ["auto", noCredit, null, false, OUT],
    ["auto", signedOut, ok, false, "claude-code"],
    ["auto", signedOut, null, true, "claude-api"],
    ["auto", null, null, false, OUT],
    ["browsertodo", credit, ok, true, "browsertodo"],
    ["browsertodo", noCredit, ok, true, OUT],
    ["browsertodo", signedOut, ok, true, OUT],
    ["claude-code", credit, ok, false, "claude-code"],
    ["claude-api", credit, ok, true, "claude-api"],
  ] as const)("%s, account %o, helper %#, key %s -> %s", (mode, account, helper, key, expected) => {
    expect(ra(mode, account, helper, key).effective).toBe(expected);
  });

  it("explains what the hosted AI needs", () => {
    expect(ra("browsertodo", signedOut, ok, true).note).toBe("Sign in to use browsertodo AI");
    expect(ra("browsertodo", noCredit, ok, true).note).toMatch(/^Out of usage credit/);
    expect(ra("auto", noCredit, null, false).note).toMatch(/^Out of usage credit: subscribe or top up.*or set a Claude API key/);
    expect(ra("auto", signedOut, null, false).note).toMatch(/sign in for browsertodo AI/);
  });

  it("the hosted AI brings its own Jev (no key needed); off when Jev is switched off", () => {
    expect(ra("auto", credit, null, false).jevActive).toBe(true);
    expect(resolveBrain({ settings: { ...DEFAULT_SETTINGS, jevEnabled: false }, helper: null, account: credit }).jevActive).toBe(false);
  });
});

describe("needsHelper", () => {
  it("only when Claude Code may run: not for an API brain, nor when auto picks the hosted AI", () => {
    const usable = { signedIn: true, hostedUsable: true };
    expect(needsHelper({ brain: "claude-code" }, usable)).toBe(true);
    expect(needsHelper({ brain: "claude-api" }, null)).toBe(false);
    expect(needsHelper({ brain: "browsertodo" }, null)).toBe(false);
    expect(needsHelper({ brain: "auto" }, usable)).toBe(false);
    expect(needsHelper({ brain: "auto" }, { signedIn: true, hostedUsable: false })).toBe(true);
    expect(needsHelper({ brain: "auto" }, null)).toBe(true);
  });
});
