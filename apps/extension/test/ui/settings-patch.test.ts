import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, redactSettings, type ExtensionSettings } from "@browsertodo/shared";
import { adjustedFields, buildSettingsPatch, helperStatus, parseNumber } from "../../src/options/settings-patch.js";

const saved: ExtensionSettings = redactSettings({ ...DEFAULT_SETTINGS, anthropicApiKey: "sk-real", runnerKey: "" });

describe("buildSettingsPatch", () => {
  it("is empty when nothing changed", () => {
    const { anthropicApiKey: _a, jevApiKey: _j, runnerKey: _r, ...form } = saved;
    expect(buildSettingsPatch(saved, form, {})).toEqual({});
  });
  it("includes only changed plain fields", () => {
    expect(buildSettingsPatch(saved, { brain: "claude-api", intervalMinutes: 15, cloudEnabled: true }, {})).toEqual({
      brain: "claude-api",
      cloudEnabled: true,
    });
  });
  it("skips undefined (blank number inputs)", () => {
    expect(buildSettingsPatch(saved, { maxToolCalls: undefined }, {})).toEqual({});
  });
  it("secrets: keep is omitted, clear is empty string, set is the trimmed value", () => {
    expect(
      buildSettingsPatch(saved, {}, {
        anthropicApiKey: { mode: "clear" },
        jevApiKey: { mode: "set", value: "  jev-key \n" },
        runnerKey: { mode: "keep" },
      }),
    ).toEqual({ anthropicApiKey: "", jevApiKey: "jev-key" });
  });
  it("does not send a clear for a key that is not set, nor a blank replacement", () => {
    expect(buildSettingsPatch(saved, {}, { runnerKey: { mode: "clear" }, anthropicApiKey: { mode: "set", value: "  " } })).toEqual({});
  });
  it("never leaks redacted markers from the form", () => {
    const form = { anthropicApiKey: "set" } as unknown as Partial<ExtensionSettings>;
    expect(buildSettingsPatch({ ...saved, anthropicApiKey: "" }, form, {})).toEqual({});
  });
});

it("parseNumber", () => {
  expect(parseNumber("")).toBeUndefined();
  expect(parseNumber(" 12 ")).toBe(12);
  expect(parseNumber("0.85")).toBe(0.85);
  expect(parseNumber("abc")).toBeUndefined();
});

it("adjustedFields reports values the background clamped", () => {
  const after = { ...saved, delayMaxSec: 60, maxToolCalls: 500, anthropicApiKey: "set" };
  expect(adjustedFields({ delayMaxSec: 10, maxToolCalls: 500, anthropicApiKey: "sk-new" }, after)).toEqual(["delayMaxSec"]);
});

describe("helperStatus", () => {
  const info = { version: "0.2.0", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "x", ptyAvailable: true };
  it("not connected", () => {
    expect(helperStatus(null)).toMatchObject({ tone: "muted", headline: "Helper not connected" });
    expect(helperStatus(null, "Specified native messaging host not found.")).toMatchObject({
      tone: "bad",
      details: ["Specified native messaging host not found."],
    });
  });
  it("connected with a passing self-test", () => {
    const s = helperStatus({ ...info, selfTest: { ok: true, ms: 4200, at: "t" } });
    expect(s.tone).toBe("ok");
    expect(s.headline).toBe("Helper connected · v0.2.0");
    expect(s.details).toEqual(["Claude Code: C:\\claude.exe", "Self-test passed (4.2 s)"]);
  });
  it("warns on missing claude or a failed self-test", () => {
    expect(helperStatus({ ...info, claudePath: null }).tone).toBe("warn");
    const failed = helperStatus({ ...info, selfTest: { ok: false, error: "not logged in", ms: 1, at: "t" } });
    expect(failed.tone).toBe("warn");
    expect(failed.details).toContain("Self-test failed: not logged in");
  });
});
