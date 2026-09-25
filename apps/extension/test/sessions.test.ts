import { describe, expect, it } from "vitest";
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { MemoryKvDb } from "../src/engine/kv.js";
import { MAX_EVENTS_PER_SESSION, MAX_SESSIONS, SessionStore } from "../src/engine/sessions.js";

const info = (id: string, startedAt: string): SessionInfo => ({ sessionId: id, source: "adhoc", title: id, brain: "claude-api", jev: false, startedAt });

describe("SessionStore", () => {
  it("stores sessions and events in order and pushes them live", async () => {
    const store = new SessionStore(new MemoryKvDb(), { now: () => new Date("2026-09-24T10:00:00Z") });
    const pushed: string[] = [];
    store.subscribe({ onEvent: (e) => pushed.push(`e:${e.type}`), onSession: (s) => pushed.push(`s:${s.outcome ?? "running"}`) });
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    store.append("a", { type: "status", text: "one" });
    store.append("a", { type: "tool_result", id: "1", name: "screenshot", thumbnail: "x".repeat(300_000) });
    await store.update("a", { outcome: "done", endedAt: "2026-09-24T10:01:00Z" });
    const events = await store.eventsOf("a");
    expect(events.map((e) => e.type)).toEqual(["status", "tool_result"]);
    expect(events[0]).toEqual({ type: "status", text: "one", ts: "2026-09-24T10:00:00.000Z", sessionId: "a" });
    expect((events[1] as Extract<StampedAgentEvent, { type: "tool_result" }>).thumbnail).toBeUndefined();
    expect(pushed).toEqual(["s:running", "e:status", "e:tool_result", "s:done"]);
    expect(await store.get("a")).toMatchObject({ outcome: "done" });
  });

  it("reopen starts the next turn: events append after the stored ones, latest-turn fields are cleared", async () => {
    const db = new MemoryKvDb();
    const store = new SessionStore(db);
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    store.append("a", { type: "status", text: "one" });
    store.append("a", { type: "task_end", outcome: "done", summary: "s" });
    await store.update("a", { outcome: "done", endedAt: "2026-09-24T10:01:00Z", summary: "s", url: "u", reason: "r" });
    // A new store (the service worker restarted) knows nothing of the sequence.
    const next = new SessionStore(db);
    const pushed: SessionInfo[] = [];
    next.subscribe({ onSession: (s) => pushed.push(s) });
    const s = await next.reopen("a", { turns: 2, startedAt: "2026-09-24T10:05:00Z" });
    expect(s).toEqual({ ...info("a", "2026-09-24T10:05:00Z"), turns: 2 });
    expect(pushed).toEqual([s]);
    next.append("a", { type: "user_message", text: "two" });
    const events = await next.eventsOf("a");
    expect(events.map((e) => e.type)).toEqual(["status", "task_end", "user_message"]);
    expect(await next.reopen("nope")).toBeNull();
  });

  it("keeps the last MAX_EVENTS_PER_SESSION events", async () => {
    const store = new SessionStore(new MemoryKvDb());
    await store.create(info("a", "2026-09-24T10:00:00Z"));
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 5; i++) store.append("a", { type: "status", text: String(i) });
    const events = await store.eventsOf("a");
    expect(events).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(events[0]).toMatchObject({ text: "5" });
  });

  it("keeps the newest MAX_SESSIONS sessions and lists newest first", async () => {
    const db = new MemoryKvDb();
    const store = new SessionStore(db);
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      const id = `s${String(i).padStart(3, "0")}`;
      await store.create(info(id, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
      store.append(id, { type: "status", text: "x" });
    }
    const list = await store.list(1000);
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list[0]!.sessionId).toBe(`s${MAX_SESSIONS + 2}`);
    expect(await store.get("s000")).toBeNull();
    expect(await store.eventsOf("s000")).toEqual([]);
    expect(await store.list(2)).toHaveLength(2);
  });
});
