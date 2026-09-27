import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { RECENT_CHATS_SHOWN, recentChatsView } from "../../src/sidepanel/recent-chats.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function chat(id: string, minAgo: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Chat ${id}`, brain: "claude-api", jev: false, startedAt: ago(minAgo + 2), endedAt: ago(minAgo), outcome: "done", ...extra };
}

describe("recentChatsView", () => {
  it("running chats first, then the newest, at most RECENT_CHATS_SHOWN", () => {
    const listed = Array.from({ length: 10 }, (_, i) => chat(`c${i}`, (i + 1) * 30));
    const live: SessionInfo = { ...chat("c7", 0), endedAt: undefined, outcome: undefined, title: "Schedule 3x daily X posts" };
    const rows = recentChatsView(listed, [live], NOW);
    expect(rows).toHaveLength(RECENT_CHATS_SHOWN);
    expect(rows[0]).toMatchObject({ running: true, when: "now", where: "another tab", title: "Schedule 3x daily X posts", chip: { label: "running", tone: "accent" } });
    expect(rows.slice(1).map((r) => r.session.sessionId)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("says when, how it ended and the site it ended on", () => {
    const [done, paused, failed] = recentChatsView(
      [
        chat("a", 5, { url: "https://www.x.com/alpha/status/1" }),
        chat("b", 180, { outcome: "paused", url: "chrome://settings" }),
        chat("c", 3 * 24 * 60, { outcome: "failed" }),
      ],
      [],
      NOW,
    );
    expect(done).toMatchObject({ when: "5 min ago", where: "x.com", chip: { label: "done", tone: "ok" } });
    expect(paused).toMatchObject({ when: "3 h ago", where: "", chip: { label: "needs you", tone: "warn" } });
    expect(failed).toMatchObject({ when: "3 days ago", chip: { label: "failed", tone: "bad" } });
  });

  it("a chat that never ended and is not running shows as stopped", () => {
    const [r] = recentChatsView([chat("a", 10, { endedAt: undefined, outcome: undefined })], [], NOW);
    expect(r).toMatchObject({ running: false, chip: { label: "stopped" } });
  });

  it("a running TODO run is not a chat to offer", () => {
    const run: SessionInfo = { ...chat("t", 0), source: "local", taskId: "t1", endedAt: undefined, outcome: undefined };
    expect(recentChatsView([chat("a", 10)], [run], NOW).map((r) => r.session.sessionId)).toEqual(["a"]);
  });

  it("an empty request's chat (look at this page) still has a name", () => {
    expect(recentChatsView([chat("a", 1, { title: "" })], [], NOW)[0]!.title).toBe("Look at this page");
  });

  it("nothing to offer: no rows", () => {
    expect(recentChatsView([], [], NOW)).toEqual([]);
  });
});
