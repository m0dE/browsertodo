import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PipeMethods } from "@browsertodo/shared";
import { pipePathFor, startPipeServer, connectPipe, type PipeServer } from "../src/pipe-server.js";
import { toMcpResult, toolsFromEnv } from "../src/mcp-tools.js";

const MCP_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp-server.js");

const received: PipeMethods["tool.call"]["params"][] = [];
let pipe: PipeServer;
const pipePath = pipePathFor(900_000 + Math.floor(Math.random() * 99_999));

beforeAll(async () => {
  pipe = await startPipeServer(pipePath, {
    toolCall: async (p) => {
      received.push(p);
      if (p.name === "screenshot") return { image: { base64: "aGVsbG8=", mimeType: "image/jpeg" } };
      if (p.name === "click") return { text: "click failed: element 9 not found", isError: true };
      return { text: `URL: https://x.com/home\nrelayed ${p.name} for ${p.taskId}` };
    },
    toolList: () => ({ names: ["read_page"] }),
  });
});
afterAll(async () => {
  await pipe.close();
});

async function connect(tools: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_JS],
    env: { ...getDefaultEnvironment(), BROWSERTODO_PIPE: pipePath, BROWSERTODO_TASK: "T9", BROWSERTODO_TOOLS: tools },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("pipe", () => {
  it("relays tool.call and tool.list between peers", async () => {
    const c = await connectPipe(pipePath);
    expect(await c.peer.call("tool.list", { taskId: "T" })).toEqual({ names: ["read_page"] });
    const r = await c.peer.call("tool.call", { taskId: "T", name: "read_page", args: {} });
    expect(r.text).toContain("relayed read_page for T");
    c.close();
    await c.closed;
  });
});

describe("mcp-server.js over stdio", () => {
  it("registers only BROWSERTODO_TOOLS and relays calls over the pipe", async () => {
    const client = await connect("read_page,screenshot,click,task_complete");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["click", "read_page", "screenshot", "task_complete"]);
      const click = tools.find((t) => t.name === "click")!;
      expect(click.description).toMatch(/Click an element by index/);
      expect((click.inputSchema as any).properties.index.type).toBe("integer");
      expect((click.inputSchema as any).required).toEqual(["index"]);

      received.length = 0;
      const r = await client.callTool({ name: "read_page", arguments: {} });
      expect(r.content).toEqual([{ type: "text", text: "URL: https://x.com/home\nrelayed read_page for T9" }]);
      expect(received).toEqual([{ taskId: "T9", name: "read_page", args: {} }]);

      const shot = await client.callTool({ name: "screenshot", arguments: {} });
      expect(shot.content).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }]);

      const bad = await client.callTool({ name: "click", arguments: { index: 9 } });
      expect(bad.isError).toBe(true);
      expect(received.at(-1)).toEqual({ taskId: "T9", name: "click", args: { index: 9 } });

      // Schema validation happens in the MCP server; invalid args never reach the pipe.
      const before = received.length;
      const invalid = await client.callTool({ name: "click", arguments: { index: "x" } }).catch((e: Error) => ({ isError: true, error: e }));
      expect(invalid.isError).toBe(true);
      expect(received.length).toBe(before);
    } finally {
      await client.close();
    }
  });

  it("offers act only when the helper allows it", async () => {
    const withAct = await connect("act,read_page");
    try {
      expect((await withAct.listTools()).tools.map((t) => t.name).sort()).toEqual(["act", "read_page"]);
    } finally {
      await withAct.close();
    }
  });
});

describe("mcp-server.js --attach", () => {
  it("finds the helper through helper.json and serves the interactive tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "bt-attach-"));
    try {
      writeFileSync(join(home, "helper.json"), JSON.stringify({ pipe: pipePath, pid: process.pid, startedAt: new Date().toISOString() }));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_JS, "--attach"],
        env: { ...getDefaultEnvironment(), BROWSERTODO_HOME: home },
        stderr: "pipe",
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);
      try {
        // tool.list from the helper answers ["read_page"]; the interactive list is narrowed to it
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["read_page"]);
        await client.callTool({ name: "read_page", arguments: {} });
        expect(received.at(-1)).toEqual({ taskId: "interactive", name: "read_page", args: {} });
      } finally {
        await client.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("explains that the helper is not running", () => {
    const home = mkdtempSync(join(tmpdir(), "bt-attach-"));
    try {
      const r = spawnSync(process.execPath, [MCP_JS, "--attach"], { env: { ...process.env, BROWSERTODO_HOME: home }, encoding: "utf8", timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/helper is not running: open Chrome with the browsertodo extension/);
      // a stale helper.json (dead pid) is treated the same
      writeFileSync(join(home, "helper.json"), JSON.stringify({ pipe: "\\.\pipe\nope", pid: 999_999_99, startedAt: "" }));
      const r2 = spawnSync(process.execPath, [MCP_JS, "--attach"], { env: { ...process.env, BROWSERTODO_HOME: home }, encoding: "utf8", timeout: 20_000 });
      expect(r2.status).toBe(1);
      expect(r2.stderr).toMatch(/open Chrome with the browsertodo extension/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("mcp helpers", () => {
  it("parses the tool list env", () => {
    expect(toolsFromEnv("read_page, act,bogus")).toEqual(["read_page", "act"]);
    expect(toolsFromEnv(undefined)).toContain("task_pause");
  });

  it("converts ToolResult to MCP content", () => {
    expect(toMcpResult({ text: "a", image: { base64: "b", mimeType: "image/png" }, isError: true })).toEqual({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "b", mimeType: "image/png" },
      ],
      isError: true,
    });
    expect(toMcpResult({})).toEqual({ content: [{ type: "text", text: "ok" }] });
  });
});
