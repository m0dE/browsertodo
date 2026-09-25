import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { MemoryKvDb } from "./memory-kv.js";
import { LOCAL_TASKS_KEY, LocalStore } from "../src/engine/local-store.js";
import { MAX_LOCAL_ATTEMPTS, nextOccurrence } from "../src/engine/local-task-rules.js";

/** Local wall-clock date, so the tests pass in any time zone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const b64 = (s: string) => btoa(s);

let chrome: ChromeFake;
let now: Date;
let ids: number;
let store: LocalStore;
let db: MemoryKvDb;

beforeEach(() => {
  chrome = installChromeFake();
  now = local(2026, 9, 24, 10, 0);
  ids = 0;
  db = new MemoryKvDb();
  store = new LocalStore({ db, now: () => now, newId: () => `id${++ids}` });
});

describe("nextOccurrence", () => {
  it("picks the next matching local time later today", () => {
    expect(nextOccurrence(["09:00", "13:30"], local(2026, 9, 24, 10, 0))).toEqual(local(2026, 9, 24, 13, 30));
  });

  it("rolls over to tomorrow when all of today's times passed", () => {
    expect(nextOccurrence(["09:00", "13:30"], local(2026, 9, 24, 14, 0))).toEqual(local(2026, 9, 25, 9, 0));
  });

  it("is strictly after now (an exact match goes to the next one)", () => {
    expect(nextOccurrence(["10:00"], local(2026, 9, 24, 10, 0))).toEqual(local(2026, 9, 25, 10, 0));
  });

  it("handles month and year ends and unsorted times", () => {
    expect(nextOccurrence(["23:59", "00:15"], local(2026, 12, 31, 23, 59))).toEqual(local(2027, 1, 1, 0, 15));
  });
});

describe("LocalStore", () => {
  it("adds tasks with media and lists them newest first with media info", async () => {
    const a = await store.add({ instructions: "  first  ", account: " @me ", media: [{ name: "a.png", type: "image/png", dataBase64: b64("PNGDATA") }] });
    now = new Date(now.getTime() + 1000);
    await store.add({ instructions: "second" });
    expect(a).toMatchObject({ instructions: "first", account: "@me", status: "pending", attempts: 0, mediaIds: ["id1"], repeat: null });
    const listed = await store.listWithMedia();
    expect(listed.map((t) => t.instructions)).toEqual(["second", "first"]);
    expect(listed[1]!.media).toEqual([{ id: "id1", name: "a.png", type: "image/png", size: 7 }]);
    const [rec] = await store.getMedia(["id1"]);
    expect(await rec!.blob.text()).toBe("PNGDATA");
    expect(Array.isArray(chrome.storage.local.data[LOCAL_TASKS_KEY])).toBe(true);
  });

  it("validates input", async () => {
    await expect(store.add({ instructions: "   " })).rejects.toThrow(/empty/);
    await expect(store.add({ instructions: "x", repeat: { dailyAt: ["25:00"] } })).rejects.toThrow(/HH:MM/);
    await expect(store.add({ instructions: "x", notBefore: "not a date" })).rejects.toThrow(/Invalid time/);
  });

  it("a repeating task without a time starts at its next occurrence", async () => {
    const t = await store.add({ instructions: "daily", repeat: { dailyAt: ["18:00", "08:00", "18:00"] } });
    expect(t.repeat).toEqual({ dailyAt: ["08:00", "18:00"] });
    expect(t.notBefore).toBe(local(2026, 9, 24, 18, 0).toISOString());
  });

  it("due: pending, notBefore and retryAfter passed, oldest first", async () => {
    await store.add({ instructions: "future", notBefore: local(2026, 9, 24, 12, 0).toISOString() });
    now = new Date(now.getTime() + 1);
    await store.add({ instructions: "now" });
    now = new Date(now.getTime() + 1);
    await store.add({ instructions: "past", notBefore: local(2026, 9, 24, 9, 0).toISOString() });
    expect((await store.due()).map((t) => t.instructions)).toEqual(["now", "past"]);
    expect((await store.due(local(2026, 9, 24, 12, 0))).map((t) => t.instructions)).toEqual(["future", "now", "past"]);
    expect(await store.nextWakeAt()).toEqual(local(2026, 9, 24, 12, 0));
  });

  it("markStarted persists running + attempts; finish done records the result", async () => {
    const t = await store.add({ instructions: "x" });
    const started = await store.markStarted(t.id);
    expect(started).toMatchObject({ status: "running", attempts: 1 });
    expect(await store.due()).toEqual([]);
    const { task, next } = await store.finish(t.id, { outcome: "done", summary: "posted", url: "https://x.com/me/status/1" }, { retryAfterMinutes: 10 });
    expect(task).toMatchObject({ status: "done", resultSummary: "posted", resultUrl: "https://x.com/me/status/1" });
    expect(next).toBeNull();
  });

  it("retry goes back to pending after retryAfterMinutes, and fails after 5 attempts", async () => {
    const t = await store.add({ instructions: "x" });
    for (let i = 1; i < MAX_LOCAL_ATTEMPTS; i++) {
      await store.markStarted(t.id);
      const { task } = await store.finish(t.id, { outcome: "retry", reason: "usage limit" }, { retryAfterMinutes: 10 });
      expect(task.status).toBe("pending");
      expect(task.retryAfter).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());
      expect(task.failReason).toBe("usage limit");
      expect(await store.due()).toEqual([]);
      now = new Date(now.getTime() + 11 * 60_000);
      expect((await store.due()).map((x) => x.id)).toEqual([t.id]);
    }
    await store.markStarted(t.id);
    const { task } = await store.finish(t.id, { outcome: "retry", reason: "usage limit" }, { retryAfterMinutes: 10 });
    expect(task.status).toBe("failed");
    expect(task.failReason).toMatch(/gave up after 5 attempts/);
  });

  it("paused waits for the user; retry resets it", async () => {
    const t = await store.add({ instructions: "x" });
    await store.markStarted(t.id);
    await store.finish(t.id, { outcome: "paused", reason: "login page" }, { retryAfterMinutes: 10 });
    expect(await store.get(t.id)).toMatchObject({ status: "paused", pauseReason: "login page" });
    expect(await store.due()).toEqual([]);
    const r = await store.retry(t.id);
    expect(r).toMatchObject({ status: "pending", attempts: 0, pauseReason: null });
    // It already ran once, so the next run must check whether it already acted.
    expect(r.crashed).toBe(true);
    expect((await store.due()).map((x) => x.id)).toEqual([t.id]);
  });

  it("retrying a task that never ran is not marked as possibly acted", async () => {
    const t = await store.add({ instructions: "x" });
    expect((await store.retry(t.id)).crashed).toBe(false);
  });

  it("a repeating task spawns its next occurrence once when it ends done or failed", async () => {
    const t = await store.add({ instructions: "daily", repeat: { dailyAt: ["09:00"] }, media: [{ name: "a.png", type: "image/png", dataBase64: b64("x") }] });
    now = local(2026, 9, 25, 9, 1);
    await store.markStarted(t.id);
    const { task, next } = await store.finish(t.id, { outcome: "failed", reason: "nope" }, { retryAfterMinutes: 10 });
    expect(task.status).toBe("failed");
    expect(next).toMatchObject({ status: "pending", attempts: 0, instructions: "daily", mediaIds: t.mediaIds, notBefore: local(2026, 9, 26, 9, 0).toISOString() });
    expect(task.nextId).toBe(next!.id);
    // Retrying and finishing the old one again does not spawn a second copy.
    await store.retry(t.id);
    await store.markStarted(t.id);
    const again = await store.finish(t.id, { outcome: "done" }, { retryAfterMinutes: 10 });
    expect(again.next).toBeNull();
    expect((await store.list()).length).toBe(2);
    // Deleting the history row keeps the media the next occurrence still uses.
    await store.delete(t.id);
    expect((await store.getMedia(next!.mediaIds)).length).toBe(1);
    await store.delete(next!.id);
    await expect(store.getMedia(next!.mediaIds)).rejects.toThrow(/missing/);
  });

  it("retry outcomes of a repeating task do not spawn", async () => {
    const t = await store.add({ instructions: "daily", repeat: { dailyAt: ["09:00"] } });
    await store.markStarted(t.id);
    expect((await store.finish(t.id, { outcome: "retry" }, { retryAfterMinutes: 5 })).next).toBeNull();
  });

  it("update and delete refuse running tasks", async () => {
    const t = await store.add({ instructions: "x" });
    expect(await store.update(t.id, { instructions: "y", account: "@a", repeat: { dailyAt: ["07:00"] } })).toMatchObject({ instructions: "y", account: "@a" });
    await store.markStarted(t.id);
    await expect(store.update(t.id, { instructions: "z" })).rejects.toThrow(/running/);
    await expect(store.delete(t.id)).rejects.toThrow(/running/);
    await expect(store.update("nope", {})).rejects.toThrow(/No task/);
    expect(await store.delete("nope")).toBe(false);
  });

  it("recoverCrashed: old running tasks go back to pending with the crash marker", async () => {
    const a = await store.add({ instructions: "old" });
    const b = await store.add({ instructions: "young" });
    await store.markStarted(a.id);
    now = new Date(now.getTime() + 11 * 60_000);
    await store.markStarted(b.id);
    now = new Date(now.getTime() + 2 * 60_000);
    // maxTaskMinutes 10 -> cutoff 12.5 minutes (the safety timer and its grace): a (13 min) recovers, b (2 min) does not.
    expect(await store.recoverCrashed(10)).toBe(1);
    expect(await store.get(a.id)).toMatchObject({ status: "pending", crashed: true, attempts: 1 });
    expect(await store.get(b.id)).toMatchObject({ status: "running" });
  });

  it("recoverCrashed leaves alone the tasks this worker is still running, however old", async () => {
    const a = await store.add({ instructions: "slow" });
    await store.markStarted(a.id);
    now = new Date(now.getTime() + 60 * 60_000);
    expect(await store.recoverCrashed(10, new Set([a.id]))).toBe(0);
    expect(await store.get(a.id)).toMatchObject({ status: "running" });
  });

  it("recoverCrashed fails a task that is out of attempts", async () => {
    const a = await store.add({ instructions: "old" });
    for (let i = 0; i < MAX_LOCAL_ATTEMPTS; i++) await store.markStarted(a.id);
    now = new Date(now.getTime() + 60 * 60_000);
    await store.recoverCrashed(10);
    expect(await store.get(a.id)).toMatchObject({ status: "failed" });
  });

  it("notifies listeners on change and serializes concurrent writes", async () => {
    let changes = 0;
    store.onChange(() => changes++);
    await Promise.all([store.add({ instructions: "a" }), store.add({ instructions: "b" }), store.add({ instructions: "c" })]);
    expect((await store.list()).length).toBe(3);
    expect(changes).toBe(3);
  });
});
