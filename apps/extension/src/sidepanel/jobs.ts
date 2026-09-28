/**
 * The jobs list's view model (pure): every chat, one-off task, repeating task and past run is a job, in one list.
 *
 * A job is either a chat (a conversation started in the panel, by voice or through the API: one session) or a task
 * (a TODO task with its repeats, Task.seriesId, and the runs this browser has of them). A repeating task is one job,
 * however many times it ran; a run whose task is gone stays with the others of its series. The list groups jobs by
 * what they need: Needs you (an approval or the user's answer waits, a task paused), Running, Scheduled (a task
 * waiting for its time), Recent (the rest, newest first).
 */
import {
  formatRelative,
  repeatLabel,
  taskNextTime,
  USER_STOP_REASON,
  whenText,
  type LocalTask,
  type RepeatSchedule,
  type SessionInfo,
} from "@browsertodo/shared";
import type { LocalMediaInfo } from "../ui-protocol.js";
import { firstLine } from "./format.js";

export type JobGroupId = "needs" | "running" | "scheduled" | "recent";

/** Where a job is: what its row's icon and its page's subtitle say. */
export type JobState = "needs" | "running" | "due" | "scheduled" | "retry" | "done" | "failed" | "stopped" | "cancelled";

/** A TODO task as the list has it (its repeat rule read in the current shape; cloud tasks may lack media). */
export type JobTask = Omit<LocalTask, "repeat"> & { repeat?: RepeatSchedule | null; media?: LocalMediaInfo[] };

export interface Job {
  /** "chat:<session id>" or "task:<series id>": stays the same while the job lives (a new run keeps it). */
  key: string;
  kind: "chat" | "task";
  title: string;
  state: JobState;
  group: JobGroupId;
  /** The task's row that stands for it now (the one waiting, running or paused, else the newest). */
  task: JobTask | null;
  /** Every row of the task's series (each repeat is one), newest first. */
  tasks: JobTask[];
  /** The conversation the job's page shows and the composer goes on with: the chat, or the newest run. */
  session: SessionInfo | null;
  /** Its runs in this browser, oldest first (a chat: itself). */
  runs: SessionInfo[];
  /** One of its runs is running in this browser now. */
  running: boolean;
  /** When it last did something (ISO). */
  at: string;
  /** When it runs next (a waiting task; null: its time has come, or it does not wait). */
  next: string | null;
  repeat: RepeatSchedule | null;
  /** Why it needs you, or why it failed ("" when there is nothing to say). */
  reason: string;
  /** The site its newest run ended on ("x.com"; "" when unknown). */
  site: string;
}

export interface JobInputs {
  /** The sessions listed (newest first). */
  sessions: readonly SessionInfo[];
  /** UiState.runningSessions: the newest copy of those running. */
  running: readonly SessionInfo[];
  tasks: readonly JobTask[];
  /** UiState.awaitingApproval. */
  awaitingApproval?: readonly string[];
}

export const GROUP_LABELS: Record<JobGroupId, string> = {
  needs: "Needs you",
  running: "Running",
  scheduled: "Scheduled",
  recent: "Recent",
};
const GROUP_ORDER: readonly JobGroupId[] = ["needs", "running", "scheduled", "recent"];

export const STATE_LABELS: Record<JobState, string> = {
  needs: "Needs you",
  running: "Running",
  due: "Due now",
  scheduled: "Scheduled",
  retry: "Retrying",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  cancelled: "Cancelled",
};

const GROUP_OF: Record<JobState, JobGroupId> = {
  needs: "needs",
  running: "running",
  due: "scheduled",
  scheduled: "scheduled",
  retry: "scheduled",
  done: "recent",
  failed: "recent",
  stopped: "recent",
  cancelled: "recent",
};

/** An approval card waits in a running conversation. */
export const APPROVAL_REASON = "Waiting for your OK";

/** A chat's title when it has none (an empty send: "look at this page"). */
const UNTITLED = "Look at this page";

export const chatKey = (sessionId: string): string => `chat:${sessionId}`;
export const taskKey = (seriesId: string): string => `task:${seriesId}`;
/** The series a task belongs to (older tasks without one: their own). */
export const seriesOf = (t: Pick<JobTask, "id" | "seriesId">): string => t.seriesId ?? t.id;

/** The site of an address, without "www."; "" when it has none. */
export function siteOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

const later = (a: string, b: string) => (a >= b ? a : b);
const lastActive = (s: SessionInfo) => s.endedAt ?? s.startedAt;

