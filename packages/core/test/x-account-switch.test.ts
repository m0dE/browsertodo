/** switch_x_account on the account menu's harder layouts, and the X account check around publishing. */
import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../src/index.js";
import { switchXAccount } from "../src/x-account.js";
import type { BrowserCaller } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { collect, noSleep } from "./helpers.js";

describe("switchXAccount", () => {
  it("opens the menu's collapsed Personal accounts section when the account is folded in it", async () => {
    const x = new FakeX({ account: "alice", folded: ["carol"] });
    const r = await switchXAccount(x.caller(), "@carol", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @carol/);
    expect(x.account).toBe("carol");
  });

  it("the menu re-rendering under the click: the entry is looked up again in a new read and clicked", async () => {
    const x = new FakeX({ account: "alice" });
    const inner = x.caller();
    let rerendered = false;
    const browser: BrowserCaller = {
      call: async (method, params) => {
        const index = (params as { index?: number }).index ?? -1;
        if (method === "browser.click" && x.menuOpen && !rerendered && x.snapshot().elements[index]?.testId === "UserCell") {
          rerendered = true;
          throw new Error(`element ${index} not found; call read_page again`);
        }
        return inner.call(method, params);
      },
    };
    const r = await switchXAccount(browser, "bob", { sleep: noSleep });
    expect(r.text).toMatch(/^Switched to @bob/);
    expect(rerendered).toBe(true);
  });

  it("stops at a lock or login page: the user must act", async () => {
    const x = new FakeX({ url: "https://x.com/account/access", account: "alice" });
    const r = await switchXAccount(x.caller(), "bob", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/X locked the account.*task_pause/);
    expect(x.calls.map((c) => c.method)).toEqual(["browser.readPage"]);
  });
});

describe("the X account check around publishing", () => {
  it("a Post goes out while X shows the task's account; Ctrl+Enter is refused once X shows another one", async () => {
    const x = new FakeX({ url: "https://x.com/home", account: "bob" });
    const { onEvent } = collect();
    const exec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep, account: "@Bob" });
    await exec.call("read_page", {});
    const box = x.snapshot().elements.find((e) => e.testId === "tweetTextarea_0")!.index;
    await exec.call("act", { steps: [{ goal: "type", index: box, text: "hi from bob" }] });
    const post = x.snapshot().elements.find((e) => e.name === "Post" && e.role === "button")!.index;
    expect((await exec.call("act", { steps: [{ goal: "click Post", index: post }] })).isError).toBeFalsy();
    expect(x.posts.map((p) => p.account)).toEqual(["bob"]);

    x.account = "alice";
    await exec.call("navigate", { url: "https://x.com/home" });
    const key = await exec.call("press_key", { key: "Control+Enter" });
    expect(key).toMatchObject({ isError: true, text: expect.stringContaining("X is signed in as @alice, this job posts as @Bob") });
    expect(x.calls.filter((c) => c.method === "browser.pressKey")).toEqual([]);
  });

  it("other clicks on X are not held up, whatever account is signed in", async () => {
    const x = new FakeX({ url: "https://x.com/home", account: "alice" });
    const { onEvent } = collect();
    const exec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent, mediaPaths: [], sleep: noSleep, account: "@bob" });
    const home = x.snapshot().elements.find((e) => e.name === "Home")!.index;
    expect((await exec.call("click", { index: home })).isError).toBeFalsy();
  });
});
