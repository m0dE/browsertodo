/** Pure view models for agent events in Chat and the History tab. */
import { describeSchedule, localTimeZone, picksText, SCREEN_HELP_TEXT, type AgentEvent, type Chip, type ElementPicks, type SessionInfo, type TaskSource, type TodoChange } from "@browsertodo/shared";
import { clip, isLongSummary, sharedWordShare, toolArgsSummary } from "../text.js";
import { speakable } from "../voice/spoken-line.js";
import { errorHelp, type ErrorHelp } from "./error-help.js";
import { clockLabel, firstLine, outcomeChip } from "./format.js";
import { approvalView, type ApprovalView } from "./approval-view.js";
import { memoryNoteView, type MemoryNoteView } from "./memory-note.js";

export type EventView =
  /** picks: the end-of-turn "Jev chose ..." line, shown in the end card instead of on its own. */
  | { kind: "status"; text: string; picks?: true }
  /** Claude's text (Markdown). id: the streamed block it completes. */
  | { kind: "text"; text: string; id?: string }
  | { kind: "tool"; id: string; name: string; args: string }
  | { kind: "result"; id: string; name: string; preview: string; full: string; isError: boolean; thumbnail?: string }
  | { kind: "jev"; label: string; ms: number; executed: boolean; title: string }
  /**
   * screen: an empty message, "look at the page and do what is needed" (shown quieter, with an eye). voice: it was
   * spoken. sent: what the Realtime narrator passed to the agent for these words, when it says something else.
   */
  | { kind: "user"; text: string; screen?: true; voice?: true; sent?: string }
  /**
   * What the user said with hands-free voice that went to no one (thinking aloud, "one sec"): a muted line, never a
   * message. Lines in a row show as one (placeEvent).
   */
  | { kind: "heard"; text: string }
  /** A line hands-free voice said aloud. echo: it repeats the start of the text written above it (shown compact). */
  | { kind: "spoken"; text: string; echo?: true }
  /**
   * picks: who picked the turn's elements ("Jev chose 9 of 11 element picks ...").
   * long: the text is an answer (several lines or long), shown as a message above the outcome line.
   */
  | {
      kind: "end";
      chip: Chip;
      text: string;
      url?: string;
      picks?: string;
      long?: true;
      /** The turn failed on an error no card of its own showed yet: shown as that card (in place of `text`). */
      error?: ErrorHelp;
      /** Continue reads "Retry": the turn ended on an error that trying again may fix. */
      retry?: true;
      /** The failure's card has a fix button: that is the main action, not Continue. */
      fixable?: true;
    }
  /** An error, in plain words with the buttons that fix it (error-help.ts). */
  | { kind: "error"; help: ErrorHelp }
  /**
   * A task the agent put in the TODO list (schedule_task), or changed or cancelled there (change, with the
   * changeId its Undo names): its first line, its schedule in words, and whether the user undid it from the card.
   */
  | { kind: "scheduled"; taskId: string; title: string; instructions: string; when: string; change?: TodoChange; changeId?: string; undone?: true }
  /** An action waiting for the user's OK, or how that ended (approval-view.ts). */
  | ApprovalView
  /** The agent's memory changed from this chat (memory-view.ts): "Remembered: ...", with Undo. */
  | MemoryNoteView;

/** The events of the turn that `events[endIndex]` (a task_end) closes: those since the previous task_end. */
function turnBefore(events: readonly AgentEvent[], endIndex: number): AgentEvent[] {
  let start = endIndex;
  while (start > 0 && events[start - 1]!.type !== "task_end") start--;
  return events.slice(start, endIndex);
}

/**
 * The element picks of the turn that `events[endIndex]` (a task_end) closes:
 * the status line with picks since the previous task_end.
 */
export function turnPicks(events: readonly AgentEvent[], endIndex: number): ElementPicks | undefined {
  const picked = turnBefore(events, endIndex).reverse().find((e) => e.type === "status" && !!e.picks);
  return picked?.type === "status" ? picked.picks : undefined;
}

/** The last error the turn that `events[endIndex]` closes already showed as a card of its own. */
export function turnError(events: readonly AgentEvent[], endIndex: number): string | undefined {
  const err = turnBefore(events, endIndex).reverse().find((e) => e.type === "error");
  return err?.type === "error" ? err.text : undefined;
}

