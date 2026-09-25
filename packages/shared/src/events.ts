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
  /** Text Claude wrote (thinking out loud or talking to the user). */
  | { type: "assistant_text"; text: string }
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

/** browsertodo: the hosted "browsertodo AI" (Claude through the account's AI credit). */
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

/** Keep text in events bounded so storage and native messages stay small. */
export const MAX_EVENT_TEXT = 4000;

export function clipEventText(text: string, max = MAX_EVENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}
