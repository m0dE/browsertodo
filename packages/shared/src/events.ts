import type { TaskOutcome, TaskSource } from "./task.js";

/**
 * Everything an agent run emits, in order. Both brains produce these, the
 * extension stores them per session, and the side panel's activity view
 * renders them live.
 */
export type AgentEvent =
  | { type: "status"; text: string }
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

export type StampedAgentEvent = AgentEvent & { ts: string; sessionId: string };

export type BrainKind = "claude-code" | "claude-api" | "scripted";

/** One agent run: a queued task or a one-off "do this now" request. */
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
}

/** Keep text in events bounded so storage and native messages stay small. */
export const MAX_EVENT_TEXT = 4000;

export function clipEventText(text: string, max = MAX_EVENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}