/** What a task_end's view needs from the rest of its turn (see turnPicks and turnError), and a spoken line's (spokenEchoes). */
export interface TurnContext {
  picks?: ElementPicks | undefined;
  /** An error the turn already showed as its own card. */
  error?: string | undefined;
  /** A spoken line repeats what is written above it. */
  echo?: boolean;
  /** A task_scheduled or task_changed: the user undid it since (a task_unscheduled or task_change_undone of it follows). */
  undone?: boolean;
  /** An approval_request: how it ended (approvalEnding); absent while it waits. */
  approval?: Parameters<typeof approvalView>[1];
  /** A memory change: the user undid it since (a memory_undone of the same change follows it). */
  memoryUndone?: boolean;
}

/** Text compared for sameness: letters and digits only, lower case. */
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The same words, whatever the case, spacing and punctuation. */
export const sameWords = (a: string, b: string): boolean => comparable(a) === comparable(b);

/**
 * Whether the spoken line `events[index]` says what the turn already shows in
 * writing: the first sentence of the agent's text or of the turn's summary
 * (the plan read out, a summary that is the answer's first line).
 */
export function spokenEchoes(events: readonly AgentEvent[], index: number): boolean {
  const ev = events[index];
  if (ev?.type !== "spoken") return false;
  const said = comparable(ev.text);
  for (let i = index - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user_message") return false;
    const written = e.type === "assistant_text" ? e.text : e.type === "task_end" ? (e.summary ?? "") : "";
    if (written && comparable(speakable(written, Infinity)) === said) return true;
  }
  return false;
}

/**
 * A turn's end card. A failure is shown once: when the turn already showed
 * its error, the end card does not repeat it (it keeps the outcome and
 * Continue); otherwise a reason that is a known error becomes the error card.
 * Other reasons (e.g. the agent's own "the site asked for a captcha") read as
 * a summary, as before.
 */
function describeEnd(ev: Extract<AgentEvent, { type: "task_end" }>, turn: TurnContext): EventView {
  const reason = (ev.summary || ev.reason || "").trim();
  const failed = ev.outcome !== "done";
  const shown = failed && turn.error !== undefined ? errorHelp(turn.error) : undefined;
  const fromReason = failed && !shown && reason ? errorHelp(reason) : undefined;
  const error = fromReason?.known ? fromReason : undefined;
  const text = shown || error ? "" : reason;
  return {
    kind: "end",
    chip: outcomeChip(ev.outcome),
    text,
    ...(ev.url ? { url: ev.url } : {}),
    ...(turn.picks ? { picks: picksText(turn.picks) } : {}),
    ...(isLongSummary(text) ? { long: true as const } : {}),
    ...(error ? { error } : {}),
    ...((shown ?? error)?.retry ? { retry: true as const } : {}),
    ...((shown ?? error)?.fixes.length ? { fixable: true as const } : {}),
  };
}

export type ScheduledView = Extract<EventView, { kind: "scheduled" }>;

/**
 * A task_scheduled's or task_changed's card; undone: the user undid it since. Its schedule is put in words now, in
 * the browser's zone (a card read the next day no longer says "today").
 */
export function scheduledView(
  ev: Extract<AgentEvent, { type: "task_scheduled" | "task_changed" }>,
  undone: boolean,
  opts: { now?: Date; timeZone?: string; hour12?: boolean } = {},
): ScheduledView {
  const when = describeSchedule(ev.schedule, { now: opts.now ?? new Date(), timeZone: opts.timeZone ?? localTimeZone(), ...(opts.hour12 === undefined ? {} : { hour12: opts.hour12 }) });
  const v: ScheduledView = {
    kind: "scheduled",
    taskId: ev.taskId,
    title: firstLine(ev.instructions),
    instructions: ev.instructions,
    when,
    ...(ev.type === "task_changed" ? { change: ev.change, changeId: ev.changeId } : {}),
  };
  return undone ? { ...v, undone: true } : v;
}

