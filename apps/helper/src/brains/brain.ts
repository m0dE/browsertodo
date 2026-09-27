import type { AgentEvent } from "@browsertodo/shared";
import type { Interjections, ReasoningChange } from "@browsertodo/core";
import type { EventLogger } from "../logger.js";

/**
 * The user's next turns in a kept-open session (already framed by the
 * runner). The brain subscribes. The task runner closes it to end the
 * session: after a task_* call for single-turn brains (Claude Code's stdin is
 * then closed so the process can exit), or when a kept-open session is ended.
 * Messages typed while a turn runs are not here: see BrainContext.interjections.
 */
export class UserInput {
  private listener: ((text: string) => void) | null = null;
  private readonly closeListeners: (() => void)[] = [];
  private readonly queue: string[] = [];
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  /** Returns false when the input is already closed. */
  push(text: string): boolean {
    if (this.isClosed) return false;
    if (this.listener) this.listener(text);
    else this.queue.push(text);
    return true;
  }

  /** One subscriber; messages pushed before it subscribed are delivered right away. */
  onMessage(fn: (text: string) => void): void {
    this.listener = fn;
    for (const t of this.queue.splice(0)) fn(t);
  }

  onClose(fn: () => void): void {
    if (this.isClosed) fn();
    else this.closeListeners.push(fn);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const fn of this.closeListeners.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The session's reasoning (core ReasoningGovernor), as a brain follows it:
 * whether the model thinks now, and each change while the session runs.
 */
export interface ReasoningChannel {
  readonly thinking: boolean;
  /** One listener per brain: a raise (a stuck Fast run), a lower (a step worked) or a new turn's level. */
  onChange(fn: (change: ReasoningChange) => void): void;
}

export interface BrainContext {
  /** Pipe task id (the session id) used for tool calls. */
  taskId: string;
  prompt: string;
  systemPrompt: string;
  /** Model chosen in the extension for this run; the brain's own default when absent. */
  model?: string;
  mcpConfigPath: string;
  /** Fully qualified MCP tool names, e.g. mcp__browsertodo__click. */
  allowedTools: string[];
  /** Aborted when the session must stop now (abort, pause, limits, shutdown): kill the agent. */
  signal: AbortSignal;
  /** Run log (JSONL file). */
  log: EventLogger;
  /** Sends an AgentEvent to the extension (helper.event) and the run log. */
  emit: (e: AgentEvent) => void;
  /** Follow-up turns (persistent brains). Closed: end gracefully. */
  input: UserInput;
  /**
   * Messages the user types while a turn runs. The tool executor hands them
   * over with the next tool result and refuses task_* until the model read
   * them; the brain delivers them itself when no tool result is coming (the
   * model is only writing, or its turn ended).
   */
  interjections: Interjections;
  /** Persistent brains: the agent is waiting for input (its turn ended). Ends a turn that has no result yet. */
  idle?: () => void;
  /** How much the model thinks (the Reasoning setting, raised while a Fast run is stuck). Absent: the brain's own default. */
  reasoning?: ReasoningChannel;
  /**
   * Structured task data. Not needed by ClaudeCodeBrain (it reads `prompt`);
   * the ScriptedBrain uses it to run its deterministic script.
   */
  task?: { instructions: string; account: string | null; mediaPaths: string[] };
}

/**
 * Runs the agent for one session. Returns when the agent process exits (or is
 * aborted). The outcome of each turn comes from the task_* tool calls the
 * TaskRunner records, not from the brain.
 */
export interface Brain {
  /**
   * True when the agent stays alive after a task_* call, waiting for the
   * next message (a follow-up turn, see TaskRunner.continueSession).
   * Otherwise the runner closes the input after the first task_* call.
   */
  readonly persistent?: boolean;
  run(ctx: BrainContext): Promise<void>;
}
