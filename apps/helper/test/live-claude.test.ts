/**
 * Live check (real Claude Code, uses your subscription): dist/host.js runs
 * posting tasks against the fake X page, with Claude Code as a real
 * interactive session in a task terminal (node-pty).
 *   1. The fresh workspace is not trusted yet: the task pauses on the
 *      folder-trust prompt without answering it.
 *   2. The "user" trusts the folder in their own Terminal session (Down, Enter).
 *   3. The task runs in its task terminal, a user message is typed in
 *      mid-task, and the turn ends with task_complete; the session stays open.
 *   4. A follow-up (helper.continueSession) runs in the same session.
 *   5. helper.endSession closes it (/exit).
 * Runs only with BROWSERTODO_LIVE_CLAUDE=1 (after `pnpm build`):
 *   BROWSERTODO_LIVE_CLAUDE=1 pnpm --filter @browsertodo/helper test live-claude
 * Step 2 records trust for a temp folder in ~/.claude.json, as clicking
 * "Yes, I trust this folder" would.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPeer, type BrowserMethod, type HelperNotifications, type RpcMessage } from "@browsertodo/shared";
import { encodeNativeMessage, NativeDecoder } from "../src/native-framing.js";
import { plainText, TerminalResponder, TRUST_REASON } from "../src/terminal-responder.js";
import type { BrowserMap, HelperMap } from "../src/rpc-types.js";
import { FakeX } from "./fake-x.js";

const HOST_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "host.js");
// One fixed folder, so Claude Code's trust record for it (in ~/.claude.json) is
// added once, not once per run. Only the per-run output is cleaned up.
const home = join(tmpdir(), "browsertodo-live-test");
mkdirSync(home, { recursive: true });
afterAll(() => {
  for (const d of ["runs", "logs"]) rmSync(join(home, d), { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.runIf(process.env.BROWSERTODO_LIVE_CLAUDE === "1")("live Claude Code through dist/host.js", () => {
  it("pauses on the trust prompt, then posts from a task terminal and hears a message injected mid-task", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, BROWSERTODO_HOME: home };
    delete env.BROWSERTODO_BRAIN;
    delete env.BROWSERTODO_FAKE_PTY;
    const child = spawn(process.execPath, [HOST_JS], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const ext = new RpcPeer<HelperMap, BrowserMap>((msg) => child.stdin.write(encodeNativeMessage(msg)), "e");
    const x = new FakeX({ account: "alice", url: "https://x.com/home" });
    const events: HelperNotifications["helper.event"][] = [];
    const opened: HelperNotifications["helper.terminal.opened"][] = [];
    const exits: HelperNotifications["helper.terminal.exit"][] = [];
    const output = new Map<string, string>();
    ext.onNotification<HelperNotifications["helper.event"]>("helper.event", (p) => {
      events.push(p);
      const e = p.event as Record<string, unknown>;
      console.log(`[event] ${e.type} ${JSON.stringify(e).slice(0, 220)}`);
    });
    ext.onNotification<HelperNotifications["helper.terminal.opened"]>("helper.terminal.opened", (p) => {
      opened.push(p);
      console.log("[terminal opened]", JSON.stringify(p));
    });
    // The user's session has no xterm.js here to answer its terminal queries: answer them like the panel would.
    const userResponder = new TerminalResponder();
    let userTermId = "";
    ext.onNotification<HelperNotifications["helper.terminal.data"]>("helper.terminal.data", (p) => {
      output.set(p.terminalId, (output.get(p.terminalId) ?? "") + p.data);
      const reply = p.terminalId === userTermId ? userResponder.feed(p.data) : "";
      if (reply) void ext.call("helper.terminal.input", { terminalId: p.terminalId, data: reply }, { timeoutMs: 5000 }).catch(() => {});
    });
    ext.onNotification<HelperNotifications["helper.terminal.exit"]>("helper.terminal.exit", (p) => exits.push(p));
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
      expect(info.ptyAvailable).toBe(true);

      // 1. Untrusted workspace: paused, and the prompt is left for the user.
      const first = await ext.call(
        "helper.runTask",
        { sessionId: "LIVE-0", task: { id: "T-LIVE-0", instructions: "Post: trust check", account: null }, mediaPaths: [], config },
        { timeoutMs: 3 * 60_000 },
      );
      console.log("first run", JSON.stringify(first));
      const needsTrust = first.reason === TRUST_REASON;
      if (!needsTrust) {
        console.log("the workspace was trusted by an earlier run; skipping the trust steps");
        expect(first.outcome).toBe("done");
      }
      if (needsTrust) {
      expect(first).toMatchObject({ outcome: "paused", reason: TRUST_REASON });
      expect(opened[0]).toMatchObject({ kind: "task", sessionId: "LIVE-0", title: "Post: trust check" });
      expect(plainText(output.get(opened[0]!.terminalId) ?? "")).toMatch(/trust this folder/);
      expect(exits.map((e) => e.terminalId)).toContain(opened[0]!.terminalId);

      // 2. Trust it the way a user would, in their own session.
      const { terminalId: userTerm } = await ext.call("helper.terminal.start", { cols: 120, rows: 40 }, { timeoutMs: 15_000 });
      userTermId = userTerm;
      // Queries sent before the id was known.
      const early = userResponder.feed(output.get(userTerm) ?? "");
      if (early) await ext.call("helper.terminal.input", { terminalId: userTerm, data: early }, { timeoutMs: 5000 });
      await until(() => /trust this folder/.test(plainText(output.get(userTerm) ?? "")), "the trust prompt in the user's session", 60_000);
      // The dialog can redraw (and reset its selection) while the TUI settles: select Yes until it sticks.
      const yesSelected = () => {
        const screen = plainText(output.get(userTerm) ?? "");
        return screen.lastIndexOf("❯ Yes, I trust this folder") > screen.lastIndexOf("❯ No, exit");
      };
      await sleep(1500);
      for (let i = 0; i < 5 && !yesSelected(); i++) {
        await ext.call("helper.terminal.input", { terminalId: userTerm, data: "\x1b[B" }, { timeoutMs: 5000 });
        await sleep(1000);
      }
      expect(yesSelected()).toBe(true);
      await ext.call("helper.terminal.input", { terminalId: userTerm, data: "\r" }, { timeoutMs: 5000 });
      try {
        await until(() => /❯/.test(plainText(output.get(userTerm) ?? "").split(/trust this folder/).at(-1) ?? ""), "the user's session to start", 60_000);
      } catch (e) {
        console.log(`user session screen:\n${plainText(output.get(userTerm) ?? "").slice(-2000)}`);
        throw e;
      }
      await sleep(2000);
      await ext.call("helper.terminal.stop", { terminalId: userTerm }, { timeoutMs: 15_000 });
      }

      // 3. The real run.
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
      console.log("sendUserMessage", said);
      await sleep(3000);
      gate = null;
      open();
      const result = await run;
      const term = opened.find((o) => o.sessionId === "LIVE-1")!;
      console.log("result", JSON.stringify(result), `${Math.round((Date.now() - started) / 1000)} s`);
      console.log("posts", JSON.stringify(x.posts));
      console.log("task terminal tail:\n" + plainText(output.get(term.terminalId) ?? "").slice(-1500));
      expect(said.ok).toBe(true);
      expect(result.outcome).toBe("done");
      expect(x.posts.filter((p) => p.text.includes("live check from browsertodo"))).toHaveLength(1);
      expect(term).toMatchObject({ kind: "task", title: "Post: live check from browsertodo" });
      const mine = events.filter((e) => e.sessionId === "LIVE-1").map((e) => e.event);
      expect(mine[0]).toEqual({ type: "status", text: expect.stringMatching(/^Claude Code is running in the Terminal tab \(/) });
      expect(mine.some((e) => e.type === "tool_call" && e.name === "task_complete")).toBe(true);
      expect(exits.map((e) => e.terminalId)).not.toContain(term.terminalId);
      expect(plainText(output.get(term.terminalId) ?? "")).toContain("#bt2");
      // The session stays open, idle, in its terminal.
      expect((await ext.call("helper.terminal.list", {}, { timeoutMs: 5000 })).terminals).toEqual([term]);

      // 4. A follow-up turn in the same session and terminal.
      const t1 = Date.now();
      const follow = await ext.call(
        "helper.continueSession",
        { sessionId: "LIVE-1", text: "Now post one more: follow-up from browsertodo", config },
        { timeoutMs: 7 * 60_000 },
      );
      console.log("follow-up", JSON.stringify(follow), `${Math.round((Date.now() - t1) / 1000)} s`, JSON.stringify(x.posts));
      expect(follow.outcome).toBe("done");
      expect(x.posts.filter((p) => p.text.includes("follow-up from browsertodo"))).toHaveLength(1);
      expect(opened.filter((o) => o.sessionId === "LIVE-1")).toHaveLength(1);

      // 5. Ending it closes the terminal.
      expect(await ext.call("helper.endSession", { sessionId: "LIVE-1" }, { timeoutMs: 5000 })).toEqual({ ok: true });
      await until(() => exits.some((e) => e.terminalId === term.terminalId), "the task terminal to exit", 30_000);
      expect((await ext.call("helper.terminal.list", {}, { timeoutMs: 5000 })).terminals).toEqual([]);
      await expect(ext.call("helper.continueSession", { sessionId: "LIVE-1", text: "x", config }, { timeoutMs: 5000 })).rejects.toThrow(/session ended/);
    } finally {
      child.stdin.end();
      await sleep(1000);
      if (child.exitCode === null) child.kill();
    }
  }, 12 * 60_000);
});