/** turn: for a task_end, what its turn held (see TurnContext). */
export function describeEvent(ev: AgentEvent, turn: TurnContext = {}): EventView {
  switch (ev.type) {
    case "status":
      return ev.picks ? { kind: "status", text: ev.text, picks: true } : { kind: "status", text: ev.text };
    case "assistant_text":
      return ev.id ? { kind: "text", text: ev.text.trim(), id: ev.id } : { kind: "text", text: ev.text.trim() };
    case "assistant_text_delta":
      // Live text is shown by the chat as it streams (see chat.ts); as an event it is its block's text so far.
      return { kind: "text", text: ev.text, id: ev.id };
    case "tool_call":
      return { kind: "tool", id: ev.id, name: ev.name, args: toolArgsSummary(ev.name, ev.args) };
    case "tool_result": {
      const full = ev.text ?? "";
      const preview = clip(full, 90) || (ev.thumbnail ? "image" : ev.isError ? "error" : "ok");
      return {
        kind: "result",
        id: ev.id,
        name: ev.name,
        preview,
        full,
        isError: !!ev.isError,
        ...(ev.thumbnail ? { thumbnail: ev.thumbnail } : {}),
      };
    }
    case "jev": {
      const target = ev.index === null ? "" : ` #${ev.index}`;
      return {
        kind: "jev",
        // Say plainly who made the decision: Jev did it, or Jev was unsure and Claude takes over.
        label: ev.executed ? `Jev: ${ev.operation}${target} · ${ev.confidence.toFixed(2)}` : `Jev unsure (${ev.confidence.toFixed(2)}) · Claude decides`,
        ms: ev.ms,
        executed: ev.executed,
        title: `Jev (a faster helper for simple clicks and typing): ${ev.goal}${ev.executed ? "" : " (not confident, left to Claude)"}`,
      };
    }
    case "user_message":
      if (isScreenHelp(ev.text)) return { kind: "user", text: ev.text, screen: true };
      return ev.voice ? { kind: "user", text: ev.text, voice: true } : { kind: "user", text: ev.text };
    case "spoken":
      return turn.echo ? { kind: "spoken", text: ev.text, echo: true } : { kind: "spoken", text: ev.text };
    case "heard":
      // Nothing went to the agent for these words: not a message.
      if (!ev.sent) return { kind: "heard", text: ev.text };
      return handoffDiffers(ev.text, ev.sent) ? { kind: "user", text: ev.text, voice: true, sent: ev.sent } : { kind: "user", text: ev.text, voice: true };
    case "task_end":
      return describeEnd(ev, turn);
    case "error":
      return { kind: "error", help: errorHelp(ev.text) };
    case "task_scheduled":
      return scheduledView(ev, !!turn.undone);
    case "task_unscheduled":
      // It changes its task_scheduled card (see turn.undone); the chat shows nothing of its own for it.
      return { kind: "status", text: "" };
    case "task_changed":
      return scheduledView(ev, !!turn.undone);
    case "task_change_undone":
      // It changes its task_changed card (see turn.undone); nothing of its own.
      return { kind: "status", text: "" };
    case "approval_request":
      return approvalView(ev, turn.approval);
    case "approval_resolved":
      // It changes its approval card (see turn.approval); nothing of its own.
      return { kind: "status", text: "" };
    case "memory":
      return memoryNoteView(ev, !!turn.memoryUndone);
    case "memory_undone":
      // It changes its memory note (see turn.memoryUndone); nothing of its own.
      return { kind: "status", text: "" };
    case "trace":
      // Timing goes to the conversation's trace (the Raw view), never into the chat: an empty line if one got here.
      return { kind: "status", text: "" };
  }
}

/** The conversation's first message: what was asked, as the first bubble of the thread. */
export interface OpeningView {
  /** The prompt as typed, or the task's instructions (only its one-line title for runs that did not save them). */
  text: string;
  /** An empty send: "look at the page" (shown quieter, with an eye). */
  screen?: true;
  /** Not typed in Chat: where the instructions came from. */
  origin?: string;
  /** Spoken (hands-free voice), not typed. */
  voice?: true;
  /** What the Realtime narrator passed to the agent, when the text is the user's own words and it says something else. */
  sent?: string;
  /** How many files the first turn came with (their names are not saved with the run). */
  files?: number;
  /** When the conversation started: "14:30", "yesterday 23:00". */
  when: string;
  /** The same moment (ISO), for the timestamp's tooltip. */
  at: string;
}

const ORIGIN_OF: Partial<Record<TaskSource, string>> = { local: "From your TODO list", cloud: "Scheduled" };
/** The status line a first turn with files starts with (see run/turn.ts). */
const PREPARING_FILES = /^Preparing (\d+) file\(s\)$/;

/** The prompt as typed, or the task's instructions (only its one-line title for runs that did not save them). */
const firstMessage = (s: SessionInfo): string => (s.source === "adhoc" && s.instructions?.trim()) || s.title;

/** The spoken first message as the agent got it, for pairHeard (null: it was not spoken). */
export const openingText = (s: SessionInfo): string | null => (s.voice ? firstMessage(s) : null);

/**
 * The first message of a conversation, from its session and its events (the first turn's files). `heard`: the
 * user's own words for it (see pairHeard), shown in place of the request the agent got.
 */
