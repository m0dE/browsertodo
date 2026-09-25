/** Pure formatting helpers for the side panel and the options page. */
import type { BrainKind, LocalTask, RepeatRule } from "@browsertodo/shared";
import type { UiState } from "../ui-protocol.js";

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

const BRAIN_LABELS: Record<BrainKind, string> = {
  "claude-code": "Claude Code",
  "claude-api": "Claude API",
  scripted: "Scripted",
};

export function brainLabel(kind: BrainKind, jev = false): string {
  return BRAIN_LABELS[kind] + (jev ? " + Jev" : "");
}

/** "Claude Code · claude-sonnet-5 · Jev on": the agent behind a conversation. */
export function sessionHeadline(s: { brain: BrainKind; model?: string; jev: boolean }): string {
  return [BRAIN_LABELS[s.brain], s.model?.trim() || "default model", s.jev ? "Jev on" : "Jev off"].join(" · ");
}

/**
 * The note under the Activity header while a conversation waits for the
 * next message: whether it continues in the same agent session.
 */
export function conversationNote(s: { brain: BrainKind; endedAt?: string }, open: boolean): string | null {
  if (!s.endedAt) return null;
  if (!open) return "Conversation open · session ended — the next message starts a fresh session with a summary";
  return s.brain === "claude-code"
    ? "Conversation open · Claude Code session kept 30 min"
    : "Conversation open · Claude API history kept 30 min";
}

export interface StatusLine {
  tone: Tone;
  text: string;
  /** What the banner's button does, when it has one. */
  action?: "settings" | "resume";
}

/** The slim line at the top of the side panel. */
export function statusLine(state: UiState): StatusLine {
  if (!state.brain.effective) {
    return {
      tone: "bad",
      text: state.brain.note || "Nothing can run tasks yet. Add a Claude API key or install the helper.",
      action: "settings",
    };
  }
  if (state.paused) {
    return { tone: "warn", text: `Runs paused${state.pausedReason ? `: ${state.pausedReason}` : ""}`, action: "resume" };
  }
  return { tone: "ok", text: brainLabel(state.brain.effective, state.brain.jevActive) };
}

/** "just now", "5 min ago", "in 3 h", "2 d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const sec = Math.round(Math.abs(diff) / 1000);
  if (sec < 45) return "just now";
  const fmt = (n: number, unit: string) => (diff > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  const min = Math.round(sec / 60);
  if (min < 60) return fmt(min, "min");
  const h = Math.round(min / 60);
  if (h < 24) return fmt(h, "h");
  return fmt(Math.round(h / 24), "d");
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local clock label: "today 14:30", "tomorrow 09:00", "Sep 30 09:00". */
export function clockLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const t = new Date(now);
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return `today ${hm}`;
  if (dayDiff === 1) return `tomorrow ${hm}`;
  if (dayDiff === -1) return `yesterday ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/** First non-empty line, clipped. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Collapse whitespace and clip. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

type Timing = Pick<LocalTask, "status" | "notBefore" | "retryAfter">;

/** When a pending task becomes due (the later of notBefore and retryAfter). */
export function taskNextTime(task: Timing): string | null {
  if (task.status !== "pending") return null;
  const times = [task.notBefore, task.retryAfter].filter((t): t is string => !!t);
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export interface Chip {
  label: string;
  tone: Tone;
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

/** The Activity header's meta line: "started 2 min ago · 2 messages", or "today 14:30 · done" once ended. */
export function sessionMeta(
  s: { startedAt: string; endedAt?: string; outcome?: string; turns?: number },
  now = Date.now(),
): string {
  const parts = [s.endedAt ? clockLabel(s.startedAt, now) : `started ${relativeTime(s.startedAt, now)}`];
  if (s.endedAt) parts.push(outcomeChip(s.outcome).label);
  if ((s.turns ?? 1) > 1) parts.push(`${s.turns} messages`);
  return parts.join(" · ");
}

export function outcomeChip(outcome: string | undefined): Chip {
  switch (outcome) {
    case undefined:
      return { label: "running", tone: "accent" };
    case "done":
      return { label: "done", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "bad" };
    case "paused":
      return { label: "needs you", tone: "warn" };
    case "retry":
      return { label: "retry", tone: "warn" };
    default:
      return { label: outcome, tone: "muted" };
  }
}

type Sortable = Timing & Pick<LocalTask, "createdAt" | "updatedAt">;

/** Active tasks (running, needs you, pending) first by due time; finished ones newest first. */
export function splitTasks<T extends Sortable>(tasks: T[]): { active: T[]; finished: T[] } {
  const isActive = (t: T) => t.status === "pending" || t.status === "running" || t.status === "paused";
  const rank = (t: T) => (t.status === "running" ? 0 : t.status === "paused" ? 1 : 2);
  const when = (t: T) => Date.parse(taskNextTime(t) ?? t.createdAt);
  const active = tasks.filter(isActive).sort((a, b) => rank(a) - rank(b) || when(a) - when(b));
  const finished = tasks
    .filter((t) => !isActive(t))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { active, finished };
}

export function repeatLabel(repeat: RepeatRule | null | undefined): string {
  return repeat?.dailyAt.length ? `daily ${repeat.dailyAt.join(", ")}` : "";
}

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
  if (times.size > 24) return { ok: false, error: "At most 24 times a day" };
  return { ok: true, times: [...times].sort() };
}

/** Value of <input type="datetime-local"> (local time) to ISO UTC; empty or invalid -> undefined. */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export { bytesToBase64 } from "../base64.js";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "me" -> "@me"; labels that are not plain handles stay as typed. */
export function accountLabel(account: string | null | undefined): string {
  const a = account?.trim() ?? "";
  if (!a) return "";
  return /^[A-Za-z0-9_]+$/.test(a) ? `@${a}` : a;
}

/** Models offered in the side panel's model menu. Other ids still work (set on the options page). */
export const KNOWN_MODELS: readonly { id: string; label: string }[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

/** "claude-sonnet-5" -> "Sonnet 5"; unknown ids are shown as typed. */
export function modelLabel(id: string | null | undefined): string {
  const m = id?.trim() ?? "";
  if (!m) return "Default model";
  return KNOWN_MODELS.find((k) => k.id === m)?.label ?? m;
}

export interface ModelChipInfo {
  /** "Sonnet 5 · Jev" or "Sonnet 5". */
  label: string;
  model: string;
  jevActive: boolean;
  /** Whether Jev can be switched on at all (a key here, or the helper has its own). */
  jevPossible: boolean;
  jevEnabled: boolean;
}

/** What the composer's model chip shows: the model that will run, and whether Jev helps. */
export function modelChip(state: Pick<UiState, "settings" | "brain">): ModelChipInfo {
  const model = state.settings.anthropicModel;
  const jevActive = !!state.brain.effective && state.brain.jevActive;
  return {
    label: modelLabel(model) + (jevActive ? " · Jev" : ""),
    model,
    jevActive,
    jevPossible: state.brain.jevActive || !!state.settings.jevApiKey || !!state.brain.helper?.jevAvailable,
    jevEnabled: state.settings.jevEnabled,
  };
}