/** The job a session belongs to: its task's series (also when the task is gone), else its own chat. */
export function jobKeyOf(s: Pick<SessionInfo, "sessionId" | "source" | "taskId" | "seriesId">, seriesOfTask: ReadonlyMap<string, string> = new Map()): string {
  if (s.source === "adhoc") return chatKey(s.sessionId);
  const series = (s.taskId && seriesOfTask.get(s.taskId)) || s.seriesId || s.taskId;
  return series ? taskKey(series) : chatKey(s.sessionId);
}

/** The row that stands for a series: the one running, else paused, else waiting, else the newest (rows newest first). */
function currentTask(rows: readonly JobTask[]): JobTask {
  for (const status of ["running", "paused", "pending"] as const) {
    const t = rows.find((r) => r.status === status);
    if (t) return t;
  }
  return rows[0]!;
}

/** Where a conversation is, when its task (if any) does not say. */
function sessionState(s: SessionInfo, running: boolean, awaiting: boolean): { state: JobState; reason: string } {
  if (running) return awaiting ? { state: "needs", reason: APPROVAL_REASON } : { state: "running", reason: "" };
  // Not running and never ended: its worker stopped under it.
  if (!s.endedAt) return { state: "stopped", reason: "" };
  switch (s.outcome) {
    case "done":
      return { state: "done", reason: "" };
    case "failed":
      return { state: "failed", reason: s.reason ?? "" };
    case "paused":
    case "retry":
      // Stopped by the user: over, not waiting for them.
      return s.reason === USER_STOP_REASON ? { state: "stopped", reason: "" } : { state: "needs", reason: s.reason ?? "" };
    default:
      return { state: "stopped", reason: "" };
  }
}

function taskState(t: JobTask, now: number): { state: JobState; reason: string } {
  switch (t.status) {
    case "running":
      return { state: "running", reason: "" };
    case "paused":
      return { state: "needs", reason: t.pauseReason ?? "" };
    case "pending": {
      if (t.retryAfter && Date.parse(t.retryAfter) > now) return { state: "retry", reason: t.failReason ?? "" };
      const next = taskNextTime(t);
      return { state: next && Date.parse(next) > now ? "scheduled" : "due", reason: "" };
    }
    case "done":
      return { state: "done", reason: "" };
    case "failed":
      return { state: "failed", reason: t.failReason ?? "" };
    case "cancelled":
      return { state: "cancelled", reason: "" };
  }
}

/** Every job, in no particular order (see groupJobs). */
export function buildJobs(input: JobInputs, now = Date.now()): Job[] {
  const live = new Map(input.running.map((s) => [s.sessionId, s]));
  const awaiting = new Set(input.awaitingApproval ?? []);
  const sessions = new Map(input.sessions.map((s) => [s.sessionId, live.get(s.sessionId) ?? s]));
  for (const s of input.running) if (!sessions.has(s.sessionId)) sessions.set(s.sessionId, s);

  const seriesTasks = new Map<string, JobTask[]>();
  const seriesOfTask = new Map<string, string>();
  for (const t of input.tasks) {
    const series = seriesOf(t);
    seriesOfTask.set(t.id, series);
    seriesTasks.set(series, [...(seriesTasks.get(series) ?? []), t]);
  }
  const runsOf = new Map<string, SessionInfo[]>();
  for (const s of sessions.values()) {
    const key = jobKeyOf(s, seriesOfTask);
    runsOf.set(key, [...(runsOf.get(key) ?? []), s]);
  }
  for (const series of seriesTasks.keys()) if (!runsOf.has(taskKey(series))) runsOf.set(taskKey(series), []);

  const jobs: Job[] = [];
  for (const [key, list] of runsOf) {
    const runs = [...list].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    const newest = runs.at(-1) ?? null;
    const liveRun = runs.find((r) => live.has(r.sessionId)) ?? null;
    const kind = key.startsWith("task:") ? "task" : "chat";
    const rows = [...(seriesTasks.get(key.slice("task:".length)) ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const task = kind === "task" && rows.length ? currentTask(rows) : null;
    const session = liveRun ?? newest;
    const where =
      liveRun || !task
        ? sessionState(session!, !!liveRun, !!liveRun && awaiting.has(liveRun.sessionId))
        : taskState(task, now);
    const at = [task?.updatedAt, newest ? lastActive(newest) : undefined].filter((x): x is string => !!x).reduce(later, "");
    jobs.push({
      key,
      kind,
      title: firstLine(task?.instructions ?? "") || firstLine(session?.title ?? "") || UNTITLED,
      state: where.state,
      group: GROUP_OF[where.state],
      task,
      tasks: rows,
      session,
      runs,
      running: !!liveRun,
      at,
      next: task?.status === "pending" ? taskNextTime(task) : null,
      repeat: task?.repeat ?? null,
      reason: where.reason,
      site: siteOf(session?.url),
    });
  }
  return jobs;
}

/** The words of a search, lower case. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The job's title, instructions or site holds every word of the search (in any order). */
export function jobMatches(job: Job, words: readonly string[]): boolean {
  if (!words.length) return true;
  const text = [job.title, job.task?.instructions, ...job.runs.map((r) => r.instructions ?? r.title), job.site, ...job.runs.map((r) => siteOf(r.url))]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

export interface JobGroup {
  id: JobGroupId;
  label: string;
  jobs: Job[];
}

const byLatest = (a: Job, b: Job) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
/** Soonest first; a job whose time has come (no next time) before any that waits. */
const bySoonest = (a: Job, b: Job) => (a.next ? Date.parse(a.next) : -Infinity) - (b.next ? Date.parse(b.next) : -Infinity) || a.title.localeCompare(b.title);

/** The groups that have jobs (matching the search), in order: Needs you, Running, Scheduled, Recent. */
export function groupJobs(jobs: readonly Job[], query = ""): JobGroup[] {
  const words = searchWords(query);
  const shown = jobs.filter((j) => jobMatches(j, words));
  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABELS[id],
    jobs: shown.filter((j) => j.group === id).sort(id === "scheduled" ? bySoonest : byLatest),
  })).filter((g) => g.jobs.length > 0);
}

