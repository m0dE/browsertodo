import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { canOpenInChat, chatActions } from "../../src/sidepanel/chat-actions.js";
import { chipHint, taskChip } from "@browsertodo/shared";
import { runNowButton } from "../../src/sidepanel/format.js";
import { savedTab, tabHasComposer } from "../../src/sidepanel/tabs.js";

describe("tabs", () => {
  it("opens Chat by default and migrates the old saved names", () => {
    expect(savedTab(null)).toBe("chat");
    expect(savedTab("")).toBe("chat");
    expect(savedTab("activity")).toBe("chat");
    expect(savedTab("tasks")).toBe("todo");
    expect(savedTab("todo")).toBe("todo");
    expect(savedTab("history")).toBe("history");
    expect(savedTab("settings")).toBe("chat");
  });
  it("has the composer under Chat and TODO only", () => {
    expect(tabHasComposer("chat")).toBe(true);
    expect(tabHasComposer("todo")).toBe(true);
    expect(tabHasComposer("history")).toBe(false);
  });
});

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: "s1",
  source: "adhoc",
  title: "Post gm",
  brain: "claude-code",
  jev: false,
  startedAt: "2026-09-24T10:00:00Z",
  ...extra,
});

describe("chat action bar", () => {
  it("disables everything with a reason on an empty chat", () => {
    const a = chatActions(null, new Set());
    for (const x of [a.newChat, a.showTab, a.rawLog]) {
      expect(x.disabled).toBe(true);
      expect(x.title).not.toBe("");
    }
  });
  it("Show tab only while the chat's turn runs", () => {
    expect(chatActions(session(), new Set(["s1"])).showTab.disabled).toBe(false);
    const ended = chatActions(session({ endedAt: "2026-09-24T10:05:00Z" }), new Set());
    expect(ended.showTab).toEqual({ disabled: true, title: expect.stringContaining("only has one while it is working") });
    expect(ended.newChat.disabled).toBe(false);
  });
  it("Raw log only for Claude Code runs with a log", () => {
    expect(chatActions(session({ logPath: "C:\runs\s1\log.jsonl" }), new Set()).rawLog.disabled).toBe(false);
    expect(chatActions(session(), new Set()).rawLog).toEqual({ disabled: true, title: "No raw log was recorded for this chat" });
    const api = chatActions(session({ brain: "claude-api" }), new Set(["s1"])).rawLog;
    expect(api.disabled).toBe(true);
    expect(api.title).toContain("Claude API");
  });
  it("cloud runs cannot be opened in Chat", () => {
    expect(canOpenInChat({ source: "adhoc" })).toBe(true);
    expect(canOpenInChat({ source: "local" })).toBe(true);
    expect(canOpenInChat({ source: "cloud" })).toBe(false);
  });
});

describe("Run now", () => {
  const NOW = Date.parse("2026-09-24T10:00:00Z");
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const pending = (notBefore: string | null = null, retryAfter: string | null = null) => ({ status: "pending" as const, notBefore, retryAfter });
  const settings = { intervalMinutes: 15, cloudEnabled: false };

  it("is enabled when a local task is due, and names the check interval", () => {
    expect(runNowButton([pending()], settings, NOW)).toEqual({
      disabled: false,
      title: "Run the tasks whose time has come, instead of waiting for the next check (every 15 minutes)",
    });
    expect(runNowButton([pending(at(-5))], { ...settings, intervalMinutes: 1 }, NOW).title).toContain("(every 1 minute)");
  });
  it("is disabled when nothing is due", () => {
    const off = { disabled: true, title: "Nothing is waiting to run" };
    expect(runNowButton([], settings, NOW)).toEqual(off);
    expect(runNowButton([pending(at(30)), pending(null, at(5)), { status: "paused", notBefore: null, retryAfter: null }], settings, NOW)).toEqual(off);
  });
  it("stays enabled with cloud sync (its queue is unknown here)", () => {
    const b = runNowButton([], { ...settings, cloudEnabled: true }, NOW);
    expect(b.disabled).toBe(false);
    expect(b.title).toContain("and check the cloud queue");
  });
});

describe("chip hints", () => {
  it("explains every task chip", () => {
    for (const status of ["pending", "running", "done", "failed", "paused", "cancelled"] as const) {
      expect(chipHint(taskChip({ status, notBefore: null, retryAfter: null }).label)).not.toBe("");
    }
    expect(chipHint("retry")).not.toBe("");
    expect(chipHint("scheduled")).not.toBe("");
  });
});
