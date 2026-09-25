/**
 * Daily repeat schedule ("HH:MM" times) in an IANA time zone, using only
 * Intl.DateTimeFormat: the API computes it in the task's zone, the extension
 * in the browser's own.
 */
import type { RepeatRule } from "./task.js";

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields of `instant` (ms) in `tz`. */
function wallTime(instant: number, tz: string): Wall {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** UTC offset of `tz` at `instant`, in ms (local = utc + offset). */
export function tzOffsetMs(instant: number, tz: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const w = wallTime(whole, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

/**
 * The instant of a local wall-clock time in `tz`, with the same rules as
 * JavaScript's `new Date(y, m, d, h, min)` in a local zone: a time skipped by
 * a DST jump moves forward by the jump (02:30 -> 03:30), and a time that
 * happens twice resolves to the earlier one.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = tzOffsetMs(wall - DAY_MS, tz);
  const after = tzOffsetMs(wall + DAY_MS, tz);
  const valid = [...new Set([before, after])]
    .map((off) => wall - off)
    .filter((t) => tzOffsetMs(t, tz) === wall - t)
    .sort((a, b) => a - b);
  if (valid.length) return valid[0]!;
  // Skipped by a forward jump: read it with the offset in force before the jump.
  return wall - before;
}

/**
 * The next time from dailyAt ("HH:MM" in `tz`) strictly after `after`.
 * `tz` defaults to UTC.
 */
export function nextOccurrenceInZone(dailyAt: string[], after: Date, tz: string | null | undefined): Date {
  if (dailyAt.length === 0) throw new Error("repeat rule has no times");
  const zone = tz || "UTC";
  const today = wallTime(after.getTime(), zone);
  for (let offset = 0; offset <= 2; offset++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    let best: number | null = null;
    for (const hhmm of dailyAt) {
      const [h, m] = hhmm.split(":").map(Number) as [number, number];
      const cand = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m, zone);
      if (cand > after.getTime() && (best === null || cand < best)) best = cand;
    }
    if (best !== null) return new Date(best);
  }
  throw new Error("no next occurrence found");
}

/** A rule with its times deduped and sorted (how rules are stored). */
export function normalizeRepeat(r: RepeatRule | null | undefined): RepeatRule | null {
  if (!r) return null;
  return { dailyAt: [...new Set(r.dailyAt)].sort() };
}
