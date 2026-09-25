/** Pure formatting helpers for the side panel and the options page. */
import {
  formatCents,
  formatRelative,
  hostedModel,
  OUT_OF_CREDIT,
  plural,
  taskNextTime,
  type BrainKind,
  type Chip,
  type LocalTask,
  type Tone,
} from "@browsertodo/shared";
import { todoAllowed } from "../account/types.js";
import { API_IDLE_MS } from "../engine/api-brain.js";
import { BRAIN_LABELS, brainLabel, modelLabel } from "../ui/labels.js";
import type { AccountView, UiState } from "../ui-protocol.js";


/** "Claude Code · claude-sonnet-5 · Jev on": the agent behind a conversation. */
export function sessionHeadline(s: { brain: BrainKind; model?: string; jev: boolean }): string {
  return [BRAIN_LABELS[s.brain], s.model?.trim() || "default model", s.jev ? "Jev on" : "Jev off"].join(" · ");
}

/**
 * The note under the Chat header while a conversation waits for the
 * next message: whether it continues in the same agent session.
 */
export function conversationNote(s: { brain: BrainKind; endedAt?: string }, open: boolean): string | null {
  if (!s.endedAt) return null;
  if (!open) return "Conversation open · session ended — the next message starts a fresh session with a summary";
  const kept = `kept ${API_IDLE_MS / 60_000} min`;
  return s.brain === "claude-code"
    ? `Conversation open · Claude Code session ${kept}`
    : `Conversation open · ${BRAIN_LABELS[s.brain]} history ${kept}`;
}

export interface StatusLine {
  tone: Tone;
  text: string;
  /** What the banner's button does, when it has one. topup: open the account's top-up page. */
  action?: "settings" | "resume" | "topup";
}

/**
 * True when the hosted AI is (or would be) the brain and the account has no
 * credit: the status line and the model chip say "Out of usage credit".
 */
export function outOfCredit(state: Pick<UiState, "brain" | "settings" | "account">): boolean {
  const a = state.account;
  if (!a?.signedIn || !a.outOfCredit) return false;
  return state.brain.effective === "browsertodo" || state.settings.brain === "browsertodo" || !state.brain.effective;
}

/** The slim line at the top of the side panel. */
export function statusLine(state: UiState): StatusLine {
  if (outOfCredit(state)) {
    return { tone: "warn", text: OUT_OF_CREDIT, action: "topup" };
  }
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

const pad = (n: number) => String(n).padStart(2, "0");

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
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** First non-empty line, clipped. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Punctuation that usually ends the sentence around a link rather than the link itself. */
const URL_TRAILING = `.,;:!?'"]}`;
const count = (s: string, c: string) => s.split(c).length - 1;

/** A URL found in running text without the sentence punctuation after it; a closing paren stays when it closes one inside the link ("Foo_(bar)"). */
export function trimUrlEnd(url: string): string {
  let u = url;
  for (;;) {
    const c = u.at(-1);
    if (c && (URL_TRAILING.includes(c) || (c === ")" && count(u, ")") > count(u, "(")))) u = u.slice(0, -1);
    else return u;
  }
}

type Timing = Pick<LocalTask, "status" | "notBefore" | "retryAfter">;

/**
 * The TODO tab's Run now button: enabled when a task is due (or the cloud
 * queue may have one). account: the list is the signed-in account's.
 */
export function runNowButton(
  tasks: readonly Timing[],
  settings: { intervalMinutes: number; cloudEnabled: boolean } | null,
  now = Date.now(),
  account = false,
): { disabled: boolean; title: string } {
  const due = tasks.some((t) => {
    if (t.status !== "pending") return false;
    const next = taskNextTime(t);
    return !next || Date.parse(next) <= now;
  });
  const cloud = !account && !!settings?.cloudEnabled;
  if (!due && !cloud) return { disabled: true, title: "Nothing is waiting to run" };
  const n = settings?.intervalMinutes;
  const every = n ? ` (every ${plural(n, "minute")})` : "";
  return {
    disabled: false,
    title: `Run the tasks whose time has come${cloud ? " and check the cloud queue" : ""}, instead of waiting for the next check${every}`,
  };
}

/** The Chat header's meta line: "started 2 min ago · 2 messages", or "today 14:30 · done" once ended. */
export function sessionMeta(
  s: { startedAt: string; endedAt?: string; outcome?: string; turns?: number },
  now = Date.now(),
): string {
  const parts = [s.endedAt ? clockLabel(s.startedAt, now) : `started ${formatRelative(s.startedAt, now)}`];
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

export { bytesToBase64 } from "../base64.js";

/** "me" -> "@me"; labels that are not plain handles stay as typed. */
export function accountLabel(account: string | null | undefined): string {
  const a = account?.trim() ?? "";
  if (!a) return "";
  return /^[A-Za-z0-9_]+$/.test(a) ? `@${a}` : a;
}

export interface ModelChipInfo {
  /** "Sonnet 5 · Jev" or "Sonnet 5"; "Out of usage credit" when the hosted AI has none. */
  label: string;
  /** The hosted browsertodo AI runs (or would run) the next task: only its models are offered. */
  hosted: boolean;
  /** Hosted: the account's credit ("$4.21 left"), when known. */
  credit?: string;
  outOfCredit: boolean;
  model: string;
  jevActive: boolean;
  /** Whether Jev can be switched on at all (a key here, or the helper has its own). */
  jevPossible: boolean;
  jevEnabled: boolean;
}

/** What the composer's model chip shows: the model that will run, and whether Jev helps. */
export function modelChip(state: Pick<UiState, "settings" | "brain" | "account">): ModelChipInfo {
  const hosted = state.brain.effective === "browsertodo" || (!state.brain.effective && state.settings.brain === "browsertodo");
  const setting = state.settings.anthropicModel;
  const model = hosted ? hostedModel(setting) : setting;
  const jevActive = !!state.brain.effective && state.brain.jevActive;
  const noCredit = outOfCredit(state);
  const info: ModelChipInfo = {
    label: noCredit ? OUT_OF_CREDIT : modelLabel(model) + (jevActive ? " · Jev" : ""),
    hosted,
    outOfCredit: noCredit,
    model,
    jevActive,
    jevPossible: hosted || state.brain.jevActive || !!state.settings.jevApiKey || !!state.brain.helper?.jevAvailable,
    jevEnabled: state.settings.jevEnabled,
  };
  const credit = state.account?.signedIn ? state.account.credit : undefined;
  if (hosted && credit) info.credit = `${formatCents(credit.totalCents)} usage credit left`;
  return info;
}

/** What the tab shows: the list, or one call to action (Log in; Get a plan). "loading": the account is not known yet. */
export type TodoGate = "loading" | "out" | "locked" | "in";

/**
 * The tab's gate. locked: the last list's word (the server judges the plan);
 * before a list arrived, the plan as the account view has it.
 */
export function todoGate(account: AccountView | null, listLocked: boolean | null): TodoGate {
  if (!account) return "loading";
  if (!account.signedIn) return "out";
  return (listLocked ?? !todoAllowed(account.plan)) ? "locked" : "in";
}
