import type { AgentEvent } from "@browsertodo/shared";
import type { EventLogger } from "../logger.js";

/**
 * Messages the human types into a running task. The brain subscribes; the
 * task runner closes it after a task_* call (Claude Code's stdin is then
 * closed so the process can exit).
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
  signal: AbortSignal;
  /** Run log (JSONL file). */
  log: EventLogger;
  /** Sends an AgentEvent to the extension (helper.event) and the run log. */
  emit: (e: AgentEvent) => void;
  /** Messages the human types while the task runs. */
  input: UserInput;
  /**
   * Structured task data. Not needed by ClaudeCodeBrain (it reads `prompt`);
   * the ScriptedBrain uses it to run its deterministic script.
   */
  task?: { instructions: string; account: string | null; mediaPaths: string[] };
}

/**
 * Runs the agent for one task. Returns when the agent process exits (or is
 * aborted). The outcome comes from the task_* tool calls the TaskRunner
 * records, not from the brain.
 */
export interface Brain {
  run(ctx: BrainContext): Promise<void>;
}
