/**
 * Live check (real Claude Code, uses your subscription): dist/host.js runs
 * posting tasks against the fake X page with headless Claude Code
 * (stream-json in and out, stdin kept open).
 *   1. A task runs, a user message is typed in mid-task, and the turn ends
 *      with task_complete; the session stays open.
 *   2. A follow-up (helper.continueSession) runs in the same session.
 *   3. helper.endSession closes it; continuing it then rejects "session ended".
 * Runs only with BROWSERTODO_LIVE_CLAUDE=1 (after `pnpm build`):
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
const home = mkdtempSync(join(tmpdir(), "browsertodo-live-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(process.env.BROWSERTODO_LIVE_CLAUDE === "1")("live Claude Code through dist/host.js", () => {
  it("posts, hears a message injected mid-task, takes a follow-up in the same session, and ends it", async () => {
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
    const config = { maxToolCalls: 40, maxTaskMinutes: 6, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
    try {
      const t0 = Date.now();
      const info = await ext.call("helper.hello", {}, { timeoutMs: 90_000 });
      console.log("hello", JSON.stringify(info), `${Date.now() - t0} ms`);
      expect(info.selfTest?.ok).toBe(true);

      // 1. The first turn, with a message typed in while it runs.
      const started = Date.now();
      const run = ext.call(
        "helper.runTask",
        { sessionId: "LIVE-1", task: { id: "T-LIVE", instructions: "Post: live check from browsertodo", account: null }, mediaPaths: [], config },
        { timeoutMs: 7 * 60_000 },
      );
      // Hold the first browser call until the message is in.
      while (!events.some((e) => e.sessionId === "LIVE-1" && e.event.type === "tool_call")) await sleep(100);
      const said = await ext.call(
        "helper.sendUserMessage",
        { sessionId: "LIVE-1", text: "Change of plan: add the hashtag #bt2 at the very end of the post text." },
        { timeoutMs: 5000 },
      );
      await sleep(3000);
      gate = null;
      open();
      const result = await run;
      console.log("result", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`, JSON.stringify(x.posts));
      expect(said.ok).toBe(true);
      expect(result.outcome).toBe("done");
      const first = x.posts.filter((p) => p.text.includes("live check from browsertodo"));
      expect(first).toHaveLength(1);
      expect(first[0]!.text).toContain("#bt2");
      const mine = events.filter((e) => e.sessionId === "LIVE-1").map((e) => e.event);
      expect(mine[0]).toEqual({ type: "status", text: expect.stringMatching(/^Claude Code started \(/) });
      expect(mine.some((e) => e.type === "assistant_text")).toBe(true);
      expect(mine.some((e) => e.type === "tool_call" && e.name === "task_complete")).toBe(true);

      // 2. A follow-up turn in the same session.
      const t1 = Date.now();
      const follow = await ext.call(
        "helper.continueSession",
        { sessionId: "LIVE-1", text: "Now post one more: follow-up from browsertodo", config },
        { timeoutMs: 7 * 60_000 },
      );
      console.log("follow-up", JSON.stringify(follow), `${Math.round((Date.now() - t1) / 1000)} s`, JSON.stringify(x.posts));
      expect(follow.outcome).toBe("done");
      expect(x.posts.filter((p) => p.text.includes("follow-up from browsertodo"))).toHaveLength(1);
      // Same Claude Code process: no second "started" status.
      expect(events.filter((e) => e.sessionId === "LIVE-1" && e.event.type === "status" && /^Claude Code started/.test((e.event as { text: string }).text))).toHaveLength(1);

      // 3. Ending it.
      expect(await ext.call("helper.endSession", { sessionId: "LIVE-1" }, { timeoutMs: 5000 })).toEqual({ ok: true });
      await sleep(2000);
      await expect(ext.call("helper.continueSession", { sessionId: "LIVE-1", text: "x", config }, { timeoutMs: 5000 })).rejects.toThrow(/session ended/);
    } finally {
      child.stdin.end();
      await sleep(1000);
      if (child.exitCode === null) child.kill();
    }
  }, 12 * 60_000);
});
