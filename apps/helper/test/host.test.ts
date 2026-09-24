/**
 * Spawns dist/host.js as Chrome would and speaks native messaging to it,
 * answering the browser.* calls from a fake X compose page. Proves the host
 * end to end without Chrome or a model (BROWSERTODO_BRAIN=scripted).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPeer, type BrowserMethod, type RpcMessage, type RunConfig } from "@browsertodo/shared";
import { encodeNativeMessage, NativeDecoder } from "../src/native-framing.js";
import type { BrowserMap, HelperMap } from "../src/rpc-types.js";
import { FakeX } from "./fake-x.js";
import { makeTask } from "./fixtures.js";

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
const decodeErrors: string[] = [];
let stderr = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bt-host-"));
  child = spawn(process.execPath, [HOST_JS], {
    env: { ...process.env, BROWSERTODO_BRAIN: "scripted", BROWSERTODO_HOME: home, TYPESAFE_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  ext = new RpcPeer<HelperMap, BrowserMap>((msg) => child.stdin.write(encodeNativeMessage(msg)), "e");
  x = new FakeX({ account: "alice" });
  for (const m of BROWSER_METHODS) ext.handle(m, (p: any) => x.handle(m, p) as any);
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

const CONFIG: RunConfig = { apiBase: "http://127.0.0.1:9", runnerKey: "rk", maxToolCalls: 60, maxTaskMinutes: 2, jevEnabled: true, jevThreshold: 0.8 };

describe("dist/host.js over native messaging", () => {
  it("answers helper.hello", async () => {
    const info = await ext.call("helper.hello", {}, { timeoutMs: 10_000 });
    expect(info).toEqual({ version: "0.1.0", jevAvailable: false, claudePath: "scripted", logDir: join(home, "logs") });
  });

  it("runs a task: the helper drives the fake page through browser.* calls and reports done with the URL", async () => {
    const task = makeTask({ id: "01HOSTTEST", instructions: "Post: hello from the host test" });
    const result = await ext.call("helper.runTask", { claim: { task, media: [], leaseExpiresAt: task.leaseExpiresAt! }, config: CONFIG }, { timeoutMs: 60_000 });
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/alice/status/1000", summary: "Posted: hello from the host test" });
    expect(result.logPath).toContain(join(home, "runs", "01HOSTTEST-"));
    expect(x.posts).toEqual([{ account: "alice", text: "hello from the host test", files: [], url: "https://x.com/alice/status/1000" }]);
    const methods = x.calls.map((c) => c.method);
    expect(methods).toContain("browser.type");
    expect(methods).toContain("browser.click");
  });

  it("forcePause/abortTask for an unknown task are harmless", async () => {
    expect(await ext.call("helper.forcePause", { taskId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await ext.call("helper.abortTask", { taskId: "nope", reason: "r" }, { timeoutMs: 5000 })).toEqual({ ok: true });
  });

  it("returns the live log tail", async () => {
    const { text } = await ext.call("helper.getLog", { lines: 200 }, { timeoutMs: 5000 });
    expect(text).toContain("runTask 01HOSTTEST -> done");
    expect(text).toContain("01HOSTTEST tool_call");
  });

  it("never writes anything but frames to stdout, and exits when stdin closes", async () => {
    expect(decodeErrors).toEqual([]);
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
  });
});
