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
    expect(direct.text).toMatch(/typed 9 characters into \[\d+\] \(picked by Claude\)/);
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

describe("browser notes", () => {
  it("puts a note from the browser in front of that tool's result, once", async () => {
    let first = true;
    const browser = {
      call: async (method: string) => {
        if (method === "browser.readPage") {
          const r = { url: "https://mail.example.com/", title: "Mail", text: "inbox", elements: [], truncated: false };
          if (first) {
            first = false;
            return { ...r, note: "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger.)" };
          }
          return r;
        }
        return { ok: true };
      },
    };
    const events: any[] = [];
    const { createToolExecutor } = await import("../src/executor.js");
    const exec = createToolExecutor({ browser: browser as never, jev: null, jevThreshold: 0.8, onEvent: (e) => events.push(e), mediaPaths: [] });
    const r1 = await exec.call("read_page", {});
    expect(r1.text?.startsWith("(Using fallback mode")).toBe(true);
    expect(events.find((e) => e.type === "tool_result")!.text).toMatch(/^\(Using fallback mode/);
    const r2 = await exec.call("read_page", {});
    expect(r2.text).not.toMatch(/fallback/);
  });
});

/** A browser with several tabs: each tab has a URL, the current tab gets the single-tab calls. */
class FakeTabs {
  tabs = [{ id: "t1", url: "https://mail.test/search" }];
  current = "t1";
  next = 2;
  calls: { method: string; params: any; tab: string }[] = [];
  failRead = new Set<string>();
  caller(): BrowserCaller {
    return {
      call: async (method: string, params: any): Promise<any> => {
        this.calls.push({ method, params, tab: this.current });
        const info = (t: { id: string; url: string }) => ({ id: t.id, url: t.url, title: `Title ${t.url}`, current: t.id === this.current });
        switch (method) {
          case "browser.openTabs": {
            const made = params.urls.map((url: string) => ({ id: `t${this.next++}`, url }));
            this.tabs.push(...made);
            if (params.background === false) this.current = made[0].id;
            return { tabs: made.map(info) };
          }
          case "browser.switchTab": {
            const t = this.tabs.find((x) => x.id === params.tab);
            if (!t) throw new Error(`unknown tab "${params.tab}"; call list_tabs`);
            this.current = t.id;
            return info(t);
          }
          case "browser.listTabs":
            return { tabs: this.tabs.map(info) };
          case "browser.closeTabs": {
            this.tabs = this.tabs.filter((t) => !params.tabs.includes(t.id));
            if (!this.tabs.some((t) => t.id === this.current)) this.current = "t1";
            return { closed: params.tabs, tabs: this.tabs.map(info) };
          }
          case "browser.readPage": {
            const id = params.tab ?? this.current;
            if (this.failRead.has(id)) throw new Error(`tab ${id} was closed`);
            const t = this.tabs.find((x) => x.id === id)!;
            const elements = Array.from({ length: id === "t3" ? 100 : 1 }, (_, i) => ({ index: i, tag: "a", role: "link", name: `link ${i}`, inViewport: true }));
            return { url: t.url, title: `Title ${t.url}`, text: `body of ${t.url}`, elements, truncated: false };
          }
          default:
            return { ok: true };
        }
      },
    } as BrowserCaller;
  }
}

describe("createToolExecutor: several tabs", () => {
  const multi = () => {
    const tabs = new FakeTabs();
    const { exec, events } = setup(new FakeX(), { browser: tabs.caller() });
    return { tabs, exec, events };
  };

  it("open_tabs returns the new tab ids and how to read them together", async () => {
    const { tabs, exec, events } = multi();
    const r = await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Opened 2 tab(s):");
    expect(r.text).toContain('t2 https://mail.test/m/1 "Title https://mail.test/m/1"');
    expect(r.text).toContain('read_page {"tabs": ["t2","t3"]}');
    expect(tabs.calls[0]).toMatchObject({ method: "browser.openTabs", params: { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] } });
    expect(tabs.calls[0]!.params).not.toHaveProperty("background");
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    await exec.call("open_tabs", { urls: ["https://mail.test/m/3"], background: false });
    expect(tabs.calls[1]!.params).toEqual({ urls: ["https://mail.test/m/3"], background: false });
    expect(tabs.current).toBe("t4");
  });

  it("read_page with tabs reads every tab in one result, each under its own header", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2", "https://mail.test/m/3"] });
    const r = await exec.call("read_page", { tabs: ["t2", "t3", "t4", "t2"] });
    expect(r.isError).toBeUndefined();
    const reads = tabs.calls.filter((c) => c.method === "browser.readPage");
    expect(reads.map((c) => c.params)).toEqual([{ tab: "t2" }, { tab: "t3" }, { tab: "t4" }]);
    const text = r.text!;
    expect(text.indexOf("===== Tab t2 =====")).toBeLessThan(text.indexOf("===== Tab t3 ====="));
    expect(text.indexOf("===== Tab t3 =====")).toBeLessThan(text.indexOf("===== Tab t4 ====="));
    expect(text).toContain("body of https://mail.test/m/1");
    expect(text).toContain("body of https://mail.test/m/3");
    // A long element list is cut per tab, with a pointer to the full list.
    expect(text).toContain("(20 more elements; switch_tab to t3 and call read_page for the full list)");
    expect(text).not.toContain('"link 80"');
    // The default read_page is unchanged: the current tab, no header.
    const plain = await exec.call("read_page", {});
    expect(tabs.calls.at(-1)!.params).toEqual({});
    expect(plain.text).toMatch(/^URL: https:\/\/mail\.test\/search/);
  });

  it("read_page with tabs shows a failing tab's error next to the others, and errors only when all fail", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    tabs.failRead.add("t3");
    const r = await exec.call("read_page", { tabs: ["t2", "t3"] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("===== Tab t3 =====\nCould not read this tab: tab t3 was closed");
    expect(r.text).toContain("body of https://mail.test/m/1");
    tabs.failRead.add("t2");
    expect((await exec.call("read_page", { tabs: ["t2", "t3"] })).isError).toBe(true);
  });

  it("switch_tab makes later tools act on that tab", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1"] });
    const r = await exec.call("switch_tab", { tab: "t2" });
    expect(r.text).toBe("Current tab is now t2: https://mail.test/m/1\nTitle: Title https://mail.test/m/1");
    await exec.call("act", { steps: [{ goal: "open reply", index: 0 }] });
    await exec.call("scroll", { direction: "down" });
    const after = tabs.calls.filter((c) => c.method === "browser.click" || c.method === "browser.scroll");
    expect(after.map((c) => c.tab)).toEqual(["t2", "t2"]);
    const bad = await exec.call("switch_tab", { tab: "t9" });
    expect(bad).toMatchObject({ isError: true, text: expect.stringContaining('unknown tab "t9"') });
  });

  it("list_tabs and close_tabs", async () => {
    const { tabs, exec } = multi();
    await exec.call("open_tabs", { urls: ["https://mail.test/m/1", "https://mail.test/m/2"] });
    await exec.call("switch_tab", { tab: "t3" });
    const list = await exec.call("list_tabs", {});
    expect(list.text!.split("\n")).toEqual([
      't1 https://mail.test/search "Title https://mail.test/search"',
      't2 https://mail.test/m/1 "Title https://mail.test/m/1"',
      't3 (current) https://mail.test/m/2 "Title https://mail.test/m/2"',
    ]);
    const closed = await exec.call("close_tabs", { tabs: ["t2", "t3"] });
    expect(closed.text).toBe('Closed t2, t3. Open tabs:\nt1 (current) https://mail.test/search "Title https://mail.test/search"');
    expect(tabs.current).toBe("t1");
    expect((await exec.call("close_tabs", { tabs: [] })).isError).toBe(true);
  });

  it("the prompts tell the model to open several pages at once", async () => {
    const { buildSystemPrompt } = await import("../src/index.js");
    const { TOOL_NAMES, INTERACTIVE_TOOL_NAMES } = await import("@browsertodo/shared");
    const task = buildSystemPrompt({ tools: TOOL_NAMES, jev: true });
    expect(task).toContain("- open_tabs:");
    expect(task).toMatch(/open them together with open_tabs .* one read_page call using `tabs`/);
    expect(task).toMatch(/tabs you opened are also closed when the task ends/);
    const terminal = buildSystemPrompt({ tools: INTERACTIVE_TOOL_NAMES, jev: true, interactive: true });
    expect(terminal).toMatch(/When a request needs several pages/);
    expect(terminal).not.toMatch(/when the task ends/);
    expect(buildSystemPrompt({ tools: ["navigate", "read_page"], jev: false })).not.toContain("open_tabs");
  });
});
