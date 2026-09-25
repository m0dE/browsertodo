import { describe, expect, it } from "vitest";
import type { UiState } from "../../src/ui-protocol.js";
import { DEFAULT_SETTINGS } from "@browsertodo/shared";
import {
  accountLabel,
  bytesToBase64,
  clockLabel,
  firstLine,
  localInputToIso,
  modelChip,
  modelLabel,
  parseRepeatTimes,
  relativeTime,
  sessionMeta,
  repeatLabel,
  splitTasks,
  statusLine,
  taskChip,
  taskNextTime,
} from "../../src/sidepanel/format.js";

const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime(); // local noon
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 24 + dayOffset, h, m).toISOString();

function state(over: Partial<UiState> = {}, brain: Partial<UiState["brain"]> = {}): UiState {
  return {
    settings: DEFAULT_SETTINGS,
    brain: { effective: "claude-code", helper: null, hasApiKey: false, jevActive: false, ...brain },
    running: null,
    runningSessions: [],
    paused: false,
    openConversations: [],
    ...over,
  };
}

describe("statusLine", () => {
  it("names the brain in use", () => {
    expect(statusLine(state())).toEqual({ tone: "ok", text: "Claude Code" });
    expect(statusLine(state({}, { effective: "claude-api", jevActive: true })).text).toBe("Claude API + Jev");
  });
  it("warns with a settings link when nothing is usable", () => {
    const s = statusLine(state({}, { effective: null, note: "No API key and no helper" }));
    expect(s).toEqual({ tone: "bad", text: "No API key and no helper", action: "settings" });
  });
  it("offers resume when paused", () => {
    const s = statusLine(state({ paused: true, pausedReason: "3 failures in a row" }));
    expect(s).toEqual({ tone: "warn", text: "Runs paused: 3 failures in a row", action: "resume" });
  });
  it("prefers the no-brain warning over paused", () => {
    expect(statusLine(state({ paused: true }, { effective: null })).action).toBe("settings");
  });
});

