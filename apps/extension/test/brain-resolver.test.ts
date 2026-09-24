import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type BrainMode, type HelperInfo } from "@browsertodo/shared";
import { resolveBrain } from "../src/engine/brain-resolver.js";

const base: HelperInfo = { version: "2", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "L", ptyAvailable: true };
const ok: HelperInfo = { ...base, selfTest: { ok: true, ms: 900, at: "2026-09-24T00:00:00Z" } };
const failed: HelperInfo = { ...base, selfTest: { ok: false, error: "not logged in", ms: 900, at: "2026-09-24T00:00:00Z" } };
const noClaude: HelperInfo = { ...base, claudePath: null };
const notTested: HelperInfo = { ...base };
const scripted: HelperInfo = { ...base, claudePath: "scripted" };

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
    expect(s.note).toMatch(/No brain available.*Helper not connected: host not found/);
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
