/**
 * How a task reads in a list, the same in the side panel's TODO tab and the
 * dashboard: its status chip and tooltip, list order, repeat label, and the
 * add/edit form's time parsing. Pure and DOM-free.
 */
import { plural } from "./format.js";
import { MAX_REPEAT_TIMES, type RepeatRule, type TaskStatus } from "./task.js";

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export interface Chip {
  label: string;
  tone: Tone;
}

type Timing = { status: TaskStatus; notBefore?: string | null; retryAfter?: string | null };

/** When a pending task becomes due (the later of notBefore and retryAfter). */
export function taskNextTime(task: Timing): string | null {
  if (task.status !== "pending") return null;
  const times = [task.notBefore, task.retryAfter].filter((t): t is string => !!t);
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export function taskChip(task: Timing, now = Date.now()): Chip {
  switch (task.status) {
    case "pending": {
      if (task.retryAfter && Date.parse(task.retryAfter) > now) return { label: "retry", tone: "warn" };
      const next = taskNextTime(task);
      if (next && Date.parse(next) > now) return { label: "scheduled", tone: "muted" };
      return { label: "due", tone: "accent" };
    }
    case "running":
      return { label: "running", tone: "accent" };
    case "done":
      return { label: "done", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "bad" };
    case "paused":
      return { label: "needs you", tone: "warn" };
    case "cancelled":
      return { label: "cancelled", tone: "muted" };
  }
}

/** Plain-language tooltips for the status chips on tasks and runs. */
const CHIP_HINTS: Record<string, string> = {
  due: "Its time has come: it runs at the next check, or right away with Run now",
  scheduled: "Waits until the time shown, then runs at the next check",
  retry: "Stopped for a temporary reason; it is tried again by itself later",
  running: "The agent is working on it now",
  done: "Finished",
  failed: "Did not work and will not be tried again by itself; the reason is shown",
  "needs you": "The agent stopped because it needs you (a login, a code, a choice); the reason is shown",
  cancelled: "Cancelled; it will not run",
};

export function chipHint(label: string): string {
  return CHIP_HINTS[label] ?? "";
}

type Sortable = Timing & { createdAt: string; updatedAt: string };

/** Active tasks (running, needs you, pending) first by due time; finished ones newest first. */
export function splitTasks<T extends Sortable>(tasks: readonly T[]): { active: T[]; finished: T[] } {
  const isActive = (t: T) => t.status === "pending" || t.status === "running" || t.status === "paused";
  const rank = (t: T) => (t.status === "running" ? 0 : t.status === "paused" ? 1 : 2);
  const when = (t: T) => Date.parse(taskNextTime(t) ?? t.createdAt);
  const active = tasks.filter(isActive).sort((a, b) => rank(a) - rank(b) || when(a) - when(b));
  const finished = tasks
    .filter((t) => !isActive(t))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { active, finished };
}

/** { dailyAt: ["09:00", "18:00"] } -> "daily at 09:00, 18:00"; no repeat -> "". */
export function repeatLabel(repeat: RepeatRule | null | undefined): string {
  return repeat?.dailyAt.length ? `daily at ${repeat.dailyAt.join(", ")}` : "";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Parse "9:00, 18:30 21.15" into sorted, unique "HH:MM" times. Empty input = no repeat. */
export function parseRepeatTimes(input: string): { ok: true; times: string[] } | { ok: false; error: string } {
  const times = new Set<string>();
  for (const p of input.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(p);
    const h = m ? Number(m[1]) : NaN;
    const min = m ? Number(m[2]) : NaN;
    if (!m || h > 23 || min > 59) return { ok: false, error: `"${p}" is not a time like 09:30` };
    times.add(`${pad(h)}:${pad(min)}`);
  }
  if (times.size > MAX_REPEAT_TIMES) return { ok: false, error: `At most ${MAX_REPEAT_TIMES} times a day` };
  return { ok: true, times: [...times].sort() };
}

/** Value of <input type="datetime-local"> (local time) to ISO UTC; empty or invalid -> undefined. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The TODO list on a plan without it (the side panel's TODO tab and the dashboard's TODO page say the same). */
export const TODO_LOCKED = {
  title: "TODO needs a paid plan",
  why: "Tasks are stored in your account and run on schedule.",
  action: "Get a plan",
} as const;

/** "You have 3 saved tasks; they come back when you subscribe." ("" for none): what a locked list keeps. */
export function keptTasksText(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? "You have 1 saved task; it comes back when you subscribe." : `You have ${plural(n, "saved task")}; they come back when you subscribe.`;
}
