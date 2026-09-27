import type { ApprovalOutcome, ApprovalRequest } from "./automation.js";
import type { MemoryEntry } from "./memory.js";
import type { TaskOutcome, TaskSource } from "./task.js";
import type { ScheduleInput } from "./schedule.js";
import type { TodoChange, TodoTaskFields } from "./schedule-task.js";
import type { TraceEvent } from "./trace.js";

/**
 * Everything an agent run emits, in order. Both brains produce these, the
 * extension stores them per session, and the side panel's activity view
 * renders them live.
 */
export type AgentEvent =
  | {
      type: "status";
      text: string;
      /**
       * Set on the status line at the end of a turn with Jev on: who picked
       * the elements of act's clicks and typing ("Jev chose 9 of 11 ...").
       */
      picks?: ElementPicks;
    }
  /**
   * Text Claude wrote (thinking out loud or talking to the user). `id`: the
   * text block it completes when it was streamed first (see
   * assistant_text_delta); the chat replaces the streamed text with it.
   */
  | { type: "assistant_text"; text: string; id?: string }
  /**
   * Live text as Claude writes it: `text` is appended to the block `id`
   * ("<message id>:<block index>"). Transient: shown in the chat while it
   * grows, never stored or written to run logs. The block's final
   * assistant_text (same id) replaces it.
   */
  | { type: "assistant_text_delta"; id: string; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      text?: string;
      isError?: boolean;
      /** Small JPEG thumbnail (base64, no data: prefix) when the tool returned an image. */
      thumbnail?: string;
    }
  | {
      type: "jev";
      goal: string;
      operation: string;
      index: number | null;
      confidence: number;
      executed: boolean;
      ms: number;
    }
  /** A message the human sent in the conversation (voice: it was spoken, in hands-free voice). */
  | { type: "user_message"; text: string; voice?: true }
  /**
   * suggestion: the agent's proposed next request (TaskRunResult.suggestion);
   * spoken: the outcome as one or two sentences hands-free voice reads aloud (TaskRunResult.spoken).
   */
  | { type: "task_end"; outcome: TaskOutcome; summary?: string; url?: string; reason?: string; suggestion?: string; spoken?: string }
  | { type: "error"; text: string }
  /**
   * A line hands-free voice said aloud in this conversation (the plan, a
   * question, the result, the Realtime narrator's reply), kept in the thread.
   * Written by the side panel, never by a brain.
   */
  | { type: "spoken"; text: string }
  /**
   * What the user said in a Realtime hands-free turn, word for word (the
   * narrator's input transcription), kept in the thread as their voice
   * message. sent: what the narrator passed to the agent for it (that
   * request's own voice message then shows these words instead). Without
   * sent, nothing went to the agent (thinking aloud, "one sec"): the chat
   * shows it as a muted line, not a message. early: said in the hands-free
   * session before this conversation existed, kept when a request started it
   * (shown above its first message). Written by the side panel, never by a
   * brain.
   */
  | { type: "heard"; text: string; sent?: string; early?: true }
  /**
   * The agent put a task in the user's TODO list from the chat
   * (schedule_task): the chat shows it as a card with View in TODO and Undo.
   * schedule: as the agent asked for it (the card says it in words when shown,
   * so "today" stays true). Written by the extension, never by a brain.
   */
  | { type: "task_scheduled"; taskId: string; instructions: string; schedule: ScheduleInput }
  /** The user undid a task_scheduled from its card (the task was deleted). Written by the extension. */
  | { type: "task_unscheduled"; taskId: string }
  /**
   * The agent changed or cancelled a task in the user's TODO list (update_scheduled_task,
   * cancel_scheduled_task): the chat shows a card with View in TODO and Undo. changeId: what Undo names
   * (one task may change more than once). instructions / schedule: the task after the change (a cancelled
   * one as it was). before: an updated task's fields before the change (Undo puts them back; a cancel is
   * undone by putting the task back in the queue). Written by the extension, never by a brain.
   */
  | { type: "task_changed"; changeId: string; taskId: string; change: TodoChange; instructions: string; schedule: ScheduleInput; before?: TodoTaskFields }
  /** The user undid a task_changed from its card. Written by the extension. */
  | { type: "task_change_undone"; changeId: string }
  /**
   * An action waits for the user's OK (the automation level, automation.ts):
   * the chat shows it as a card with Allow once, Allow for this task and
   * Deny. Written by the extension, never by a brain.
   */
  | { type: "approval_request"; request: ApprovalRequest }
  /** How that approval request ended (by: answered by voice). Written by the extension. */
  | { type: "approval_resolved"; id: string; outcome: ApprovalOutcome; by?: "voice" }
  /**
   * The agent's memory changed from this conversation (remember, forget, a task's run note): the chat shows
   * "Remembered: ..." with Undo. before / after: the entry before and after the change (null: it did not exist /
   * it was forgotten); Undo puts `before` back. replaced: an entry it replaced under another subject (remember's
   * `replaces`), which Undo puts back too. auto: saved by the background writer after the conversation, not by the
   * agent. Written by the extension, never by a brain.
   */
  | { type: "memory"; changeId: string; before: MemoryEntry | null; after: MemoryEntry | null; replaced?: MemoryEntry; auto?: true }
  /** The user undid that memory change from its note. Written by the extension. */
  | { type: "memory_undone"; changeId: string }
  /**
   * Timing for the conversation's trace (trace.ts): a model call, a tool's
   * duration, Claude Code's start. Never shown in the chat or stored with the
   * events: the extension keeps it in the conversation's trace.
   */
  | { type: "trace"; trace: TraceEvent };

