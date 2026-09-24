/**
 * Routes MCP tool calls (from the per-task or interactive MCP server, over the
 * pipe) to the right @browsertodo/core tool executor: the running task's, or
 * the interactive terminal's (task id "interactive").
 */
import { TOOL_NAMES, type BrowserMethod, type BrowserMethods, type ToolName, type ToolResult } from "@browsertodo/shared";
import type { BrowserCaller, ToolExecutor } from "@browsertodo/core";

export const BROWSER_RPC_TIMEOUT_MS = 60_000;
export const INTERACTIVE_TASK_ID = "interactive";

/** Structural view of RpcPeer<BrowserMethods, ...> (it takes a timeout option). */
export interface RpcBrowser {
  call<M extends BrowserMethod>(
    method: M,
    params: BrowserMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<BrowserMethods[M]["result"]>;
}

/** A core BrowserCaller over the extension RPC, with a per-call timeout. */
export function rpcBrowser(peer: RpcBrowser, timeoutMs = BROWSER_RPC_TIMEOUT_MS): BrowserCaller {
  return { call: (method, params) => peer.call(method, params, { timeoutMs }) };
}

/** The running task, as seen by the router. Implemented by TaskRunner. */
export interface ToolSession {
  taskId: string;
  allowedTools: ReadonlySet<ToolName>;
  /** Called before each tool. Returns an error text to return instead of running it. */
  beforeCall(name: ToolName): string | null;
  executor: ToolExecutor;
}

export interface InteractiveTools {
  allowedTools: ReadonlySet<ToolName>;
  executor: ToolExecutor;
}

const err = (text: string): ToolResult => ({ text, isError: true });

export class ToolRouter {
  constructor(
    private readonly deps: {
      getSession: () => ToolSession | null;
      /** The interactive terminal's tools; null when not available. */
      getInteractive?: () => InteractiveTools | null;
    },
  ) {}

  /** Tool names the given task may use (for `tool.list`). */
  allowedTools(taskId: string): ToolName[] {
    const target = this.target(taskId);
    return target ? TOOL_NAMES.filter((n) => target.allowedTools.has(n)) : [];
  }

  async call(taskId: string, name: ToolName, args: unknown): Promise<ToolResult> {
    const target = this.target(taskId);
    if (!target) return err(`No running task ${taskId}. Stop now.`);
    if (taskId === INTERACTIVE_TASK_ID && this.deps.getSession()) {
      return err("A browsertodo task is using the browser right now. Wait for it to finish, then try again.");
    }
    if (!(TOOL_NAMES as string[]).includes(name) || !target.allowedTools.has(name)) {
      return err(`Tool ${name} is not available${taskId === INTERACTIVE_TASK_ID ? " in the interactive terminal" : " for this task"}.`);
    }
    if ("beforeCall" in target) {
      const blocked = target.beforeCall(name);
      if (blocked) return err(blocked);
    }
    return target.executor.call(name, args);
  }

  private target(taskId: string): ToolSession | InteractiveTools | null {
    if (taskId === INTERACTIVE_TASK_ID) return this.deps.getInteractive?.() ?? null;
    const s = this.deps.getSession();
    return s && s.taskId === taskId ? s : null;
  }
}
