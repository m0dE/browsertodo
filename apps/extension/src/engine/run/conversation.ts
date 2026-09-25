/**
 * Conversations: a session's next turn after it ended. It continues in the
 * conversation's own agent session when that is still open (Claude Code kept
 * alive, or the Claude API history in memory), otherwise in a fresh one that
 * is told what was done so far. Either way its events append to the same
 * session, so the Activity view shows one thread.
 */
import type { AgentTask, ExtensionSettings, SessionInfo, StampedAgentEvent, TaskRunResult } from "@browsertodo/shared";
import { buildFollowUpInstructions, isContinuableOutcome } from "../../continue.js";
import { SessionEndedError, type Brain } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import { mediaSources, type TurnJob } from "./jobs.js";
import { runConfig, type ActiveSession, type Cleanup, type TurnRunner } from "./turn.js";

/** The message "Continue" sends when the user adds no note. */
export const CONTINUE_TEXT = "Continue from where you stopped.";
export const FRESH_SESSION_STATUS = "The earlier agent session has ended; starting a fresh one with a summary of the conversation";

/** What the brain's continue path is called in the Activity view. */
const SAME_SESSION: Record<string, string> = {
  "claude-code": "Continuing the same Claude Code session",
  "claude-api": "Continuing the same Claude API conversation",
};

/** Why "Continue" cannot apply to this session, or null when it can. */
export function continueRefusal(from: SessionInfo | null, sessionId: string, running: boolean): string | null {
  if (!from) return `No session ${sessionId}`;
  if (!from.endedAt) return running ? "That run is already running" : "That run has not ended yet";
  if (!isContinuableOutcome(from.outcome)) {
    return from.outcome === "done" ? "That run already finished; send a message to go on, or start a new task" : "That run cannot be continued";
  }
  if (from.source === "cloud") return "Cloud tasks continue from the queue; use Retry on the server";
  return null;
}

/**
 * Runs the turn's brain in the conversation's tab (the browser tab it belongs
 * to, else the tab it used): the same agent session when it is open, else a
 * fresh one (also when the brain finds the session gone).
 */
export async function runNextTurn(
  turns: TurnRunner,
  localStore: LocalStore,
  active: ActiveSession,
  job: TurnJob,
  brain: Brain,
  events: readonly StampedAgentEvent[],
  settings: ExtensionSettings,
  cleanups: Cleanup[],
): Promise<TaskRunResult> {
  const { from, text } = job;
  const sessionId = from.sessionId;
  const tab = await turns.tabOf(sessionId);
  if (tab === null) await active.slot.prepare({ mode: "own-tab" });
  else await turns.follow(active, tab, await active.slot.prepare({ mode: "current-tab", tabId: tab }));
  if (active.forced) throw new Error(active.forced.reason);
  const same = from.brain === brain.kind && !!brain.continue && brain.isOpen?.(sessionId) !== false;
  if (same) {
    turns.emit(active, { type: "status", text: SAME_SESSION[brain.kind] ?? "Continuing the same agent session" });
    try {
      const run = turns.continue(active, brain, { text, config: runConfig(settings, false), settings });
      return await turns.drive(active, run, settings, cleanups, true);
    } catch (err) {
      if (!(err instanceof SessionEndedError)) throw err;
    }
  }
  turns.emit(active, { type: "status", text: FRESH_SESSION_STATUS });
  // Nothing echoes the message in a fresh session.
  active.said = [];
  const instructions = buildFollowUpInstructions({ instructions: job.first.instructions, session: from, events, text });
  const sources = job.task ? await mediaSources({ source: "local", task: job.task }, localStore) : [];
  const mediaPaths = await turns.materialize(active, sources, cleanups);
  const task: AgentTask = { id: job.task?.id ?? sessionId, instructions, account: job.first.account };
  // After a stop, the agent first checks whether the work was already done.
  const run = turns.start(active, brain, { task, mediaPaths, config: runConfig(settings, from.outcome !== "done"), settings });
  return turns.drive(active, run, settings, cleanups);
}
