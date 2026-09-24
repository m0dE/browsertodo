/**
 * Live check (real Claude Code, uses your subscription): dist/host.js runs a
 * posting task against the fake X page, and a user message is injected
 * mid-task. Runs only with BROWSERTODO_LIVE_CLAUDE=1:
 *   BROWSERTODO_LIVE_CLAUDE=1 pnpm --filter @browsertodo/helper test live-claude
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPeer, type BrowserMethod, type HelperNotifications, type RpcMessage } from "@browsertodo/shared";
import { encodeNativeMessage, NativeDecoder } from "../src/native-framing.js";
import type { BrowserMap, HelperMap } from "../src/rpc-types.js";
import { FakeX } from "./fake-x.js";

const HOST_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "host.js");
const home = mkdtempSync(join(tmpdir(), "bt-live-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.runIf(process.env.BROWSERTODO_LIVE_CLAUDE === "1")("live Claude Code through dist/host.js", () => {
  it("posts on the fake X page and hears a message injected mid-task", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, BROWSERTODO_HOME: home };
    delete env.BROWSERTODO_BRAIN;
    const child = spawn(process.execPath, [HOST_JS], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const ext = new RpcPeer<HelperMap, BrowserMap>((msg) => child.stdin.write(encodeNativeMessage(msg)), "e");
    const x = new FakeX({ account: "alice", url: "https://x.com/home" });
    const events: HelperNotifications["helper.event"][] = [];
    ext.onNotification<HelperNotifications["helper.event"]>("helper.event", (p) => {
      events.push(p);
      const e = p.event as Record<string, unknown>;
      console.log(`[event] ${e.type} ${JSON.stringify(e).slice(0, 220)}`);
    });
    const methods: BrowserMethod[] = ["browser.navigate", "browser.readPage", "browser.screenshot", "browser.click", "browser.type", "browser.paste", "browser.pressKey", "browser.scroll", "browser.upload", "browser.currentUrl", "vault.getCredential"];
    let open!: () => void;
    let gate: Promise<void> | null = new Promise<void>((r) => (open = r));
    for (const m of methods) {
      ext.handle(m, async (p: any) => {
        if (gate) await gate;
        return x.handle(m, p) as any;
      });
    }
    const decoder = new NativeDecoder();
    child.stdout.on("data", (c: Buffer) => {
      for (const msg of decoder.push(c)) void ext.receive(msg as RpcMessage);
    });
    try {
      const t0 = Date.now();
      const info = await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      console.log("hello", JSON.stringify(info), `${Date.now() - t0} ms`);
      expect(info.selfTest?.ok).toBe(true);

      const started = Date.now();
      const run = ext.call(
        "helper.runTask",
        {
          sessionId: "LIVE-1",
          task: { id: "T-LIVE", instructions: "Post: live check from browsertodo", account: null },
          mediaPaths: [],
          config: { maxToolCalls: 40, maxTaskMinutes: 6, jevEnabled: true, jevThreshold: 0.8, isRetry: false },
        },
        { timeoutMs: 7 * 60_000 },
      );
      // Hold the first browser call until the message is in.
      while (!events.some((e) => e.event.type === "tool_call")) await new Promise((r) => setTimeout(r, 100));
      const said = await ext.call(
        "helper.sendUserMessage",
        { sessionId: "LIVE-1", text: "Change of plan: add the hashtag #bt2 at the very end of the post text." },
        { timeoutMs: 5000 },
      );
      console.log("sendUserMessage", said);
      await new Promise((r) => setTimeout(r, 3000));
      gate = null;
      open();
      const result = await run;
      console.log("result", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`);
      console.log("posts", JSON.stringify(x.posts));
      expect(said.ok).toBe(true);
      expect(result.outcome).toBe("done");
      expect(x.posts).toHaveLength(1);
      expect(x.posts[0]!.text).toContain("live check from browsertodo");
    } finally {
      child.stdin.end();
      await new Promise((r) => setTimeout(r, 1000));
      if (child.exitCode === null) child.kill();
    }
  }, 8 * 60_000);
});