/** Element picks of act steps (clicks and typing) in a turn: by Jev, or by Claude naming an index. */
export interface ElementPicks {
  jev: number;
  claude: number;
}

/** "Jev chose 9 of 11 element picks (clicks and typing)". */
export function picksText(p: ElementPicks): string {
  const total = p.jev + p.claude;
  return `Jev chose ${p.jev} of ${total} element pick${total === 1 ? "" : "s"} (clicks and typing)${p.claude ? `; Claude chose ${p.claude}` : ""}`;
}

export type StampedAgentEvent = AgentEvent & { ts: string; sessionId: string };

/** browsertodo: the hosted "BrowserTODO AI" (Claude through the account's usage credit). */
export type BrainKind = "claude-code" | "claude-api" | "scripted" | "browsertodo";

/**
 * One conversation with the agent: a queued task or a one-off "do this now"
 * request, plus the follow-up messages the user sent in it. Each message is a
 * turn; every turn's events append to this session's event stream (a
 * follow-up starts with its user_message). startedAt/endedAt, outcome,
 * summary, url, reason and suggestion describe the latest turn.
 */
export interface SessionInfo {
  sessionId: string;
  source: TaskSource;
  /** Local or cloud task id; absent for adhoc runs. */
  taskId?: string;
  title: string;
  brain: BrainKind;
  jev: boolean;
  startedAt: string;
  endedAt?: string;
  outcome?: TaskOutcome;
  summary?: string;
  url?: string;
  reason?: string;
  /**
   * The agent's proposed next request after the latest turn: the chat's input
   * box offers it faded (Tab takes it) until the next message is sent.
   */
  suggestion?: string;
  /** Adhoc runs: the full instructions and account, so the run can be continued later. */
  instructions?: string;
  account?: string;
  /** The first message was spoken (hands-free voice), not typed. */
  voice?: true;
  /** Set when this run continues an earlier stopped one ("Continue"). */
  continuedFrom?: string;
  /** Turns in this conversation so far (absent: 1). */
  turns?: number;
  /** When the conversation's first turn started (startedAt is the latest turn's). */
  firstStartedAt?: string;
  /** The Claude model the latest turn used (the model setting, e.g. "claude-sonnet-5"). */
  model?: string;
  /** Claude Code sessions: the helper's run log of the latest turn (see helper.runLog). */
  logPath?: string;
  /** The user turned memory off for this conversation: the agent is given none and saves none in it. */
  memoryOff?: true;
}

/** Streamed text deltas are sent at most this often per stream (ms). */
export const DELTA_BATCH_MS = 50;

/** The message part of a stream id ("<message id>:<block index>"). */
export function streamMessageOf(id: string): string {
  const i = id.lastIndexOf(":");
  return i < 0 ? id : id.slice(0, i);
}

/**
 * Batches assistant_text_delta events: text deltas of one block are joined
 * and sent at most every `ms`. Every other event goes through emit(), which
 * first sends what is pending, so the order of events is kept.
 */
export class DeltaBatcher {
  private pending: { id: string; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly out: (e: AgentEvent) => void,
    private readonly ms = DELTA_BATCH_MS,
  ) {}

  delta(id: string, text: string): void {
    if (!text) return;
    if (this.pending && this.pending.id !== id) this.flush();
    if (this.pending) this.pending.text += text;
    else this.pending = { id, text };
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.ms);
  }

  emit(e: AgentEvent): void {
    this.flush();
    this.out(e);
  }

  /** Sends pending text now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p) this.out({ type: "assistant_text_delta", id: p.id, text: p.text });
  }

  /** Drops pending text (the stream was abandoned). */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/** Keep text in events bounded so storage and native messages stay small. */
export const MAX_EVENT_TEXT = 4000;
/** Claude's own text (answers in the chat, task summaries) may be longer. */
export const MAX_ASSISTANT_TEXT = 20_000;

export function clipEventText(text: string, max = MAX_EVENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}