export function openingTurn(s: SessionInfo, events: readonly AgentEvent[], now = Date.now(), heard?: Extract<AgentEvent, { type: "heard" }>): OpeningView {
  const text = firstMessage(s);
  const at = s.firstStartedAt ?? s.startedAt;
  const v: OpeningView = { text, when: clockLabel(at, now).replace(/^today /, ""), at };
  if (s.source === "adhoc" && isScreenHelp(text)) v.screen = true;
  else if (s.voice) v.voice = true;
  if (v.voice && heard) {
    v.text = heard.text;
    if (heard.sent && handoffDiffers(heard.text, heard.sent)) v.sent = heard.sent;
  }
  const origin = ORIGIN_OF[s.source];
  if (origin) v.origin = origin;
  const firstEnd = events.findIndex((e) => e.type === "task_end");
  for (const e of firstEnd < 0 ? events : events.slice(0, firstEnd)) {
    const n = e.type === "status" ? PREPARING_FILES.exec(e.text)?.[1] : undefined;
    if (n) v.files = Number(n);
  }
  return v;
}

/**
 * The line a brain writes as its session starts: "BrowserTODO AI (claude-opus-5-5) with Jev" or
 * "Claude API (claude-sonnet-5)" (core's api-agent with the brain's label), "Claude Code started
 * (claude-sonnet-5)" (the helper). Case-insensitive: older sessions spelled the hosted AI in lower case.
 */
const BRAIN_START = /^(?:Claude Code started(?: \([^()]*\))?|(?:Claude API|BrowserTODO AI) \([^()]*\)(?: with Jev)?)$/i;

/** A brain's start line: the chat's brain chip says the same, so the chat leaves it out. */
export function isBrainStartLine(text: string): boolean {
  return BRAIN_START.test(text.trim());
}

/** The user's turn was an empty message in Chat: look at the page (SCREEN_HELP_TEXT). */
export function isScreenHelp(text: string | undefined): boolean {
  return text?.trim() === SCREEN_HELP_TEXT;
}

/**
 * Below this share of words in common, the narrator's request says something else than the user's own words, and
 * the request is shown under them ("Sent to agent: ..."). At or above it, it only rephrased them.
 */
export const HANDOFF_OVERLAP_MIN = 0.6;

/**
 * The narrator's request differs meaningfully from what the user said: the words they share (each counted as
 * often as both have it) make up less than HANDOFF_OVERLAP_MIN of the longer of the two.
 */
export function handoffDiffers(said: string, sent: string): boolean {
  return sharedWordShare(said, sent) < HANDOFF_OVERLAP_MIN;
}

/** Which user's own words (heard events) take the place of which voice message (see pairHeard). */
export interface HeardPairs {
  /** The heard event shown as the conversation's first message. */
  opening?: number;
  /** A voice user_message's index -> the heard event shown in its place. */
  messages: Map<number, number>;
  /** Heard events shown in a message's place (not on their own). */
  placed: Set<number>;
}

/**
 * Pairs each heard event that carries a request (sent) with the voice message that request became: the first
 * message (`opening`: its text; null when it was not spoken) or a voice user_message with the same words. Keyed by
 * the words, not the order: the heard event may be kept before or after its message. The nearest message before it
 * wins, else the first after it. Heard events without a message stay on their own.
 */
export function pairHeard(events: readonly AgentEvent[], opening: string | null): HeardPairs {
  const pairs: HeardPairs = { messages: new Map(), placed: new Set() };
  const taken = new Set<number>();
  events.forEach((ev, h) => {
    if (ev.type !== "heard" || !ev.sent) return;
    const sent = ev.sent;
    const fits = (i: number) => !taken.has(i) && (i < 0 ? opening !== null && sameWords(opening, sent) : isVoiceMessage(events[i], sent));
    let at: number | null = null;
    for (let i = h - 1; i >= -1 && at === null; i--) if (fits(i)) at = i;
    for (let i = h + 1; i < events.length && at === null; i++) if (fits(i)) at = i;
    if (at === null) return;
    taken.add(at);
    pairs.placed.add(h);
    if (at < 0) pairs.opening = h;
    else pairs.messages.set(at, h);
  });
  return pairs;
}

const isVoiceMessage = (ev: AgentEvent | undefined, text: string) => ev?.type === "user_message" && !!ev.voice && sameWords(ev.text, text);

/** Words said before the conversation existed (see the heard event's early): shown above its first message. */
export const isEarlyHeard = (ev: AgentEvent): boolean => ev.type === "heard" && !!ev.early && !ev.sent;

/** Should a scroll container keep following new content? (within `slack` px of the bottom) */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}
