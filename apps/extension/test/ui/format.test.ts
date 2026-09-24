import { describe, expect, it } from "vitest";
import type { UiState } from "../../src/ui-protocol.js";
import { DEFAULT_SETTINGS } from "@browsertodo/shared";
import {
  accountLabel,
  bytesToBase64,
  clockLabel,
  firstLine,
  isoToLocalInput,
  localInputToIso,
  parseRepeatTimes,
  relativeTime,
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
    paused: false,
    terminal: null,
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
  it("datetime-local round trip", () => {
    const iso = localInputToIso("2026-09-25T09:30");
    expect(iso).toBe(new Date(2026, 8, 25, 9, 30).toISOString());
    expect(isoToLocalInput(iso!)).toBe("2026-09-25T09:30");
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
