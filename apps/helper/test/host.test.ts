/**
 * Spawns dist/host.js as Chrome would and speaks native messaging to it,
 * answering the browser.* calls from a fake X page. Proves the host end to
 * end without Chrome or a model (BROWSERTODO_BRAIN=scripted, BROWSERTODO_FAKE_PTY=1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RpcPeer,
  type AgentEvent,
  type BrowserMethod,
  type HelperNotifications,
  type RpcMessage,
  type RunConfig,
} from "@browsertodo/shared";
import { encodeNativeMessage, NativeDecoder } from "../src/native-framing.js";
import type { BrowserMap, HelperMap } from "../src/rpc-types.js";
import { FakeX } from "./fake-x.js";

const HOST_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "host.js");
const BROWSER_METHODS: BrowserMethod[] = [
  "browser.navigate",
  "browser.readPage",
  "browser.screenshot",
  "browser.click",
  "browser.type",
  "browser.paste",
  "browser.pressKey",
  "browser.scroll",
  "browser.upload",
  "browser.currentUrl",
  "vault.getCredential",
];

let home: string;
let child: ChildProcessWithoutNullStreams;
let ext: RpcPeer<HelperMap, BrowserMap>;
let x: FakeX;
/** While set, browser.readPage waits for it (to inject a user message mid-task). */
let gate: Promise<void> | null = null;
const decodeErrors: string[] = [];
const events: HelperNotifications["helper.event"][] = [];
const termData: HelperNotifications["helper.terminal.data"][] = [];
const termExits: HelperNotifications["helper.terminal.exit"][] = [];
const termOpened: HelperNotifications["helper.terminal.opened"][] = [];
let stderr = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bt-host-"));
  child = spawn(process.execPath, [HOST_JS], {
    env: { ...process.env, BROWSERTODO_BRAIN: "scripted", BROWSERTODO_HOME: home, TYPESAFE_API_KEY: "", BROWSERTODO_FAKE_PTY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  ext = new RpcPeer<HelperMap, BrowserMap>((msg) => child.stdin.write(encodeNativeMessage(msg)), "e");
  x = new FakeX({ account: "alice" });
  for (const m of BROWSER_METHODS) {
    ext.handle(m, async (p: any) => {
      if (m === "browser.readPage" && gate) await gate;
      return x.handle(m, p) as any;
    });
  }
  ext.onNotification<HelperNotifications["helper.event"]>("helper.event", (p) => events.push(p));
  ext.onNotification<HelperNotifications["helper.terminal.data"]>("helper.terminal.data", (p) => termData.push(p));
  ext.onNotification<HelperNotifications["helper.terminal.exit"]>("helper.terminal.exit", (p) => termExits.push(p));
  ext.onNotification<HelperNotifications["helper.terminal.opened"]>("helper.terminal.opened", (p) => termOpened.push(p));
  const decoder = new NativeDecoder();
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const msg of decoder.push(chunk)) void ext.receive(msg as RpcMessage);
    } catch (e) {
      decodeErrors.push(String(e));
    }
  });
});

