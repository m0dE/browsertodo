import type { AgentEvent } from "@browsertodo/shared";
import type { EventLogger } from "../logger.js";

/**
 * "message": typed while a turn runs (the brain may add its own framing).
 * "followup": the next user turn in a kept-open session, already framed by the runner.
 */
export type UserMessageKind = "message" | "followup";

/**
 * Messages the human types into a session. The brain subscribes. The task
 * runner closes it to end the session: after a task_* call for single-turn
 * brains (Claude Code's stdin is then closed so the process can exit), or
 * when a kept-open session is ended.
 */
export class UserInput {
  private listener: ((text: string, kind: UserMessageKind) => void) | null = null;
  private readonly closeListeners: (() => void)[] = [];
  private readonly queue: [string, UserMessageKind][] = [];
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  /** Returns false when the input is already closed. */
  push(text: string, kind: UserMessageKind = "message"): boolean {
    if (this.isClosed) return false;
    if (this.listener) this.listener(text, kind);
    else this.queue.push([text, kind]);
    return true;
  }

  /** One subscriber; messages pushed before it subscribed are delivered right away. */
  onMessage(fn: (text: string, kind: UserMessageKind) => void): void {
    this.listener = fn;
    for (const [t, k] of this.queue.splice(0)) fn(t, k);
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
  /** Messages the human types (and, for persistent brains, follow-up turns). Closed: end gracefully. */
  input: UserInput;
  /** Persistent brains: the agent is waiting for input (its turn ended). Ends a turn that has no result yet. */
  idle?: () => void;
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
