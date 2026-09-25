/**
 * The pure rules of local tasks: checking what the user entered, the daily
 * repeat schedule, and how the end of a run changes a task.
 */
import { MAX_INSTRUCTIONS_CHARS, RepeatRule, type LocalTask, type TaskRunResult } from "@browsertodo/shared";

/** A local task fails for good after this many attempts. */
export const MAX_LOCAL_ATTEMPTS = 5;

/** A stored local task plus bookkeeping the UI may ignore. */
export type StoredLocalTask = LocalTask & {
  /** Set when a previous attempt was interrupted while running (crash, restart). */
  crashed?: boolean;
  /** Id of the next occurrence this (repeating) task already spawned. */
  nextId?: string | null;
};

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

export function cleanInstructions(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) throw new Error("Instructions are empty");
  if (t.length > MAX_INSTRUCTIONS_CHARS) throw new Error(`Instructions are longer than ${MAX_INSTRUCTIONS_CHARS} characters`);
  return t;
}

export function cleanAccount(a: unknown): string | null {
  if (typeof a !== "string") return null;
  const t = a.trim();
  if (t.length > 100) throw new Error("Account is longer than 100 characters");
  return t || null;
}

export function cleanTime(t: unknown): string | null {
  if (t === null || t === undefined || t === "") return null;
  const d = new Date(String(t));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid time: ${String(t)}`);
  return d.toISOString();
}

export function cleanRepeat(r: unknown): RepeatRule | null {
  if (r === null || r === undefined) return null;
  const parsed = RepeatRule.safeParse(r);
  if (!parsed.success) throw new Error("Repeat times must be HH:MM (24 h), 1 to 24 of them");
  return { dailyAt: [...new Set(parsed.data.dailyAt)].sort() };
}

export const byCreated = (a: StoredLocalTask, b: StoredLocalTask) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

/**
 * The task after a run ended. retry: back to pending after retryAfterMinutes
 * (the reason is kept in failReason), or failed once MAX_LOCAL_ATTEMPTS is
 * reached. paused: waits for the user (tasks.retry).
 */
export function afterRun(t: StoredLocalTask, result: TaskRunResult, now: Date, retryAfterMinutes: number): StoredLocalTask {
  const base: StoredLocalTask = { ...t, updatedAt: now.toISOString(), crashed: false, retryAfter: null };
  switch (result.outcome) {
    case "done":
      return { ...base, status: "done", resultSummary: result.summary ?? null, resultUrl: result.url ?? null, failReason: null, pauseReason: null };
    case "failed":
      return { ...base, status: "failed", failReason: result.reason ?? "failed", pauseReason: null };
    case "paused":
      return { ...base, status: "paused", pauseReason: result.reason ?? "needs your attention" };
    default: {
      const reason = result.reason ?? "temporary problem";
      if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
        return { ...base, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, pauseReason: null };
      }
      const retryAfter = new Date(now.getTime() + retryAfterMinutes * 60_000).toISOString();
      return { ...base, status: "pending", failReason: reason, retryAfter };
    }
  }
}

/** The next occurrence of a repeating task that just ended done or failed (pending, at its next time). */
export function nextOccurrenceTask(t: StoredLocalTask & { repeat: RepeatRule }, id: string, now: Date): StoredLocalTask {
  const nowIso = now.toISOString();
  return {
    ...t,
    id,
    status: "pending",
    attempts: 0,
    notBefore: nextOccurrence(t.repeat.dailyAt, now).toISOString(),
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
}

/**
 * A task left running by a crash: back to pending with the crash marker, or
 * failed when out of attempts.
 */
export function afterCrash(t: StoredLocalTask, now: Date): StoredLocalTask {
  const reason = "interrupted (browser or extension stopped during the run)";
  if (t.attempts >= MAX_LOCAL_ATTEMPTS) {
    return { ...t, status: "failed", failReason: `${reason} (gave up after ${t.attempts} attempts)`, updatedAt: now.toISOString() };
  }
  return { ...t, status: "pending", crashed: true, failReason: reason, retryAfter: null, updatedAt: now.toISOString() };
}
