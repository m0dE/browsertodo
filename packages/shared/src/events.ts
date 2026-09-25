import type { TaskOutcome, TaskSource } from "./task.js";

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
  /** A message the human typed into the running session. */
  | { type: "user_message"; text: string }
  | { type: "task_end"; outcome: TaskOutcome; summary?: string; url?: string; reason?: string }
  | { type: "error"; text: string };

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

/** browsertodo: the hosted "browsertodo AI" (Claude through the account's usage credit). */
export type BrainKind = "claude-code" | "claude-api" | "scripted" | "browsertodo";

/**
 * One conversation with the agent: a queued task or a one-off "do this now"
 * request, plus the follow-up messages the user sent in it. Each message is a
 * turn; every turn's events append to this session's event stream (a
 * follow-up starts with its user_message). startedAt/endedAt, outcome,
 * summary, url and reason describe the latest turn.
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
  /** Adhoc runs: the full instructions and account, so the run can be continued later. */
  instructions?: string;
  account?: string;
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
