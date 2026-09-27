/**
 * The repeat part of the add/edit form as plain data, and the way between it
 * and a stored rule: the form's choices (frequency, every N, weekdays, a day
 * of the month, times, start and end) build the cron; a stored rule opens in
 * the form when those choices can say it, else as "Custom" with its cron.
 * Pure: the side panel and the dashboard share it (ui/schedule-fields.ts).
 */
import { allMonthDays, allWeekdays, parseCron, type CronLine } from "./cron.js";
import {
  MAX_REPEAT_COUNT,
  MAX_REPEAT_INTERVAL,
  MAX_REPEAT_TIMES,
  RepeatSchedule,
  timesToCron,
  type RepeatInterval,
  type RepeatUnit,
} from "./schedule.js";
import { parseIsoDate } from "./zoned-time.js";

export type Frequency = "daily" | "weekly" | "monthly" | "custom";
/** -1: the last. */
export type MonthlyRule = { by: "day"; day: number } | { by: "weekday"; nth: number; weekday: number };
export type Ends = "never" | "on" | "after";

export interface RepeatForm {
  frequency: Frequency;
  /** "Every N days/weeks/months" (daily, weekly, monthly). */
  every: number;
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  monthly: MonthlyRule;
  /** "HH:MM", 24 h. */
  times: string[];
  /** "YYYY-MM-DD" or "". */
  start: string;
  ends: Ends;
  endDate: string;
  count: number;
  /** Custom: the cron text. */
  cron: string;
  /** Custom: a stored rule's interval, kept as it was (the Custom choice has no field for it). */
  customInterval?: RepeatInterval;
  tz: string;
}

export const FREQUENCY_UNIT: Record<Exclude<Frequency, "custom">, RepeatUnit> = { daily: "day", weekly: "week", monthly: "month" };

/** A fresh form: daily at `time`, starting `date`. */
export function defaultRepeatForm(o: { date: string; time: string; tz: string }): RepeatForm {
  const d = parseIsoDate(o.date);
  const weekday = d ? new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() : 1;
  const day = d?.day ?? 1;
  return {
    frequency: "daily",
    every: 1,
    weekdays: [weekday],
    monthly: { by: "day", day },
    times: [o.time],
    start: o.date,
    ends: "never",
    endDate: "",
    count: 10,
    cron: timesToCron([o.time]),
    tz: o.tz,
  };
}

