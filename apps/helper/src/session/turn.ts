/**
 * One turn of a task session: from the first message (or a follow-up) to its
 * task_* call. Holds the turn's limits (tool calls, time) and turns its state
 * into the TaskRunResult the extension gets.
 */
import type { RunConfig, TaskRunResult, ToolName } from "@browsertodo/shared";

const IDLE_TURN_REASON = "agent ended its turn without reporting a result";

/** Past maxToolCalls the agent is told to call task_fail; this many calls past the max the turn is stopped. */
const TOOL_CALL_STOP_MARGIN = 5;

export interface Turn {
  config: RunConfig;
  finish: TaskRunResult | null;
  forcedPause: string | null;
  abortReason: string | null;
  timedOut: boolean;
  /** Persistent brains: the agent went idle without a task_* call. */
  idleEnd: boolean;
  lastError: string | null;
  toolCalls: number;
  timeLimit?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Resolves the turn's wait early (persistent brains: result recorded, or idle). */
  settle: () => void;
  settled: Promise<void>;
}

export function createTurn(config: RunConfig): Turn {
  let settle!: () => void;
  const settled = new Promise<void>((r) => (settle = r));
  return {
    config,
    finish: null,
    forcedPause: null,
    abortReason: null,
    timedOut: false,
    idleEnd: false,
    lastError: null,
    toolCalls: 0,
    settle,
    settled,
  };
}

export function clearTurnTimers(t: Turn): void {
  clearTimeout(t.timeLimit);
  if (t.graceTimer) clearTimeout(t.graceTimer);
}

/**
 * Counts a tool call against the turn's limit (task_* calls are free).
 * `refusal`: text returned to the agent instead of running the tool.
 * `stop`: the limit is far exceeded; the caller aborts the turn.
 */
export function checkToolCall(t: Turn, name: ToolName): { refusal: string | null; stop?: true } {
  const isFinish = name.startsWith("task_");
  if (t.finish) return { refusal: isFinish ? "The task result was already recorded. Stop now." : "The task is finished. Stop now." };
  if (isFinish) return { refusal: null };
  t.toolCalls++;
  const max = t.config.maxToolCalls;
  if (t.toolCalls >= max + TOOL_CALL_STOP_MARGIN) {
    if (t.abortReason === null) t.abortReason = `tool call limit exceeded (${max} calls)`;
    return { refusal: "Tool call limit exceeded. The task was stopped.", stop: true };
  }
  if (t.toolCalls > max) return { refusal: `Tool call limit of ${max} reached. Call task_fail now with a short reason.` };
  return { refusal: null };
}

/** The turn's outcome. `brainError`: the brain crashed (session-wide). */
export function turnResult(t: Turn, brainError: string | null): TaskRunResult {
  if (t.forcedPause !== null) return { outcome: "paused", reason: t.forcedPause };
  if (t.finish) return { ...t.finish };
  if (t.abortReason !== null) return { outcome: "failed", reason: t.abortReason };
  if (t.timedOut) return { outcome: "failed", reason: `task time limit of ${t.config.maxTaskMinutes} minutes reached` };
  if (brainError) return { outcome: "failed", reason: `agent error: ${brainError}` };
  // e.g. "Claude Code: Claude AI usage limit reached" (the extension classifies it as temporary)
  if (t.lastError) return { outcome: "failed", reason: t.lastError };
  if (t.idleEnd) return { outcome: "failed", reason: IDLE_TURN_REASON };
  return { outcome: "failed", reason: "agent exited without reporting a result" };
}