describe("times", () => {
  it("relativeTime", () => {
    expect(relativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(relativeTime(new Date(NOW + 3 * 3600_000).toISOString(), NOW)).toBe("in 3 h");
    expect(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe("2 d ago");
    expect(relativeTime("nope", NOW)).toBe("");
  });
  it("clockLabel", () => {
    expect(clockLabel(at(14, 30), NOW)).toBe("today 14:30");
    expect(clockLabel(at(9, 5, 1), NOW)).toBe("tomorrow 09:05");
    expect(clockLabel(at(23, 0, -1), NOW)).toBe("yesterday 23:00");
    expect(clockLabel(at(8, 0, 6), NOW)).toBe("Sep 30 08:00");
  });
  it("sessionMeta", () => {
    expect(sessionMeta({ startedAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW)).toBe("started 5 min ago");
    expect(sessionMeta({ startedAt: at(14, 30), endedAt: at(14, 32), outcome: "done", turns: 2 }, NOW)).toBe("today 14:30 · done · 2 messages");
    expect(sessionMeta({ startedAt: at(9, 0), endedAt: at(9, 5), outcome: "paused", turns: 1 }, NOW)).toBe("today 09:00 · needs you");
  });
  it("localInputToIso", () => {
    const iso = localInputToIso("2026-09-25T09:30");
    expect(iso).toBe(new Date(2026, 8, 25, 9, 30).toISOString());
    expect(localInputToIso("")).toBeUndefined();
    expect(localInputToIso("garbage")).toBeUndefined();
  });
});

describe("parseRepeatTimes", () => {
  it("normalizes, sorts and dedupes", () => {
    expect(parseRepeatTimes("18:30, 9:00 09:00;7.15")).toEqual({ ok: true, times: ["07:15", "09:00", "18:30"] });
  });
  it("empty means no repeat", () => {
    expect(parseRepeatTimes("  ")).toEqual({ ok: true, times: [] });
  });
  it("rejects bad times", () => {
    expect(parseRepeatTimes("9:00, 24:00")).toEqual({ ok: false, error: '"24:00" is not a time like 09:30' });
    expect(parseRepeatTimes("noon").ok).toBe(false);
    expect(parseRepeatTimes("9:60").ok).toBe(false);
  });
  it("caps at 24 times", () => {
    const many = Array.from({ length: 25 }, (_, i) => `${Math.floor(i / 2)}:${i % 2 ? "30" : "00"}`).join(",");
    expect(parseRepeatTimes(many).ok).toBe(false);
  });
});

describe("tasks", () => {
  const base = { notBefore: null, retryAfter: null, createdAt: at(8), updatedAt: at(8) };
  it("chips", () => {
    expect(taskChip({ ...base, status: "pending" }, NOW)).toEqual({ label: "due", tone: "accent" });
    expect(taskChip({ ...base, status: "pending", notBefore: at(15) }, NOW).label).toBe("scheduled");
    expect(taskChip({ ...base, status: "pending", retryAfter: at(12, 10) }, NOW).label).toBe("retry");
    expect(taskChip({ ...base, status: "paused" }, NOW).label).toBe("needs you");
    expect(taskChip({ ...base, status: "failed" }, NOW).tone).toBe("bad");
  });
  it("next time is the later of notBefore and retryAfter, only while pending", () => {
    expect(taskNextTime({ status: "pending", notBefore: at(15), retryAfter: at(13) })).toBe(at(15));
    expect(taskNextTime({ status: "pending", notBefore: null, retryAfter: at(13) })).toBe(at(13));
    expect(taskNextTime({ status: "done", notBefore: at(15), retryAfter: null })).toBeNull();
  });
  it("splits active and finished in a useful order", () => {
    const t = (id: string, status: "pending" | "running" | "done" | "failed" | "paused", extra = {}) => ({ id, status, ...base, ...extra });
    const { active, finished } = splitTasks([
      t("later", "pending", { notBefore: at(18) }),
      t("old-done", "done", { updatedAt: at(9) }),
      t("run", "running"),
      t("now", "pending"),
      t("new-fail", "failed", { updatedAt: at(11) }),
      t("ask", "paused"),
    ]);
    expect(active.map((x) => x.id)).toEqual(["run", "ask", "now", "later"]);
    expect(finished.map((x) => x.id)).toEqual(["new-fail", "old-done"]);
  });
  it("labels", () => {
    expect(repeatLabel({ dailyAt: ["09:00", "18:00"] })).toBe("daily 09:00, 18:00");
    expect(repeatLabel(null)).toBe("");
    expect(accountLabel("myhandle")).toBe("@myhandle");
    expect(accountLabel("@myhandle")).toBe("@myhandle");
    expect(accountLabel("Work Gmail")).toBe("Work Gmail");
    expect(accountLabel(null)).toBe("");
  });
  it("firstLine", () => {
    expect(firstLine("\n  Post this\nsecond")).toBe("Post this");
    expect(firstLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

it("bytesToBase64 round-trips large input", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
  expect(decoded).toEqual(bytes);
  expect(bytesToBase64(new TextEncoder().encode("hi!"))).toBe("aGkh");
});

describe("model chip", () => {
  it("names known models and keeps other ids as typed", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel(" claude-custom-9 ")).toBe("claude-custom-9");
    expect(modelLabel("")).toBe("Default model");
  });
  it("adds Jev when it is active for the brain in use", () => {
    expect(modelChip(state()).label).toBe("Sonnet 5");
    expect(modelChip(state({}, { jevActive: true })).label).toBe("Sonnet 5 · Jev");
    expect(modelChip(state({}, { effective: null, jevActive: true })).label).toBe("Sonnet 5");
    const opus = state({ settings: { ...DEFAULT_SETTINGS, anthropicModel: "claude-opus-5-5" } }, { jevActive: true });
    expect(modelChip(opus)).toMatchObject({ label: "Opus 5.5 · Jev", model: "claude-opus-5-5", jevActive: true });
  });
  it("offers the Jev switch only when a key exists somewhere", () => {
    expect(modelChip(state()).jevPossible).toBe(false);
    expect(modelChip(state({ settings: { ...DEFAULT_SETTINGS, jevApiKey: "set" } })).jevPossible).toBe(true);
    const helper = { version: "1", jevAvailable: true, claudePath: "c", logDir: "l", ptyAvailable: true };
    expect(modelChip(state({}, { helper })).jevPossible).toBe(true);
    expect(modelChip(state({}, { jevActive: true })).jevPossible).toBe(true);
    expect(modelChip(state({ settings: { ...DEFAULT_SETTINGS, jevEnabled: false } })).jevEnabled).toBe(false);
  });
});

describe("hosted AI in the status line and the model chip", () => {
  const account = (over: Partial<NonNullable<UiState["account"]>> = {}): NonNullable<UiState["account"]> => ({
    signedIn: true,
    signInConfigured: true,
    apiBase: "https://api.test",
    dashboardUrl: "https://api.test/",
    user: { email: "ada@example.com", name: "Ada", pictureUrl: null },
    credit: { subscriptionCents: 421, topupCents: 1000, totalCents: 1421, periodGrantCents: 500, periodEnd: null },
    ...over,
  });

  it("names browsertodo AI as the brain", () => {
    expect(statusLine(state({ account: account() }, { effective: "browsertodo", jevActive: true }))).toEqual({ tone: "ok", text: "browsertodo AI + Jev" });
  });

  it("out of credit: the status line says so with a Top up action", () => {
    const out = account({ outOfCredit: { topupUrl: "https://api.test/billing" }, credit: { subscriptionCents: 0, topupCents: 0, totalCents: 0, periodGrantCents: 0, periodEnd: null } });
    expect(statusLine(state({ account: out }, { effective: "browsertodo" }))).toEqual({ tone: "warn", text: "Out of AI credit", action: "topup" });
    // Auto fell back to nothing usable: still the credit message.
    expect(statusLine(state({ account: out }, { effective: null, note: "x" })).action).toBe("topup");
    // Another brain runs: credit is not the problem.
    expect(statusLine(state({ account: out }, { effective: "claude-code" })).text).toBe("Claude Code");
  });

  it("the chip shows the hosted model, the credit left, and out of credit", () => {
    const chip = modelChip(state({ account: account() }, { effective: "browsertodo", jevActive: true }));
    expect(chip).toMatchObject({ hosted: true, label: "Sonnet 5 · Jev", credit: "$14.21 AI credit left", outOfCredit: false, jevPossible: true });
    const custom = state({ account: account(), settings: { ...DEFAULT_SETTINGS, anthropicModel: "my-model" } }, { effective: "browsertodo" });
    expect(modelChip(custom)).toMatchObject({ model: "claude-sonnet-5", label: "Sonnet 5" });
    const out = modelChip(state({ account: account({ outOfCredit: { topupUrl: "u" } }) }, { effective: "browsertodo" }));
    expect(out).toMatchObject({ label: "Out of AI credit", outOfCredit: true });
    expect(modelChip(state({ account: account() })).hosted).toBe(false);
  });
});