export type FormField = "every" | "weekdays" | "times" | "start" | "endDate" | "count" | "cron";
export type FormResult = { ok: true; repeat: RepeatSchedule } | { ok: false; field: FormField; error: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The day-of-month, month and day-of-week fields for the form's frequency. */
function dayFields(f: RepeatForm): string {
  switch (f.frequency) {
    case "weekly":
      return `* * ${[...new Set(f.weekdays)].sort((a, b) => a - b).join(",")}`;
    case "monthly": {
      const m = f.monthly;
      if (m.by === "day") return `${m.day === -1 ? "L" : m.day} * *`;
      return `* * ${m.weekday}${m.nth === -1 ? "L" : `#${m.nth}`}`;
    }
    default:
      return "* * *";
  }
}

/** The rule the form describes, or the first field that needs fixing. */
export function formToRepeat(f: RepeatForm): FormResult {
  const fail = (field: FormField, error: string): FormResult => ({ ok: false, field, error });
  let cron: string;
  let interval: RepeatInterval | undefined;
  if (f.frequency === "custom") {
    if (!f.cron.trim()) return fail("cron", "Write a cron expression, e.g. 0 9 * * 1-5");
    cron = f.cron;
    interval = f.customInterval;
  } else {
    if (!Number.isInteger(f.every) || f.every < 1 || f.every > MAX_REPEAT_INTERVAL) return fail("every", `"Every" must be 1 to ${MAX_REPEAT_INTERVAL}`);
    if (f.frequency === "weekly" && !f.weekdays.length) return fail("weekdays", "Pick at least one day of the week");
    const times = [...new Set(f.times.filter(Boolean))];
    if (!times.length) return fail("times", "Add a time");
    if (times.some((t) => !TIME.test(t))) return fail("times", "Times must be like 09:30");
    if (times.length > MAX_REPEAT_TIMES) return fail("times", `At most ${MAX_REPEAT_TIMES} times a day`);
    cron = timesToCron(times.sort(), dayFields(f));
    if (f.every > 1) interval = { every: f.every, unit: FREQUENCY_UNIT[f.frequency] };
  }
  if (f.start && !parseIsoDate(f.start)) return fail("start", "The start date is not valid");
  if (f.ends === "on") {
    if (!parseIsoDate(f.endDate)) return fail("endDate", "Pick the end date");
    if (f.start && f.endDate < f.start) return fail("endDate", "The end date is before the start date");
  }
  if (f.ends === "after" && (!Number.isInteger(f.count) || f.count < 1 || f.count > MAX_REPEAT_COUNT)) {
    return fail("count", `The number of runs must be 1 to ${MAX_REPEAT_COUNT}`);
  }
  const parsed = RepeatSchedule.safeParse({
    cron,
    tz: f.tz,
    ...(f.start ? { start: f.start } : {}),
    ...(f.ends === "on" ? { end: f.endDate } : {}),
    ...(interval ? { interval } : {}),
    ...(f.ends === "after" ? { count: f.count } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return fail(issue.path[0] === "end" ? "endDate" : "cron", issue.message);
  }
  return { ok: true, repeat: parsed.data };
}

const dayKey = (l: CronLine) => l.source.split(" ").slice(2).join(" ");

/** The frequency and day choices that build these day fields, or null when the form cannot say them. */
function daysToForm(l: CronLine): Pick<RepeatForm, "frequency" | "weekdays" | "monthly"> | null {
  if (l.months.size !== 12) return null;
  const w = l.weekdays;
  const doms = [...l.monthDays.days];
  const everyDom = allMonthDays(l);
  const everyDow = allWeekdays(l);
  if (l.monthDaysRestricted && l.weekdaysRestricted) {
    // Either field matches: one of them covering every day makes it daily; else the form cannot say it.
    return everyDom || everyDow ? { frequency: "daily", weekdays: [], monthly: { by: "day", day: 1 } } : null;
  }
  if (everyDom && everyDow) return { frequency: "daily", weekdays: [], monthly: { by: "day", day: 1 } };
  if (everyDow) {
    if (doms.length + (l.monthDays.last ? 1 : 0) !== 1) return null;
    return { frequency: "monthly", weekdays: [], monthly: { by: "day", day: l.monthDays.last ? -1 : doms[0]! } };
  }
  if (!everyDom) return null;
  const monthly = w.nth.length + w.last.size;
  if (monthly === 0) return { frequency: "weekly", weekdays: [...w.days].sort((a, b) => a - b), monthly: { by: "day", day: 1 } };
  if (monthly === 1 && !w.days.size) {
    const nth = w.nth[0];
    if (nth && nth.n > 4) return null;
    return { frequency: "monthly", weekdays: [], monthly: { by: "weekday", nth: nth ? nth.n : -1, weekday: nth ? nth.weekday : [...w.last][0]! } };
  }
  return null;
}

/**
 * A stored rule in the form: its frequency, days and times when the form's
 * choices build exactly its cron again, else Custom with the cron as it is.
 */
export function repeatToForm(r: RepeatSchedule, fallback: { date: string; time: string }): RepeatForm {
  const base = defaultRepeatForm({ ...fallback, tz: r.tz });
  const common: RepeatForm = {
    ...base,
    start: r.start ?? "",
    ends: r.end ? "on" : r.count !== undefined ? "after" : "never",
    endDate: r.end ?? "",
    count: r.count ?? base.count,
    cron: r.cron,
    tz: r.tz,
  };
  const custom: RepeatForm = { ...common, frequency: "custom", ...(r.interval ? { customInterval: r.interval } : {}) };
  const parsed = parseCron(r.cron);
  if (!parsed.ok) return custom;
  // Times written as a pattern (e.g. "*/15 9-11") stay as written: the form would list each one.
  const listedTimes = parsed.lines.every((l) => l.source.split(" ").slice(0, 2).every((f) => /^\d+(,\d+)*$/.test(f)));
  if (!listedTimes) return custom;
  const keys = new Set(parsed.lines.map(dayKey));
  const days = keys.size === 1 ? daysToForm(parsed.lines[0]!) : null;
  if (!days) return custom;
  const unit = FREQUENCY_UNIT[days.frequency as Exclude<Frequency, "custom">];
  if (r.interval && r.interval.every > 1 && r.interval.unit !== unit) return custom;
  const times = [...new Set(parsed.lines.flatMap((l) => l.hours.flatMap((h) => l.minutes.map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`))))].sort();
  const form: RepeatForm = {
    ...common,
    ...days,
    weekdays: days.weekdays.length ? days.weekdays : base.weekdays,
    monthly: days.frequency === "monthly" ? days.monthly : base.monthly,
    every: r.interval?.every ?? 1,
    times,
  };
  // The form's choices hold the same days and times; they build the cron in its own words.
  return formToRepeat(form).ok ? form : custom;
}
