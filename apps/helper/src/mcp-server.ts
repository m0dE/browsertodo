/**
 * Stdio MCP server that exposes the browsertodo tools and relays every call
 * over the named pipe to the helper.
 *
 * Spawned by a task session's Claude Code (see the session's mcp-config.json), with env:
 *   BROWSERTODO_PIPE   pipe path of the helper
 *   BROWSERTODO_TASK   session id of the task (empty: the attached session's tools)
 *   BROWSERTODO_TOOLS  comma list of tool names to register (default: all)
 *
 * Or from the user's own Claude Code:
 *   claude mcp add browsertodo -- node <repo>/apps/helper/dist/mcp-server.js --attach
 * which finds the running helper through %LOCALAPPDATA%\browsertodo\helper.json
 * and offers the interactive tools (no task_*).
 *
 * stdout carries MCP JSON-RPC only; diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { INTERACTIVE_TOOL_NAMES, MCP_SERVER_NAME, TOOL_DESCRIPTIONS, ToolArgs, type ToolName } from "@browsertodo/shared";
import { connectPipe, type PipeClient } from "./pipe-server.js";
import { INTERACTIVE_TASK_ID, TOOL_CALL_TIMEOUT_MS, toMcpResult, toolsFromEnv } from "./mcp-tools.js";
import { HELPER_VERSION, loadConfig } from "./config.js";
import { isPidAlive, readHelperFile } from "./helper-file.js";
import { errorMessage } from "./logger.js";

const NOT_RUNNING =
  "browsertodo helper is not running: open Chrome with the browsertodo extension (it starts the helper), then restart this MCP server.";

/** Diagnostics go to stderr: stdout carries MCP frames only. */
function warn(message: string): void {
  process.stderr.write(`browsertodo mcp-server: ${message}\n`);
}

function fail(message: string, code = 1): never {
  warn(message);
  process.exit(code);
}

async function main(): Promise<void> {
  // Safety net: keep stdout for MCP frames only.
  const toStderr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const attach = process.argv.includes("--attach");
  let pipePath: string;
  let taskId: string;
  let tools: ToolName[];
  if (attach) {
    const cfg = loadConfig();
    const info = readHelperFile(cfg.helperFilePath);
    if (!info || !isPidAlive(info.pid)) fail(NOT_RUNNING);
    pipePath = info.pipe;
    taskId = INTERACTIVE_TASK_ID;
    tools = [...INTERACTIVE_TOOL_NAMES];
  } else {
    const p = process.env.BROWSERTODO_PIPE;
    if (!p) fail("BROWSERTODO_PIPE is not set (use --attach to connect to the running helper)", 2);
    pipePath = p;
    taskId = process.env.BROWSERTODO_TASK || INTERACTIVE_TASK_ID;
    tools = toolsFromEnv(process.env.BROWSERTODO_TOOLS);
  }

  let pipe: PipeClient;
  try {
    pipe = await connectPipe(pipePath);
  } catch (e) {
    fail(attach ? NOT_RUNNING : `cannot connect to ${pipePath}: ${errorMessage(e)}`);
  }
  if (attach) {
    // Ask the helper which tools this session allows.
    try {
      const { names } = await pipe.peer.call("tool.list", { taskId }, { timeoutMs: 5000 });
      if (names.length) tools = tools.filter((n) => names.includes(n));
    } catch {
      /* older helper: keep the full interactive list */
    }
  }

  const server = new McpServer({ name: MCP_SERVER_NAME, version: HELPER_VERSION });
  for (const name of tools) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: ToolArgs[name] }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const r = await pipe.peer.call("tool.call", { taskId, name, args: args ?? {} }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
        return toMcpResult(r);
      } catch (e) {
        const msg = errorMessage(e);
        return toMcpResult({ text: `${name} failed: ${/closed/i.test(msg) ? NOT_RUNNING : msg}`, isError: true });
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The helper went away: nothing useful left to do.
  void pipe.closed.then(() => {
    warn("pipe closed, exiting");
    void server.close().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  warn(e instanceof Error ? String(e.stack) : String(e));
  process.exit(1);
});
