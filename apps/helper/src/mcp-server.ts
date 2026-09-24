/**
 * Stdio MCP server spawned by Claude Code for one task. It registers the
 * browsertodo tools and relays every call over the named pipe to the helper.
 *
 * Env (set by the helper in the generated MCP config):
 *   BROWSERTODO_PIPE   pipe path of the helper
 *   BROWSERTODO_TASK   task id
 *   BROWSERTODO_TOOLS  comma list of tool names to register (default: all)
 *
 * stdout carries MCP JSON-RPC only; diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_NAME, TOOL_DESCRIPTIONS, ToolArgs } from "@browsertodo/shared";
import { connectPipe } from "./pipe-server.js";
import { TOOL_CALL_TIMEOUT_MS, toMcpResult, toolsFromEnv } from "./mcp-tools.js";

async function main(): Promise<void> {
  // Safety net: keep stdout for MCP frames only.
  const toStderr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const pipePath = process.env.BROWSERTODO_PIPE;
  const taskId = process.env.BROWSERTODO_TASK ?? "";
  if (!pipePath) {
    process.stderr.write("browsertodo mcp-server: BROWSERTODO_PIPE is not set\n");
    process.exit(2);
  }
  const pipe = await connectPipe(pipePath);
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });

  for (const name of toolsFromEnv(process.env.BROWSERTODO_TOOLS)) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: ToolArgs[name] },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const r = await pipe.peer.call("tool.call", { taskId, name, args: args ?? {} }, { timeoutMs: TOOL_CALL_TIMEOUT_MS });
          return toMcpResult(r);
        } catch (e) {
          return toMcpResult({ text: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true });
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The helper went away: nothing useful left to do.
  void pipe.closed.then(() => {
    process.stderr.write("browsertodo mcp-server: pipe closed, exiting\n");
    void server.close().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  process.stderr.write(`browsertodo mcp-server: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
