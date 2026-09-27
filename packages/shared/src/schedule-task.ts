/**
 * Scheduling from the chat: the agent's schedule_task tool (tools.ts) puts a
 * task in the user's TODO list ("make a repeat task for what we just did",
 * "check again in 3 hours"). What the tool, the extension that stores the
 * task and the chat's card share: the schedule in words, the messages, and
 * the RPC the helper calls. The schedule itself is the task schedule model
 * (schedule.ts).
 */
import { plansWithText } from "./billing.js";
import type { ScheduleInput } from "./schedule.js";
import { describeRepeat, prefersHour12, timeText } from "./schedule-text.js";
import { tzOffsetMs, wallTime } from "./zoned-time.js";

/** A task schedule_task stored: what the tool answers the model, and what the chat's card shows. */
export interface ScheduledTask {
  /** The TODO list's task id (Undo deletes it; View in TODO finds its row). */
  taskId: string;
  instructions: string;
  /** The schedule in words ("Every weekday at 9:00 AM"), in the user's time zone. */
  when: string;
  /** When it runs first (ISO), when known. */
  nextRunAt: string | null;
}

/** The refusal on a plan without the TODO list (error-help.ts gives it a Choose a plan button). */
export const SCHEDULE_PLAN_REQUIRED = `Scheduling needs ${plansWithText("todo")}.`;
/** The refusal while signed out: the TODO list is the account's (error-help.ts gives it a Log in button). */
export const SCHEDULE_SIGN_IN = "Scheduling needs you to log in to BrowserTODO.";

/** What schedule_task answers the model once the task is stored. */
export function scheduledTaskText(s: ScheduledTask): string {
  const title = s.instructions.split("\n")[0]!.trim();
  return `Scheduled in the user's TODO list (task ${s.taskId}): "${title}" · ${s.when}. It shows in their TODO tab now, and the chat shows them a card with Undo. Tell them in one short line.`;
}

/** RPC the helper calls on the extension for schedule_task (Claude Code brain), with the task session's id. */
export type ScheduleMethods = {
  "todo.scheduleTask": { params: { sessionId: string; args: unknown }; result: ScheduledTask };
};

/** The calendar day of `instant` in `tz`, comparable as a string ("2026-09-26"). */
const dayKey = (instant: number, tz: string) => {
  const w = wallTime(instant, tz);
  return `${w.year}-${w.month}-${w.day}`;
};

/** "today at 6:45 PM", "tomorrow at 9:00 AM", "Mon, Oct 5 at 9:30 AM": `iso` as seen in `tz`. */
function momentText(iso: string, now: Date, tz: string, hour12: boolean): string {
  const t = Date.parse(iso);
  const w = wallTime(t, tz);
  const day =
    dayKey(t, tz) === dayKey(now.getTime(), tz)
      ? "today"
      : dayKey(t, tz) === dayKey(now.getTime() + 86_400_000, tz)
        ? "tomorrow"
        : new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  return `${day} at ${timeText(w.hour, w.minute, hour12)}`;
}

/**
 * A schedule in words for the user: "Once, today at 6:45 PM", "Every weekday at 9:00 AM",
 * "Daily at 9:00 AM (Europe/Lisbon), first run tomorrow at 9:00 AM". One-off times are shown in
 * `timeZone` (the user's); a repeat's times are its own zone's, named when it is another one.
 */
export function describeSchedule(s: ScheduleInput, opts: { now: Date; timeZone: string; hour12?: boolean }): string {
  const { now, timeZone } = opts;
  const hour12 = opts.hour12 ?? prefersHour12();
  if (!s.repeat) return s.at ? `Once, ${momentText(s.at, now, timeZone, hour12)}` : "Once, as soon as possible";
  const zone = s.repeat.tz === timeZone ? "" : ` (${s.repeat.tz})`;
  const first = s.at ? `, first run ${momentText(s.at, now, timeZone, hour12)}` : "";
  return `${describeRepeat(s.repeat, { now, hour12 })}${zone}${first}`;
}

/** "+05:30": `tz`'s UTC offset at `instant`. */
function offsetText(instant: number, tz: string): string {
  const minutes = Math.round(tzOffsetMs(instant, tz) / 60_000);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The line every turn's prompt gives the agent, so it can turn "after 3 hours" or "tomorrow morning" into a
 * schedule_task time: "The user's time: Saturday, September 26, 2026, 3:45 PM in America/New_York (UTC-04:00)."
 */
export function userTimeLine(timeZone: string, now: Date): string {
  const when = now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
  return `The user's time: ${when.replace(" at ", ", ")} in ${timeZone} (UTC${offsetText(now.getTime(), timeZone)}).`;
}
