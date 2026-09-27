import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { chatActions } from "../../src/sidepanel/chat-actions.js";
import { chipHint, taskChip } from "@browsertodo/shared";
import { runDueButton } from "../../src/sidepanel/format.js";
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
    for (const x of [a.newChat, a.showTab, a.raw]) {
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
  it("Raw for any conversation on screen, running or ended", () => {
    expect(chatActions(session(), new Set(["s1"])).raw.disabled).toBe(false);
    expect(chatActions(session({ endedAt: "2026-09-24T10:05:00Z" }), new Set()).raw.disabled).toBe(false);
  });
  it("three actions: New chat, Show tab and Raw", () => {
    expect(Object.keys(chatActions(session(), new Set()))).toEqual(["newChat", "showTab", "raw"]);
  });
});

describe("Run due (N)", () => {
  const NOW = Date.parse("2026-09-24T10:00:00Z");
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const pending = (notBefore: string | null = null, retryAfter: string | null = null) => ({ status: "pending" as const, notBefore, retryAfter });
  const settings = { intervalMinutes: 15, cloudEnabled: false };

  it("counts the tasks the next check would start, and names the check interval", () => {
    expect(runDueButton([pending(), pending(at(-5)), pending(at(30))], settings, NOW)).toEqual({
      hidden: false,
      count: 2,
      label: "Run due (2)",
      title: "Run the 2 tasks whose time has come now, instead of waiting for the next check (every 15 minutes)",
    });
    expect(runDueButton([pending(at(-5))], { ...settings, intervalMinutes: 1 }, NOW).title).toContain("(every 1 minute)");
  });
  it("is hidden when nothing is due", () => {
    const b = runDueButton([pending(at(30)), pending(null, at(5)), { status: "paused", notBefore: null, retryAfter: at(-5) }], settings, NOW);
    expect(b).toMatchObject({ hidden: true, count: 0, label: "Run due" });
    expect(runDueButton([], settings, NOW).hidden).toBe(true);
  });
  it("the account's queue also takes paused tasks whose retry time came (as its claim does)", () => {
    expect(runDueButton([{ status: "paused", notBefore: null, retryAfter: at(-5) }], settings, NOW, true)).toMatchObject({ hidden: false, count: 1 });
  });
  it("stays usable with cloud sync (its queue is unknown here)", () => {
    const b = runDueButton([], { ...settings, cloudEnabled: true }, NOW);
    expect(b).toMatchObject({ hidden: false, count: 0, label: "Run due" });
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
