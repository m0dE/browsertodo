import { beforeEach, describe, expect, it } from "vitest";
import { MAX_MEMORY_ENTRIES, MAX_RECORD_NOTES, MAX_TASK_NOTES, MAX_TASK_RECORDS, type MemoryEntry } from "@browsertodo/shared";
import { MEMORY_STORAGE_KEY, MemoryRefusal, MemoryStore } from "../../src/memory/store.js";
import { memoryStorage } from "./fakes.js";

const CHAT = { kind: "chat" as const, sessionId: "s1", title: "Check my inbox" };
let storage: ReturnType<typeof memoryStorage>;
let now: Date;
let ids: number;
let store: MemoryStore;

beforeEach(() => {
  storage = memoryStorage();
  now = new Date("2026-09-26T10:00:00Z");
  ids = 0;
  store = new MemoryStore({ storage, now: () => now, newId: () => `m${++ids}` });
});

describe("MemoryStore", () => {
  it("keeps an entry with where it came from and when it was learned", async () => {
    const { before, after } = await store.put({ kind: "account", subject: "Work email", text: "admin@runhq.io, Google /u/2", scope: "global" }, CHAT);
    expect(before).toBeNull();
    expect(after).toMatchObject({ id: "m1", kind: "account", scope: "global", source: CHAT, learnedAt: now.toISOString(), updatedAt: now.toISOString() });
    expect(await store.list()).toEqual([after]);
  });

  it("replaces the entry of the same kind, subject and place (a correction), keeping its id and learnedAt", async () => {
    await store.put({ kind: "playbook", subject: "Compose button", text: "top left", scope: "domain", domain: "mail.google.com" }, CHAT);
    now = new Date("2026-09-27T10:00:00Z");
    const { before, after } = await store.put({ kind: "playbook", subject: "compose  BUTTON", text: "moved: bottom right", scope: "domain", domain: "mail.google.com" }, CHAT);
    expect(before?.text).toBe("top left");
    expect(after).toMatchObject({ id: "m1", text: "moved: bottom right", learnedAt: "2026-09-26T10:00:00.000Z", updatedAt: "2026-09-27T10:00:00.000Z" });
    expect(await store.list()).toHaveLength(1);
    // Another site's entry with the same subject is its own.
    await store.put({ kind: "playbook", subject: "Compose button", text: "left rail", scope: "domain", domain: "x.com" }, CHAT);
    expect(await store.list()).toHaveLength(2);
  });

  it("refuses secrets on every write: the agent's, the user's edit and a restore", async () => {
    await expect(store.put({ kind: "account", subject: "Bank", text: "password: hunter22", scope: "global" }, CHAT)).rejects.toBeInstanceOf(MemoryRefusal);
    const { after } = await store.put({ kind: "account", subject: "Bank", text: "login is in Site logins", scope: "global" }, CHAT);
    await expect(store.edit(after!.id, { subject: "Bank", text: "the code is 482913" })).rejects.toThrow(/one-time code/);
    await expect(store.restore("m9", { ...after!, id: "m9", text: "PIN: 4821" })).rejects.toBeInstanceOf(MemoryRefusal);
    expect((await store.list()).map((e) => e.text)).toEqual(["login is in Site logins"]);
    // Nothing secret reached storage.
    expect(JSON.stringify(storage.data)).not.toMatch(/hunter22|482913|4821/);
  });

  it("refuses what breaks the limits", async () => {
    await expect(store.put({ kind: "person", subject: "a long name ".repeat(8), text: "t", scope: "global" }, CHAT)).rejects.toThrow(/subject/);
  });

  it("adds every run note, and keeps only a task's newest MAX_TASK_NOTES", async () => {
    for (let i = 0; i < MAX_TASK_NOTES + 2; i++) {
      now = new Date(Date.UTC(2026, 8, 1 + i));
      await store.put({ kind: "task", subject: "Run note", text: `posted topic ${i}`, scope: "task", taskKey: "tA" }, CHAT, { note: true });
    }
    await store.put({ kind: "task", subject: "Run note", text: "other task", scope: "task", taskKey: "tB" }, CHAT, { note: true });
    const notes = (await store.list()).filter((e) => e.taskKey === "tA");
    expect(notes).toHaveLength(MAX_TASK_NOTES);
    expect(notes.map((e) => e.text)).not.toContain("posted topic 0");
    expect(notes.map((e) => e.text)).toContain(`posted topic ${MAX_TASK_NOTES + 1}`);
    expect((await store.list()).some((e) => e.taskKey === "tB")).toBe(true);
  });

  it("forget, restore (Undo) and clear", async () => {
    const { after } = await store.put({ kind: "person", subject: "Paul Lee", text: "my accountant", scope: "global" }, CHAT);
    const change = await store.forget(after!.id);
    expect(change).toEqual({ before: after, after: null });
    expect(await store.forget(after!.id)).toBeNull();
    await store.restore(after!.id, change!.before);
    expect(await store.get(after!.id)).toEqual(after);
    await store.put({ kind: "preference", subject: "Tone", text: "friendly", scope: "global" }, CHAT);
    expect(await store.clear()).toBe(2);
    expect(await store.list()).toEqual([]);
  });

  it("marks entries used (staleness) without telling listeners", async () => {
    const { after } = await store.put({ kind: "preference", subject: "Tone", text: "friendly", scope: "global" }, CHAT);
    let heard = 0;
    store.onChange(() => heard++);
    now = new Date("2026-09-28T10:00:00Z");
    await store.touch([after!.id]);
    expect((await store.get(after!.id))?.lastUsedAt).toBe("2026-09-28T10:00:00.000Z");
    expect(heard).toBe(0);
  });

  it("past MAX_MEMORY_ENTRIES, drops the entries used longest ago", async () => {
    const old: MemoryEntry[] = Array.from({ length: MAX_MEMORY_ENTRIES }, (_, i) => ({
      id: `o${i}`,
      kind: "person",
      subject: `Person ${i}`,
      text: "someone",
      scope: "global",
      source: CHAT,
      learnedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    storage.data[MEMORY_STORAGE_KEY] = old;
    await store.put({ kind: "person", subject: "New person", text: "just met", scope: "global" }, CHAT);
    const ids = (await store.list()).map((e) => e.id);
    expect(ids).toHaveLength(MAX_MEMORY_ENTRIES);
    expect(ids).not.toContain("o0");
    expect(ids).toContain("m1");
  });

  it("drops stored entries that no longer pass the schema", async () => {
    storage.data[MEMORY_STORAGE_KEY] = [{ id: "bad" }, { id: "ok", kind: "preference", subject: "Tone", text: "calm", scope: "global", source: CHAT, learnedAt: "x", updatedAt: "x" }];
    expect((await store.list()).map((e) => e.id)).toEqual(["ok"]);
  });

  describe("a task's records", () => {
    const TASK = { kind: "task" as const, title: "Work through the queue" };
    const rec = (key: string, text: string, taskKey = "tA") => store.putRecord({ taskKey, taskTitle: "Work through the queue", key, keyAsWritten: key, text }, TASK);

    it("files a fact under its key: the first is the summary, later ones dated notes; the same text adds nothing", async () => {
      const first = await rec("ada@example.com", "Prefers email over phone.");
      expect(first.before).toBeNull();
      expect(first.after).toMatchObject({ kind: "task", scope: "task", taskKey: "tA", key: "ada@example.com", text: "Prefers email over phone." });
      expect(first.after!.notes).toBeUndefined();
      now = new Date("2026-09-27T10:00:00Z");
      const second = await rec("ada@example.com", "Asked about the March invoice.");
      expect(second.after).toMatchObject({ id: first.after!.id, text: "Prefers email over phone.", notes: [{ at: now.toISOString(), text: "Asked about the March invoice." }] });
      const again = await rec("ada@example.com", "asked about the march invoice.");
      expect(again.after!.notes).toHaveLength(1);
      // Another task's record for the same key is its own.
      await rec("ada@example.com", "Someone else's history.", "tB");
      expect((await store.list()).filter((e) => e.key === "ada@example.com")).toHaveLength(2);
    });

    it("folds the oldest notes into the summary past MAX_RECORD_NOTES", async () => {
      await rec("48213", "Opened.");
      for (let i = 1; i <= MAX_RECORD_NOTES + 2; i++) {
        now = new Date(Date.UTC(2026, 8, 26 + i));
        await rec("48213", `Step ${i}.`);
      }
      const [r] = await store.list();
      expect(r!.notes).toHaveLength(MAX_RECORD_NOTES);
      expect(r!.text).toBe("Opened. | 2026-09-27: Step 1. | 2026-09-28: Step 2.");
    });

    it("refuses a secret in a record like any other write", async () => {
      await expect(rec("ada@example.com", "her password: hunter22")).rejects.toBeInstanceOf(MemoryRefusal);
      expect(await store.list()).toEqual([]);
      await rec("ada@example.com", "Prefers email.");
      await expect(rec("ada@example.com", "Her PIN: 4821")).rejects.toBeInstanceOf(MemoryRefusal);
      expect(JSON.stringify(storage.data)).not.toMatch(/hunter22|4821/);
    });

    it("caps records per task apart from the rest of memory: neither pushes the other out", async () => {
      const personal: MemoryEntry[] = Array.from({ length: MAX_MEMORY_ENTRIES }, (_, i) => ({
        id: `p${i}`,
        kind: "person",
        subject: `Person ${i}`,
        text: "someone",
        scope: "global",
        source: CHAT,
        learnedAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }));
      const records: MemoryEntry[] = Array.from({ length: MAX_TASK_RECORDS }, (_, i) => ({
        id: `r${i}`,
        kind: "task",
        subject: `Item ${i}`,
        text: "seen",
        scope: "task",
        taskKey: "tA",
        key: `item ${i}`,
        source: TASK,
        learnedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }));
      storage.data[MEMORY_STORAGE_KEY] = [...personal, ...records];
      // A new record: the task's least recently used record goes, every personal entry (older still) stays.
      await rec("item new", "first time");
      let all = await store.list();
      expect(all.filter((e) => e.key !== undefined)).toHaveLength(MAX_TASK_RECORDS);
      expect(all.some((e) => e.id === "r0")).toBe(false);
      expect(all.filter((e) => e.key === undefined)).toHaveLength(MAX_MEMORY_ENTRIES);
      // A new personal entry: the oldest personal entry goes, no record.
      await store.put({ kind: "person", subject: "New person", text: "just met", scope: "global" }, CHAT);
      all = await store.list();
      expect(all.filter((e) => e.key !== undefined)).toHaveLength(MAX_TASK_RECORDS);
      expect(all.filter((e) => e.key === undefined)).toHaveLength(MAX_MEMORY_ENTRIES);
      // A used record counts as recent.
      now = new Date("2026-09-30T00:00:00Z");
      await store.touch(["r1"]);
      await rec("item newer", "first time");
      expect((await store.list()).some((e) => e.id === "r1")).toBe(true);
    });

    it("run notes and records are separate: notes past MAX_TASK_NOTES never drop records", async () => {
      await rec("48213", "Opened.");
      for (let i = 0; i < MAX_TASK_NOTES + 1; i++) await store.put({ kind: "task", subject: "Run note", text: `run ${i}`, scope: "task", taskKey: "tA" }, TASK, { note: true });
      const all = await store.list();
      expect(all.filter((e) => e.key === undefined)).toHaveLength(MAX_TASK_NOTES);
      expect(all.filter((e) => e.key === "48213")).toHaveLength(1);
      // A remember with the subject of a record is not merged into it.
      await store.put({ kind: "task", subject: "48213", text: "a plain task fact", scope: "task", taskKey: "tA" }, TASK);
      expect((await store.list()).filter((e) => e.key === "48213")[0]!.text).toBe("Opened.");
    });

    it("deletes all of one task's memory", async () => {
      await rec("a", "x");
      await rec("b", "y");
      await store.put({ kind: "task", subject: "Run note", text: "run", scope: "task", taskKey: "tA" }, TASK, { note: true });
      await rec("a", "other task", "tB");
      await store.put({ kind: "preference", subject: "Tone", text: "calm", scope: "global" }, CHAT);
      expect(await store.forgetTask("tA")).toBe(3);
      expect((await store.list()).map((e) => e.taskKey ?? e.subject).sort()).toEqual(["Tone", "tB"]);
    });
  });
});
