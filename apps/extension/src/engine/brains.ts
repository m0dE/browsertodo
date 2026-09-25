/**
 * The two brain adapters behind one interface. The runner does not care
 * whether the agent loop runs in the helper (Claude Code) or here (Claude API).
 *
 * Both keep a conversation's agent session after a turn, so the user's next
 * message continues it (continue()): Claude Code stays alive in the helper
 * (helper.continueSession); the Claude API brain keeps the message history in
 * memory. When that session is gone, continue() fails with SessionEndedError
 * and the runner starts a fresh session with a summary instead.
 *
 * The adapters: ClaudeCodeBrain (claude-code-brain.ts) and ApiBrain (api-brain.ts).
 */
import type * as core from "@browsertodo/core";
import type { BrowserCaller } from "@browsertodo/core";
import type { AgentEvent, AgentTask, BrainKind, ExtensionSettings, RunConfig, TaskRunResult } from "@browsertodo/shared";

/** The core functions the engine uses; injected so tests can fake them. */
export type CoreApi = Pick<typeof core, "startApiAgent" | "createJev" | "verifyXPost" | "classifyFailure">;

export interface BrainStartOptions {
  sessionId: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
  settings: ExtensionSettings;
  /**
   * The run's own tab (its agent slot), for brains that act in the extension
   * (the Claude API brain). Claude Code's calls name their session instead.
   */
  browser?: BrowserCaller;
  onEvent(e: AgentEvent): void;
}

/** The next turn of a conversation, in the agent session its earlier turns used. */
export interface BrainContinueOptions {
  sessionId: string;
  /** The user's message. */
  text: string;
  config: RunConfig;
  settings: ExtensionSettings;
  /** The turn's tab (it may differ from the earlier turns' when that slot was busy). */
  browser?: BrowserCaller;
  onEvent(e: AgentEvent): void;
}

export type AbortOutcome = "paused" | "failed" | "retry";

export interface BrainRun {
  /** Types a message into the running session. Resolves false when it could not be delivered. */
  sendUserMessage(text: string): Promise<boolean>;
  /** Stops the agent. The runner decides the final outcome; this only asks the brain to stop. */
  abort(reason: string, outcome: AbortOutcome): void;
  /** Rejects with SessionEndedError when continue() found no agent session to continue. */
  readonly done: Promise<TaskRunResult>;
}

/** continue(): the conversation's agent session is gone (closed, idle timeout, crash, restart). */
export class SessionEndedError extends Error {
  constructor(detail = "session ended") {
    super(detail);
    this.name = "SessionEndedError";
  }
}

export interface Brain {
  readonly kind: BrainKind;
  start(opts: BrainStartOptions): BrainRun;
  /** The next turn in the conversation's own agent session (see SessionEndedError). */
  continue?(opts: BrainContinueOptions): BrainRun;
  /** False when the conversation's agent session is known to be gone. */
  isOpen?(sessionId: string): boolean;
  /** Closes a conversation's kept-open agent session (New chat). */
  end?(sessionId: string): Promise<void>;
  /** Conversations whose agent session is open. */
  openSessions?(): string[];
}

/** A brain that keeps a conversation's agent session between turns. */
export type ContinuableBrain = Brain & Required<Pick<Brain, "continue">>;

export function isContinuable(brain: Brain): brain is ContinuableBrain {
  return typeof brain.continue === "function";
}

/** A run that ended before it started: continue() found no agent session. */
export function endedRun(): BrainRun {
  const done = Promise.reject(new SessionEndedError());
  done.catch(() => {});
  return { done, sendUserMessage: async () => false, abort: () => {} };
}

/** A run that failed before it started. */
export function failedRun(reason: string): BrainRun {
  return { done: Promise.resolve({ outcome: "failed", reason }), sendUserMessage: async () => false, abort: () => {} };
}