afterAll(() => {
  if (child.exitCode === null) child.kill();
  rmSync(home, { recursive: true, force: true });
});

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 2, jevEnabled: true, jevThreshold: 0.8, isRetry: false };

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("dist/host.js over native messaging", () => {
  it("answers helper.hello with pty and self-test info, and writes helper.json", async () => {
    const info = await ext.call("helper.hello", {}, { timeoutMs: 10_000 });
    expect(info).toEqual({
      version: "0.2.0",
      jevAvailable: false,
      claudePath: "scripted",
      logDir: join(home, "logs"),
      ptyAvailable: true,
      terminals: [],
      selfTest: { ok: true, ms: 0, at: expect.any(String) },
    });
    const again = await ext.call("helper.hello", { selfTest: true }, { timeoutMs: 10_000 });
    expect(again.selfTest?.ok).toBe(true);
    const file = JSON.parse(readFileSync(join(home, "helper.json"), "utf8"));
    expect(file).toEqual({ pipe: expect.stringContaining("browsertodo-"), pid: child.pid, startedAt: expect.any(String) });
  });

  it("runs a task with media; events arrive as notifications; a user message reaches the brain", async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const media = join(home, "cat.png");
    const run = ext.call(
      "helper.runTask",
      {
        sessionId: "S-HOST",
        task: { id: "T-HOST", instructions: "Post: hello from the host test", account: null },
        mediaPaths: [media],
        config: CONFIG,
      },
      { timeoutMs: 60_000 },
    );
    await waitFor(() => events.some((e) => e.event.type === "tool_call"));
    expect(await ext.call("helper.sendUserMessage", { sessionId: "S-HOST", text: "please hurry" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await ext.call("helper.sendUserMessage", { sessionId: "nope", text: "x" }, { timeoutMs: 5000 })).toEqual({ ok: false });
    gate = null;
    open();
    const result = await run;
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/alice/status/1000", summary: "Posted: hello from the host test" });
    expect(result.logPath).toContain(join(home, "runs", "S-HOST-"));
    expect(x.posts).toEqual([{ account: "alice", text: "hello from the host test", files: [media], url: "https://x.com/alice/status/1000" }]);

    const mine = events.filter((e) => e.sessionId === "S-HOST").map((e) => e.event);
    const types = mine.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(mine).toContainEqual({ type: "user_message", text: "please hurry" });
    expect(mine).toContainEqual({ type: "assistant_text", text: "Scripted brain received: please hurry" });
    expect(mine.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "Posted: hello from the host test", url: "https://x.com/alice/status/1000" } satisfies AgentEvent);
    expect(mine.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toContain("upload");
  });

  it("continueSession on a session that is not kept open rejects with 'session ended'; endSession of an unknown one is ok: false", async () => {
    await expect(ext.call("helper.continueSession", { sessionId: "S-HOST", text: "again", config: CONFIG }, { timeoutMs: 5000 })).rejects.toThrow(/session ended/);
    expect(await ext.call("helper.endSession", { sessionId: "S-HOST" }, { timeoutMs: 5000 })).toEqual({ ok: false });
  });

  it("forcePause/abortTask for an unknown session are harmless", async () => {
    expect(await ext.call("helper.forcePause", { sessionId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await ext.call("helper.abortTask", { sessionId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
  });

  it("runs the terminal: start, data, input, resize, exit", async () => {
    const { terminalId } = await ext.call("helper.terminal.start", { cols: 100, rows: 30 }, { timeoutMs: 5000 });
    const user = { terminalId, kind: "user", title: "Claude Code" };
    await waitFor(() => termOpened.length > 0);
    expect(termOpened).toEqual([user]);
    expect(await ext.call("helper.terminal.list", {}, { timeoutMs: 5000 })).toEqual({ terminals: [user] });
    expect((await ext.call("helper.hello", {}, { timeoutMs: 5000 })).terminals).toEqual([user]);
    await waitFor(() => termData.some((d) => d.terminalId === terminalId && d.data.includes("fake-pty:")));
    const banner = termData.find((d) => d.data.includes("fake-pty:"))!.data;
    expect(banner).toContain("--mcp-config");
    expect(banner).toContain("--append-system-prompt");
    expect(banner).toContain("--allowedTools mcp__browsertodo__navigate");
    expect(await ext.call("helper.terminal.input", { terminalId, data: "echo hi\r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    await ext.call("helper.terminal.resize", { terminalId, cols: 90, rows: 20 }, { timeoutMs: 5000 });
    await waitFor(() => termData.map((d) => d.data).join("").includes("[resized 90x20]"));
    expect(termData.map((d) => d.data).join("")).toContain("echo hi\r");
    await ext.call("helper.terminal.input", { terminalId, data: "exit\r" }, { timeoutMs: 5000 });
    await waitFor(() => termExits.length > 0);
    expect(termExits).toEqual([{ terminalId, exitCode: 0 }]);
    expect(await ext.call("helper.terminal.list", {}, { timeoutMs: 5000 })).toEqual({ terminals: [] });
    await expect(ext.call("helper.terminal.input", { terminalId, data: "x" }, { timeoutMs: 5000 })).rejects.toThrow(/no running terminal/);
    // the interactive MCP config was written with the interactive tools
    const cfg = JSON.parse(readFileSync(join(home, "interactive-mcp-config.json"), "utf8"));
    expect(cfg.mcpServers.browsertodo.env.BROWSERTODO_TASK).toBe("");
    expect(cfg.mcpServers.browsertodo.env.BROWSERTODO_TOOLS.split(",")).not.toContain("task_complete");
    expect(existsSync(join(home, "workspace"))).toBe(true);
  });

  it("returns the live log tail", async () => {
    const { text } = await ext.call("helper.getLog", { lines: 300 }, { timeoutMs: 5000 });
    expect(text).toContain("runTask S-HOST -> done");
    expect(text).toContain("S-HOST tool_call");
  });

  it("never writes anything but frames to stdout, and exits (removing helper.json) when stdin closes", async () => {
    expect(decodeErrors).toEqual([]);
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(join(home, "helper.json"))).toBe(false);
  });
});
