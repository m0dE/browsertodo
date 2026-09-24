import type { EventLogger } from "../logger.js";

export interface BrainContext {
  taskId: string;
  prompt: string;
  systemPrompt: string;
  mcpConfigPath: string;
  /** Fully qualified MCP tool names, e.g. mcp__browsertodo__click. */
  allowedTools: string[];
  signal: AbortSignal;
  log: EventLogger;
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
