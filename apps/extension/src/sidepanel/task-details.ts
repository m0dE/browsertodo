/**
 * The task details sheet's view model (pure): everything the panel knows
 * about a task or a chat message, from its TODO entry and/or a run of it.
 * Fields the panel does not have are left out. See details-sheet.ts for the DOM.
 */
import type { LocalTask, RepeatRule, SessionInfo } from "@browsertodo/shared";
import type { LocalMediaInfo } from "../ui-protocol.js";
import { accountLabel, chipHint, formatBytes, outcomeChip, sessionHeadline, taskChip, type Chip } from "./format.js";

/** A TODO entry as the TODO tab has it (cloud tasks may lack repeat and media). */
export type DetailsTask = Omit<LocalTask, "repeat"> & { repeat?: RepeatRule | null; media?: LocalMediaInfo[] };

export interface DetailsInput {
  /** The task's TODO entry, when the TODO list has it. */
  task?: DetailsTask | null;
  /** Where the TODO list came from: the signed-in account, or this browser. */
  listSource?: "local" | "account";
  /** A run of it (the one shown, or the task's latest). */
  session?: SessionInfo | null;
}

export type Origin = "account" | "local" | "api" | "adhoc";

export interface DetailsField {
  label: string;
  value: string;
  /** A link to open in a new tab. */
  href?: string;
  /** Monospace (ids). */
  mono?: boolean;
  tone?: "bad" | "warn";
}

export interface DetailsModel {
  heading: string;
  /** Label of the text block: "Instructions", or "Message" for a chat message. */
  textLabel: string;
  /** The full instructions (line breaks kept); "" when nothing is known. */
  text: string;
  /** Set when only the run's one-line title is known, not the full text. */
  textNote?: string;
  chip?: Chip & { hint: string };
  origin?: Origin;
  fields: DetailsField[];
  files: { name: string; detail: string }[];
  /** The TODO entry to show with "Open in TODO", when the list has it. */
  todoId?: string;
}

export const ORIGIN_LABELS: Record<Origin, string> = {
  account: "Your account's TODO list",
  local: "This browser's TODO list",
  api: "Cloud queue (API)",
  adhoc: "Chat message",
};

/** Where a task came from: its TODO list, the cloud queue, or a message typed in Chat. */
export function originOf(input: DetailsInput): Origin | undefined {
  if (input.task) return input.listSource === "account" ? "account" : "local";
  switch (input.session?.source) {
    case "adhoc":
      return "adhoc";
    case "local":
      return "local";
    case "cloud":
      return "api";
    default:
      return undefined;
  }
}

export interface WhenOptions {
  locale?: string | string[];
  timeZone?: string;
}

/** A date and time in the user's locale, e.g. "Sep 24, 2026, 2:30 PM". */
export function formatWhen(iso: string | null | undefined, opts: WhenOptions = {}): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(opts.locale, { dateStyle: "medium", timeStyle: "short", ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
}

/** "Every day at 09:00 and 18:30", plus the time zone when the task has one. */
export function repeatSentence(repeat: RepeatRule | null | undefined, tz?: string | null): string {
  const times = repeat?.dailyAt ?? [];
  if (!times.length) return "";
  const list = times.length === 1 ? times[0]! : `${times.slice(0, -1).join(", ")} and ${times.at(-1)!}`;
  return `Every day at ${list}${tz ? ` (${tz})` : ""}`;
}

export function detailsModel(input: DetailsInput, now = Date.now(), when: WhenOptions = {}): DetailsModel {
  const { task, session } = input;
  const origin = originOf(input);
  const adhoc = origin === "adhoc";
  const fmt = (iso: string | null | undefined) => formatWhen(iso, when);
  const fields: DetailsField[] = [];
  const add = (label: string, value: string | null | undefined, extra: Omit<DetailsField, "label" | "value"> = {}) => {
    const v = value?.trim();
    if (v) fields.push({ label, value: v, ...extra });
  };

  // The text: the TODO entry's, the chat message, else the run's one-line title.
  let text = task?.instructions ?? session?.instructions ?? "";
  let textNote: string | undefined;
  if (!text.trim() && session?.title) {
    text = session.title;
    textNote = session.title.endsWith("…")
      ? "Only the start of the instructions was saved with this run."
      : "Only a one-line copy of the instructions was saved with this run.";
  }

  const chip = task ? taskChip(task, now) : session ? outcomeChip(session.endedAt ? session.outcome : undefined) : undefined;

  add("Account", accountLabel(task ? task.account : session?.account));
  if (origin) add("Source", ORIGIN_LABELS[origin]);

  if (task) {
    add("Not before", fmt(task.notBefore));
    if (task.status === "pending" && task.retryAfter && Date.parse(task.retryAfter) > now) add("Tries again", fmt(task.retryAfter));
    add("Repeats", repeatSentence(task.repeat, task.tz));
    fields.push({ label: "Attempts", value: String(task.attempts) });
  }

  // The TODO entry's own record wins; without one, the run's.
  const failure = task ? task.failReason : session?.outcome === "failed" ? session.reason : undefined;
  const pause = task ? task.pauseReason : session?.outcome === "paused" || session?.outcome === "retry" ? session.reason : undefined;
  add("Last failure", failure, { tone: "bad" });
  add("Last pause reason", pause, { tone: "warn" });

  const resultUrl = task ? task.resultUrl : session?.url;
  const summary = task ? task.resultSummary : session?.summary;
  if (resultUrl) add("Result", summary || resultUrl, { href: resultUrl });
  else add("Result", summary);

  if (session) add(task ? "Last run by" : "Run by", sessionHeadline(session));

  if (task) {
    add("Created", fmt(task.createdAt));
    add("Updated", fmt(task.updatedAt));
  } else if (session) {
    add("Started", fmt(session.firstStartedAt ?? session.startedAt));
    add("Ended", fmt(session.endedAt));
  }
  add("Task id", task?.id ?? session?.taskId, { mono: true });
  if (session) add("Run id", session.sessionId, { mono: true });

  const files = (task?.media ?? []).map((m) => ({ name: m.name, detail: [m.type, formatBytes(m.size)].filter(Boolean).join(" · ") }));
  // Cloud tasks list their files by id only.
  if (!files.length && task?.mediaIds.length) {
    for (const id of task.mediaIds) files.push({ name: id, detail: "" });
  }

  const model: DetailsModel = {
    heading: adhoc ? "Chat message" : "Task details",
    textLabel: adhoc ? "Message" : "Instructions",
    text,
    fields,
    files,
  };
  if (textNote) model.textNote = textNote;
  if (chip) model.chip = { ...chip, hint: chipHint(chip.label) };
  if (origin) model.origin = origin;
  if (task) model.todoId = task.id;
  return model;
}

export type TextPart = { text: string } | { url: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;
/** Punctuation that usually ends the sentence around a link rather than the link itself. */
const TRAILING = ".,;:!?]}";

const count = (s: string, c: string) => s.split(c).length - 1;

/** Splits text into plain runs and http(s) links (only those become clickable). */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    for (;;) {
      const c = url.at(-1)!;
      // A closing paren stays when it closes one inside the link (e.g. Wikipedia's "Foo_(bar)").
      if (TRAILING.includes(c) || (c === ")" && count(url, ")") > count(url, "("))) url = url.slice(0, -1);
      else break;
    }
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ url });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
