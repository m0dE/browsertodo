import { describe, expect, it } from "vitest";
import type { TaskRunResult } from "@browsertodo/shared";
import { createToolExecutor } from "../src/index.js";
import type { BrowserCaller, JevLike } from "../src/types.js";
import { FAKE_JPEG_B64, FakeX } from "./fake-x.js";
import { collect, fakeJev, noSleep, smartJev } from "./helpers.js";

function setup(x: FakeX, over: { jev?: JevLike | null; mediaPaths?: string[]; onTaskEnd?: ((r: TaskRunResult) => void) | null; browser?: BrowserCaller } = {}) {
  const { events, onEvent } = collect();
  const ended: TaskRunResult[] = [];
  const exec = createToolExecutor({
    browser: over.browser ?? x.caller(),
    jev: over.jev === undefined ? null : over.jev,
    jevThreshold: 0.8,
    onEvent,
    ...(over.onTaskEnd === null ? {} : { onTaskEnd: over.onTaskEnd ?? ((r) => void ended.push(r)) }),
    mediaPaths: over.mediaPaths ?? [],
    sleep: noSleep,
  });
  return { exec, events, ended };
}

describe("createToolExecutor: plain tools", () => {
  it("maps plain tools to browser.* calls", async () => {
    const x = new FakeX();
    const { exec } = setup(x, { mediaPaths: ["C:\\media\\a.png"] });
    await exec.call("navigate", { url: "https://x.com/home" });
    await exec.call("read_page", {});
    await exec.call("click", { index: 0 });
    await exec.call("type", { index: 2, text: "hi" });
    await exec.call("paste", { text: "yo" });
    await exec.call("press_key", { key: "Control+Enter" });
    await exec.call("scroll", { direction: "down", amount: 2 });
    await exec.call("upload", { index: 3, paths: ["C:\\media\\a.png"] });
    expect(x.calls.map((c) => [c.method, c.params])).toEqual([
      ["browser.navigate", { url: "https://x.com/home" }],
      ["browser.readPage", {}],
      ["browser.click", { index: 0 }],
      ["browser.type", { index: 2, text: "hi" }],
      ["browser.paste", { text: "yo" }],
      ["browser.pressKey", { key: "Control+Enter" }],
      ["browser.scroll", { direction: "down", amount: 2 }],
      ["browser.upload", { index: 3, paths: ["C:\\media\\a.png"] }],
    ]);
    expect(exec.callCount).toBe(8);
  });

  it("read_page returns compact text including element text", async () => {
    const x = new FakeX();
    const { exec } = setup(x);
    const r = await exec.call("read_page", {});
    expect(r.text).toContain("URL: https://x.com/compose/post");
    expect(r.text).toContain('[0] button "Account menu" (button, testid=SideNav_AccountSwitcher_Button, text="alice @alice")');
    expect(r.text).toContain('textbox "Post text" (div, testid=tweetTextarea_0)');
    expect(r.text).toContain("--- visible text ---");
  });

  it("screenshot returns an image, and emits tool_call/tool_result events", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x);
    const r = await exec.call("screenshot", {});
    expect(r.image).toEqual({ base64: FAKE_JPEG_B64, mimeType: "image/jpeg" });
    expect(events).toEqual([
      { type: "tool_call", id: "t1", name: "screenshot", args: {} },
      { type: "tool_result", id: "t1", name: "screenshot", text: "[screenshot]" },
    ]);
  });

  it("validates args and never throws", async () => {
    const x = new FakeX();
    const { exec, events } = setup(x);
    const bad = await exec.call("click", { index: "three" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid arguments for click: index/);
    expect(x.calls).toHaveLength(0);
    const missing = await exec.call("click", { index: 99 });
    expect(missing).toEqual({ text: "click failed: element 99 not found; call read_page again", isError: true });
    const unknown = await exec.call("bogus" as never, {});
    expect(unknown.isError).toBe(true);
    expect(events.filter((e) => e.type === "tool_result" && e.isError)).toHaveLength(3);
    const throwing: BrowserCaller = {
      call: () => {
        throw new Error("sync boom");
      },
    };
    const r = await setup(x, { browser: throwing }).exec.call("read_page", {});
    expect(r).toEqual({ text: "read_page failed: sync boom", isError: true });
  });

  it("upload rejects paths that are not in mediaPaths (case and slash insensitive match)", async () => {
    const x = new FakeX();
    const { exec } = setup(x, { mediaPaths: ["C:\\Users\\me\\Downloads\\browsertodo-media\\s1\\cat.png"] });
    const bad = await exec.call("upload", { index: 3, paths: ["C:\\Windows\\win.ini"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/upload refused: C:\\Windows\\win.ini is not in the task's media list/);
    expect(x.calls).toHaveLength(0);
    await exec.call("read_page", {});
    const ok = await exec.call("upload", { index: 3, paths: ["c:/users/me/downloads/browsertodo-media/s1/cat.png"] });
    expect(ok.isError).toBeFalsy();
  });

  it("get_credential refuses X hosts and redacts the password in events", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "p4ss" } } });
    const { exec, events } = setup(x);
    for (const site of ["x.com", "https://www.x.com/login", "mobile.twitter.com", "TWITTER.com"]) {
      const r = await exec.call("get_credential", { site });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/never used for X/);
    }
    expect(x.calls).toHaveLength(0);
    const ok = await exec.call("get_credential", { site: "https://www.example.com/login" });
    expect(ok.text).toBe("username: u\npassword: p4ss");
    expect(JSON.stringify(events)).not.toContain("p4ss");
    expect((await exec.call("get_credential", { site: "other.com" })).text).toMatch(/No credential/);
    x.vaultLocked = true;
    expect((await exec.call("get_credential", { site: "example.com" })).text).toMatch(/vault is locked/);
  });

  it("switch_x_account switches through the account menu", async () => {
    const x = new FakeX({ account: "alice" });
    const { exec } = setup(x);
    const r = await exec.call("switch_x_account", { handle: "@Bob" });
    expect(r.text).toMatch(/^Switched to @Bob/);
    expect(x.account).toBe("bob");
    expect((await exec.call("switch_x_account", { handle: "bob" })).text).toBe("Already on @bob.");
    const missing = await exec.call("switch_x_account", { handle: "dave" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/step 2 failed.*@dave/);
  });

  it("task_* tools call onTaskEnd", async () => {
    const x = new FakeX();
    const { exec, ended } = setup(x);
    await exec.call("task_complete", { summary: "posted", url: "https://x.com/a/status/1" });
    await exec.call("task_fail", { reason: "nope" });
    await exec.call("task_pause", { reason: "2FA" });
    expect(ended).toEqual([
      { outcome: "done", summary: "posted", url: "https://x.com/a/status/1" },
      { outcome: "failed", reason: "nope" },
      { outcome: "paused", reason: "2FA" },
    ]);
  });

  it("task_* tools without onTaskEnd answer that there is no task to end", async () => {
    const { exec } = setup(new FakeX(), { onTaskEnd: null });
    const r = await exec.call("task_complete", { summary: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no task to end in the interactive terminal/);
  });
});

