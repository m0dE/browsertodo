/**
 * Local todo list: LocalTask records in chrome.storage.local, media blobs in
 * IndexedDB. Works with no cloud at all. The rules (input checks, repeats,
 * how a run changes a task) are in local-task-rules.ts.
 */
import type { RepeatRule, TaskRunResult } from "@browsertodo/shared";
import { base64ToBytes } from "../base64.js";
import type { LocalMediaInfo, UiMediaUpload } from "../ui-protocol.js";
import type { KvDb, KvStore, StorageLike } from "./kv.js";
import {
  afterCrash,
  afterRun,
  byCreated,
  cleanAccount,
  cleanInstructions,
  cleanRepeat,
  cleanTime,
  nextOccurrence,
  nextOccurrenceTask,
  type StoredLocalTask,
} from "./local-task-rules.js";

export const LOCAL_TASKS_KEY = "localTasks";
const MAX_MEDIA_PER_TASK = 10;

export interface MediaRecord {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export interface NewLocalTask {
  instructions: string;
  account?: string | null;
  notBefore?: string | null;
  repeat?: RepeatRule | null;
  media?: UiMediaUpload[];
}

export interface LocalTaskPatch {
  instructions?: string;
  account?: string | null;
  notBefore?: string | null;
  repeat?: RepeatRule | null;
}

export interface LocalStoreOptions {
  db: KvDb;
  now?: () => Date;
  newId?: () => string;
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
}

export function uploadToBlob(m: UiMediaUpload): Blob {
  return new Blob([base64ToBytes(m.dataBase64)], { type: m.type || "application/octet-stream" });
}

export class LocalStore {
  private readonly media: KvStore<MediaRecord>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: LocalStoreOptions) {
    this.media = opts.db.store<MediaRecord>("media");
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /** Called after every change to the task list. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async list(): Promise<StoredLocalTask[]> {
    return this.read();
  }

  async get(id: string): Promise<StoredLocalTask | null> {
    return (await this.read()).find((t) => t.id === id) ?? null;
  }

  /** Tasks for the UI: newest first, each with its media metadata. */
  async listWithMedia(): Promise<(StoredLocalTask & { media: LocalMediaInfo[] })[]> {
    const tasks = await this.read();
    const infos = new Map<string, LocalMediaInfo>();
    for (const { value } of await this.media.list()) infos.set(value.id, { id: value.id, name: value.name, type: value.type, size: value.size });
    return tasks
      .slice()
      .sort((a, b) => byCreated(b, a))
      .map((t) => ({ ...t, media: t.mediaIds.map((id) => infos.get(id)).filter((m): m is LocalMediaInfo => !!m) }));
  }

  async add(input: NewLocalTask): Promise<StoredLocalTask> {
    const instructions = cleanInstructions(input.instructions);
    const account = cleanAccount(input.account);
    const repeat = cleanRepeat(input.repeat);
    let notBefore = cleanTime(input.notBefore);
    if (!notBefore && repeat) notBefore = nextOccurrence(repeat.dailyAt, this.now()).toISOString();
    const uploads = input.media ?? [];
    if (uploads.length > MAX_MEDIA_PER_TASK) throw new Error(`At most ${MAX_MEDIA_PER_TASK} files per task`);
    const mediaIds = await this.putMedia(uploads);
    const now = this.now().toISOString();
    const task: StoredLocalTask = {
      id: this.newId(),
      instructions,
      account,
      mediaIds,
      notBefore,
      priority: 0,
      status: "pending",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAfter: null,
      resultSummary: null,
      resultUrl: null,
      resultScreenshotId: null,
      pauseReason: null,
      failReason: null,
      createdAt: now,
      updatedAt: now,
      repeat,
    };
    await this.mutate((tasks) => [...tasks, task]);
    return task;
  }

  /** Stores uploaded files; returns their ids. */
  async putMedia(uploads: UiMediaUpload[]): Promise<string[]> {
    const ids: string[] = [];
    for (const m of uploads) {
      const blob = uploadToBlob(m);
      const id = this.newId();
      await this.media.put(id, { id, name: m.name || "file", type: blob.type, size: blob.size, blob });
      ids.push(id);
    }
    return ids;
  }

  async getMedia(ids: string[]): Promise<MediaRecord[]> {
    const out: MediaRecord[] = [];
    for (const id of ids) {
      const rec = await this.media.get(id);
      if (!rec) throw new Error(`Attached file ${id} is missing from extension storage`);
      out.push(rec);
    }
    return out;
  }

  /** Edits a task that is not running. */
  async update(id: string, patch: LocalTaskPatch): Promise<StoredLocalTask> {
    const clean: Partial<StoredLocalTask> = {};
    if (patch.instructions !== undefined) clean.instructions = cleanInstructions(patch.instructions);
    if (patch.account !== undefined) clean.account = cleanAccount(patch.account);
    if (patch.notBefore !== undefined) clean.notBefore = cleanTime(patch.notBefore);
    if (patch.repeat !== undefined) clean.repeat = cleanRepeat(patch.repeat);
    return this.updateOne(id, (t) => {
      if (t.status === "running") throw new Error("The task is running; stop it first");
      return { ...t, ...clean, updatedAt: this.now().toISOString() };
    });
  }

  /** Deletes a task and the media no other task uses. */
  async delete(id: string): Promise<boolean> {
    let removed: StoredLocalTask | undefined;
    let rest: StoredLocalTask[] = [];
    await this.mutate((tasks) => {
      removed = tasks.find((t) => t.id === id);
      if (removed?.status === "running") throw new Error("The task is running; stop it first");
      rest = tasks.filter((t) => t.id !== id);
      return rest;
    });
    const gone = removed as StoredLocalTask | undefined;
    if (!gone) return false;
    const inUse = new Set(rest.flatMap((t) => t.mediaIds));
    for (const mid of gone.mediaIds) if (!inUse.has(mid)) await this.media.delete(mid);
    return true;
  }

  /** Puts a failed, paused or finished task back in the queue to run now. */
  async retry(id: string): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => {
      if (t.status === "running") throw new Error("The task is already running");
      return {
        ...t,
        status: "pending",
        attempts: 0,
        // A task that already ran may have acted (e.g. posted) before it stopped;
        // the next run then checks for that before repeating it.
        crashed: t.attempts > 0 && t.status !== "done",
        notBefore: null,
        retryAfter: null,
        pauseReason: null,
        failReason: null,
        updatedAt: this.now().toISOString(),
      };
    });
  }

  /** Pending tasks whose notBefore and retryAfter have passed, oldest first. */
  async due(now = this.now()): Promise<StoredLocalTask[]> {
    const t = now.getTime();
    const passed = (iso: string | null) => !iso || Date.parse(iso) <= t;
    return (await this.read()).filter((x) => x.status === "pending" && passed(x.notBefore) && passed(x.retryAfter)).sort(byCreated);
  }

  /** Earliest future time a pending task becomes due, or null. */
  async nextWakeAt(now = this.now()): Promise<Date | null> {
    let best: number | null = null;
    for (const x of await this.read()) {
      if (x.status !== "pending") continue;
      const at = Math.max(x.notBefore ? Date.parse(x.notBefore) : 0, x.retryAfter ? Date.parse(x.retryAfter) : 0);
      if (at > now.getTime() && (best === null || at < best)) best = at;
    }
    return best === null ? null : new Date(best);
  }

  /** Crash marker: running with attempts+1, persisted before the brain starts. */
  async markStarted(id: string): Promise<StoredLocalTask> {
    return this.updateOne(id, (t) => ({ ...t, status: "running", attempts: t.attempts + 1, updatedAt: this.now().toISOString() }));
  }

  /**
   * Records how a run ended (see afterRun). A repeating task that ends done
   * or failed spawns its next occurrence once.
   */
  async finish(
    id: string,
    result: TaskRunResult,
    opts: { retryAfterMinutes: number },
  ): Promise<{ task: StoredLocalTask; next: StoredLocalTask | null }> {
    let out: StoredLocalTask | null = null;
    let next: StoredLocalTask | null = null;
    const now = this.now();
    await this.mutate((tasks) => {
      const updated = tasks.map((t) => {
        if (t.id !== id) return t;
        let r = afterRun(t, result, now, opts.retryAfterMinutes);
        if ((r.status === "done" || r.status === "failed") && r.repeat && !r.nextId) {
          next = nextOccurrenceTask({ ...r, repeat: r.repeat }, this.newId(), now);
          r = { ...r, nextId: next.id };
        }
        out = r;
        return r;
      });
      return next ? [...updated, next] : updated;
    });
    if (!out) throw new Error(`No task with id ${id}`);
    return { task: out, next };
  }

  /**
   * Crash recovery: tasks left running for longer than maxTaskMinutes + 2
   * go back to pending with the crash marker (or fail when out of attempts).
   * Returns how many were recovered.
   */
  async recoverCrashed(maxTaskMinutes: number): Promise<number> {
    const now = this.now();
    const cutoff = now.getTime() - (maxTaskMinutes + 2) * 60_000;
    let count = 0;
    await this.mutate((tasks) =>
      tasks.map((t) => {
        if (t.status !== "running" || Date.parse(t.updatedAt) > cutoff) return t;
        count++;
        return afterCrash(t, now);
      }),
    );
    return count;
  }

  private storage(): StorageLike {
    return this.opts.storage ?? (chrome.storage.local as unknown as StorageLike);
  }

  private async read(): Promise<StoredLocalTask[]> {
    const got = await this.storage().get(LOCAL_TASKS_KEY);
    const v = got[LOCAL_TASKS_KEY];
    return Array.isArray(v) ? (v as StoredLocalTask[]) : [];
  }

  private async updateOne(id: string, fn: (t: StoredLocalTask) => StoredLocalTask): Promise<StoredLocalTask> {
    let out: StoredLocalTask | null = null;
    await this.mutate((tasks) =>
      tasks.map((t) => {
        if (t.id !== id) return t;
        out = fn(t);
        return out;
      }),
    );
    if (!out) throw new Error(`No task with id ${id}`);
    return out;
  }

  /** Serialized read-modify-write; notifies listeners after a change. */
  private mutate(fn: (tasks: StoredLocalTask[]) => StoredLocalTask[]): Promise<void> {
    const run = this.lock.then(async () => {
      const next = fn(await this.read());
      await this.storage().set({ [LOCAL_TASKS_KEY]: next });
    });
    this.lock = run.catch(() => {});
    return run.then(() => {
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          /* listener errors must not break the store */
        }
      }
    });
  }
}