/** A row of the list, in words. */
export interface JobRow {
  title: string;
  /** Right side: when it ran, or when it runs next. */
  when: string;
  /** Under the title, quietly: why it needs you, its repeat rule, or its site ("" for none). */
  meta: string;
  /** Everything above in one sentence, for screen readers. */
  label: string;
}

/** Words joined into one line, which alone starts with a capital: "Daily at 9:00 AM · next tomorrow 9:00 AM". */
function line(...parts: (string | false | null | undefined)[]): string {
  const text = parts.filter(Boolean).join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A time in words inside a line: "tomorrow 9:00 AM" (whenText starts it with a capital; weekdays and months keep theirs). */
const inLine = (when: string): string => when.replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

/** When a waiting job runs, in words, inside a line ("due now", "retries today 3:00 PM", "tomorrow 9:00 AM"). */
function nextWords(job: Job, now: number): string {
  if (job.state === "due" || !job.next) return "due now";
  const at = inLine(whenText(job.next, now));
  return job.state === "retry" ? `retries ${at}` : at;
}

export function jobRow(job: Job, now = Date.now()): JobRow {
  const rule = repeatLabel(job.repeat);
  // Standing alone on the right: today's time without "today".
  const when =
    job.group === "scheduled" ? line(nextWords(job, now).replace(/^(retries )?today /, "$1")) : job.state === "running" ? "now" : formatRelative(job.at, now);
  const meta = job.group === "needs" ? job.reason : job.group === "scheduled" && rule ? rule : job.site;
  const next = job.group !== "scheduled" ? when : nextWords(job, now) === "due now" ? "due now" : job.state === "retry" ? nextWords(job, now) : `next ${nextWords(job, now)}`;
  const label = [job.title, STATE_LABELS[job.state], job.group === "scheduled" ? [rule, next].filter(Boolean).join(", ") : when, job.group === "needs" ? job.reason : job.site]
    .filter(Boolean)
    .join(", ");
  return { title: job.title, when, meta, label };
}

/** The job page's one line under its title: "Daily at 9:00 AM · next tomorrow 9:00 AM", "Done · 5 min ago", ... */
export function jobSubtitle(job: Job, now = Date.now()): string {
  const rule = repeatLabel(job.repeat);
  switch (job.group) {
    case "scheduled": {
      const next = nextWords(job, now);
      if (next === "due now" || job.state === "retry") return line(rule, next);
      return rule ? line(rule, `next ${next}`) : line("once", next);
    }
    case "needs":
      return line(STATE_LABELS.needs, job.reason);
    case "running":
      return line(STATE_LABELS.running, rule);
    default:
      return line(STATE_LABELS[job.state], formatRelative(job.at, now), rule);
  }
}
