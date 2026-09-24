/**
 * Public contract of @browsertodo/core: the agent logic shared by the helper
 * (Claude Code brain, via MCP) and the extension (Claude API brain, in the
 * service worker). Runs in Node and in the browser: no Node-only imports.
 */
import type {
  AgentEvent,
  AgentTask,
  BrowserMethod,
  BrowserMethods,
  PageSnapshot,
  RunConfig,
  TaskRunResult,
  ToolName,
  ToolResult,
} from "@browsertodo/shared";

/** Something that performs browser.* and vault.* methods (extension driver, or RPC to it). */
export interface BrowserCaller {
  call<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]>;
}

export type JevOperation = "click" | "type" | "scroll" | "press_key" | "wait" | "done" | "blocked";

export interface JevDecision {
  operation: JevOperation;
  /** Target element index, or null for none. */
  index: number | null;
  /** min(operation confidence, target confidence), 0..1 */
  confidence: number;
}

export interface JevLike {
  decide(input: { goal: string; snapshot: PageSnapshot }): Promise<JevDecision>;
}

export interface ToolExecutorOptions {
  browser: BrowserCaller;
  /** null turns act off (it then answers with an error telling the model to use click/type). */
  jev: JevLike | null;
  jevThreshold: number;
  onEvent: (e: AgentEvent) => void;
  /**
   * Receives task_complete / task_fail / task_pause. When undefined
   * (interactive terminal), task_* tools answer that there is no task to end.
   */
  onTaskEnd?: (r: TaskRunResult) => void;
  /** Absolute local paths the task may upload. upload rejects other paths. */
  mediaPaths: string[];
  /** For tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ToolExecutor {
  /** Validates args with ToolArgs, runs the tool, emits tool_call/tool_result/jev events. Never throws. */
  call(name: ToolName, args: unknown): Promise<ToolResult>;
  readonly callCount: number;
}

/** A running agent. */
export interface AgentSession {
  readonly sessionId: string;
  /** Adds a human message to the conversation before the next model turn. */
  sendUserMessage(text: string): void;
  /** Stops the agent; done resolves with this outcome and reason. */
  abort(reason: string, outcome?: "paused" | "failed" | "retry"): void;
  readonly done: Promise<TaskRunResult>;
}

export interface ApiAgentOptions {
  sessionId: string;
  apiKey: string;
  /** e.g. "claude-sonnet-5" */
  model: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
  browser: BrowserCaller;
  /** null = Jev off. When set, the loop is Jev-first (see spec "Jev-first loop"). */
  jev: JevLike | null;
  onEvent: (e: AgentEvent) => void;
  /** Default globalThis.fetch. */
  fetch?: typeof fetch;
}

export type FailureKind = "transient" | "permanent";

export type { AgentEvent, AgentTask, RunConfig, TaskRunResult, ToolName, ToolResult };