describe("createToolExecutor: act", () => {
  it("without Jev, a step with no index stops; steps with an index run directly", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x);
    const r = await exec.call("act", { steps: [{ goal: "x" }] });
    expect(r.text).toMatch(/fast model is off, so every step needs an element index/);
    const page = (await exec.call("read_page", {})).text ?? "";
    const box = Number(/\[(\d+)\] textbox/.exec(page)![1]);
    const direct = await exec.call("act", { steps: [{ goal: "type the post", index: box, text: "direct gm" }] });
    expect(direct.text).toMatch(/typed 9 characters into \[\d+\] \(direct\)/);
  });

  it("runs several steps: type uses the step text, click, then returns the final page", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = smartJev();
    const { exec, events } = setup(x, { jev });
    const r = await exec.call("act", {
      steps: [{ goal: "type the post text into the composer", text: "gm world" }, { goal: "click the post button" }],
    });
    expect(x.posts).toEqual([{ account: "alice", text: "gm world", files: [], url: "https://x.com/alice/status/1000" }]);
    expect(r.text).toMatch(/step 1: typed 8 characters into \[2\] textbox "Post text"/);
    expect(r.text).toMatch(/step 2: clicked \[4\] button "Post"/);
    expect(r.text).toContain("All 2 step(s) done");
    expect(r.text).toContain("URL: https://x.com/alice/status/1000");
    const jevEvents = events.filter((e) => e.type === "jev");
    expect(jevEvents).toHaveLength(2);
    expect(jevEvents[0]).toMatchObject({ goal: "type the post text into the composer", operation: "type", index: 2, executed: true });
    expect(typeof (jevEvents[0] as { ms: number }).ms).toBe("number");
  });

  it("stops at a low-confidence step with 'not confident at step N' and the element list", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = fakeJev([
      { operation: "click", index: 1, confidence: 0.95 },
      { operation: "click", index: 1, confidence: 0.5 },
    ]);
    const { exec, events } = setup(x, { jev });
    const r = await exec.call("act", { steps: [{ goal: "go home" }, { goal: "open something" }, { goal: "never run" }] });
    expect(r.text).toMatch(/step 1: clicked \[1\] link "Home"/);
    expect(r.text).toContain("not confident at step 2");
    expect(r.text).toContain("Steps 3-3 were not run");
    expect(r.text).toContain('[1] link "Home"');
    expect(jev.goals).toEqual(["go home", "open something"]);
    expect(events.filter((e) => e.type === "jev").map((e) => (e as { executed: boolean }).executed)).toEqual([true, false]);
  });

  it("stops when Jev chooses type but the step has no text", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { exec } = setup(x, { jev: smartJev() });
    const r = await exec.call("act", { steps: [{ goal: "type something in the composer" }] });
    expect(r.text).toMatch(/Jev chose to type into \[2\].*but this step has no text/);
    expect(r.text).toContain("not confident at step 1");
    expect(x.calls.some((c) => c.method === "browser.type")).toBe(false);
  });

  it("does not auto-execute press_key, stops on blocked, and survives Jev errors", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const pk = await setup(x, { jev: fakeJev([{ operation: "press_key", index: null, confidence: 0.99 }]) }).exec.call("act", {
      steps: [{ goal: "submit" }],
    });
    expect(pk.text).toMatch(/call press_key yourself/);
    expect(pk.text).toContain("not confident at step 1");
    const blocked = await setup(x, { jev: fakeJev([{ operation: "blocked", index: null, confidence: 0.99 }]) }).exec.call("act", {
      steps: [{ goal: "x" }],
    });
    expect(blocked.text).toContain("not confident at step 1");
    const broken: JevLike = { decide: async () => Promise.reject(new Error("503")) };
    const err = await setup(x, { jev: broken }).exec.call("act", { steps: [{ goal: "x" }] });
    expect(err.text).toMatch(/Jev is unavailable \(503\)/);
    expect(err.text).toContain("not confident at step 1");
    expect(x.calls.filter((c) => c.method !== "browser.readPage")).toHaveLength(0);
  });

  it("scroll and wait execute, done ends the batch", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = fakeJev([
      { operation: "scroll", index: null, confidence: 0.9 },
      { operation: "wait", index: null, confidence: 0.9 },
      { operation: "done", index: null, confidence: 0.9 },
    ]);
    const { exec } = setup(x, { jev });
    const r = await exec.call("act", { steps: [{ goal: "a" }, { goal: "b" }, { goal: "c" }, { goal: "d" }] });
    expect(r.text).toContain("step 1: scrolled down");
    expect(r.text).toContain("step 2: waited 1 s");
    expect(r.text).toContain('step 3: "c" is already done');
    expect(r.text).toContain("Jev ended the batch at step 3. Steps 4-4 were not run");
    expect(jev.goals).toEqual(["a", "b", "c"]);
    expect(r.text).not.toContain("not confident");
  });

  it("rejects more than 8 steps", async () => {
    const { exec } = setup(new FakeX(), { jev: smartJev() });
    const r = await exec.call("act", { steps: Array.from({ length: 9 }, () => ({ goal: "g" })) });
    expect(r.isError).toBe(true);
  });
});
