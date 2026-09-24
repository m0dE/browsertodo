/**
 * Local todo list: LocalTask records in chrome.storage.local, media blobs in
 * IndexedDB. Works with no cloud at all.
 */
import { MAX_INSTRUCTIONS_CHARS, RepeatRule, type LocalTask, type TaskRunResult } from "@browsertodo/shared";
import type { LocalMediaInfo, UiMediaUpload } from "../ui-protocol.js";
import type { KvDb, KvStore } from "./kv.js";

export const LOCAL_TASKS_KEY = "localTasks";
/** A local task fails for good after this many attempts. */
export const MAX_LOCAL_ATTEMPTS = 5;
export const MAX_MEDIA_PER_TASK = 10;

/** A stored local task plus bookkeeping the UI may ignore. */
export type StoredLocalTask = LocalTask & {
  /** Set when a previous attempt was interrupted while running (crash, restart). */
  crashed?: boolean;
  /** Id of the next occurrence this (repeating) task already spawned. */
  nextId?: string | null;
};

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

type StorageLike = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

export interface LocalStoreOptions {
  db: KvDb;
  now?: () => Date;
  newId?: () => string;
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
}

/**
 * The next local wall-clock time from dailyAt ("HH:MM", local time zone)
 * strictly after `after`.
 */
export function nextOccurrence(dailyAt: string[], after: Date): Date {
  if (dailyAt.length === 0) throw new Error("repeat rule has no times");
  for (let day = 0; day <= 2; day++) {
    let best: Date | null = null;
    for (const hhmm of dailyAt) {
      const [h, m] = hhmm.split(":").map(Number) as [number, number];
      const cand = new Date(after.getFullYear(), after.getMonth(), after.getDate() + day, h, m, 0, 0);
      if (cand.getTime() > after.getTime() && (!best || cand < best)) best = cand;
    }
    if (best) return best;
  }
  throw new Error("no next occurrence found");
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function uploadToBlob(m: UiMediaUpload): Blob {
  return new Blob([decodeBase64(m.dataBase64)], { type: m.type || "application/octet-stream" });
}

function cleanInstructions(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("Instructions are empty");
  if (t.length > MAX_INSTRUCTIONS_CHARS) throw new Error(`Instructions are longer than ${MAX_INSTRUCTIONS_CHARS} characters`);
  return t;
}

function cleanAccount(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const t = a.trim();
  if (t.length > 100) throw new Error("Account is longer than 100 characters");
  return t || null;
}

function cleanTime(t: unknown): string | null {
  if (t === null || t === undefined || t === "") return null;
  const d = new Date(String(t));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid time: ${String(t)}`);
  return d.toISOString();
}

function cleanRepeat(r: unknown): RepeatRule | null {
  if (r === null || r === undefined) return null;
  const parsed = RepeatRule.safeParse(r);
  if (!parsed.success) throw new Error("Repeat times must be HH:MM (24 h), 1 to 24 of them");
  return { dailyAt: [...new Set(parsed.data.dailyAt)].sort() };
}

const byCreated = (a: StoredLocalTask, b: StoredLocalTask) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

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
   * Records how a run ended. retry: back to pending after retryAfterMinutes
   * (the reason is kept in failReason), or failed once MAX_LOCAL_ATTEMPTS is
   * reached. paused: waits for the user (tasks.retry). A repeating task that
   * ends done or failed spawns its next occurrence once.
   */
  async finish(
    id: string,
    result: TaskRunResult,
    opts: { retryAfterMinutes: number },
  ): Promise<{ task: StoredLocalTask; next: StoredLocalTask | null }> {
    let out: StoredLocalTask | null = null;
    let next: StoredLocalTask | null = null;
    const now = this.now();
    const nowIso = now.toISOString();
    await this.mutate((tasks) => {
      const updated = tasks.map((t) => {
        if (t.id !== id) return t;
        const base: StoredLocalTask = { ...t, updatedAt: nowIso, crashed: false, retryAfter: null };
        let r: StoredLocalTask;
        switch (result.outcome) {
          case "done":
            r = { ...base, status: "done", resultSummary: result.summary ?? null, resultUrl: result.url ?? null, failReason: null, pauseReason: null };
            break;
          case "failed":
            r = { ...base, status: "failed", failReason: result.reason ?? "failed", pauseReason: null };
            break;
          case "paused":
            r = { ...base, status: "paused", pauseReason: result.reason ?? "needs your attention" };
            break;
          default: {
            const reason = result.reason ?? "temporary problem";
            if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
              r = { ...base, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, pauseReason: null };
            } else {
              const retryAfter = new Date(now.getTime() + opts.retryAfterMinutes * 60_000).toISOString();
              r = { ...base, status: "pending", failReason: reason, retryAfter };
            }
          }
        }
        if ((r.status === "done" || r.status === "failed") && r.repeat && !r.nextId) {
          const n: StoredLocalTask = {
            ...r,
            id: this.newId(),
            status: "pending",
            attempts: 0,
            notBefore: nextOccurrence(r.repeat.dailyAt, now).toISOString(),
            retryAfter: null,
            resultSummary: null,
            resultUrl: null,
            pauseReason: null,
            failReason: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            crashed: false,
            nextId: null,
          };
          next = n;
          r = { ...r, nextId: n.id };
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
      tasks.map((t): StoredLocalTask => {
        if (t.status !== "running" || Date.parse(t.updatedAt) > cutoff) return t;
        count++;
        const reason = "interrupted (browser or extension stopped during the run)";
        if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
          return { ...t, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, updatedAt: now.toISOString() };
        }
        return { ...t, status: "pending", crashed: true, failReason: reason, retryAfter: null, updatedAt: now.toISOString() };
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
