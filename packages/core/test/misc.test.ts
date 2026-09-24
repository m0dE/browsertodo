import { describe, expect, it } from "vitest";
import { INTERACTIVE_TOOL_NAMES, TOOL_NAMES, type PageSnapshot } from "@browsertodo/shared";
import { buildSystemPrompt, buildTaskPrompt, classifyFailure, createJev, formatSnapshot, verifyXPost } from "../src/index.js";
import { buildJevState, jevFromClient, type JevClientLike } from "../src/jev.js";
import { mentionsHandle, normalizeHandle, switchXAccount } from "../src/x-account.js";
import { parseSnapshotText } from "../src/page-format.js";
import { FakeX } from "./fake-x.js";
import { noSleep } from "./helpers.js";

describe("page format", () => {
  it("formats elements compactly and parses them back", () => {
    const snap: PageSnapshot = {
      url: "https://x.com/home",
      title: "Home / X",
      text: "hello\nworld",
      truncated: true,
      elements: [
        { index: 0, tag: "button", role: "button", name: 'Say "hi"', testId: "tweetButton", disabled: true, inViewport: true },
        { index: 1, tag: "input", role: "textbox", name: "Files", type: "file", inViewport: false },
        { index: 2, tag: "a", role: "link", name: "Home", href: "https://x.com/home", inViewport: true },
        { index: 3, tag: "button", role: "button", name: "Account menu", text: "Alpha @alpha", inViewport: true },
      ],
    };
    const text = formatSnapshot(snap);
    expect(text).toBe(
      [
        "URL: https://x.com/home",
        "Title: Home / X",
        '[0] button "Say \\"hi\\"" (button, testid=tweetButton, disabled)',
        '[1] textbox "Files" (input, type=file, offscreen)',
        '[2] link "Home" (a, href=https://x.com/home)',
        '[3] button "Account menu" (button, text="Alpha @alpha")',
        "(element list truncated)",
        "--- visible text ---",
        "hello\nworld",
      ].join("\n"),
    );
    const parsed = parseSnapshotText(text);
    expect(parsed.url).toBe("https://x.com/home");
    expect(parsed.text).toBe("hello\nworld");
    expect(parsed.elements[0]).toMatchObject({ index: 0, role: "button", name: 'Say "hi"', testId: "tweetButton", disabled: true });
    expect(parsed.elements[1]).toMatchObject({ index: 1, tag: "input", type: "file" });
  });
});

describe("jev", () => {
  const snapshot = (n: number): PageSnapshot => ({
    url: "https://x.com/home",
    title: "Home",
    text: "",
    truncated: false,
    elements: Array.from({ length: n }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `b${i}`,
      inViewport: i % 2 === 0,
      ...(i === 1 ? { testId: "t1", type: "submit", text: "shown" } : {}),
    })),
  });

  it("builds a trimmed state, capped at 250 and preferring in-viewport elements", () => {
    const s = buildJevState("post it", snapshot(400));
    expect(s.elements).toHaveLength(250);
    expect(s.elements.filter((e) => e.index % 2 === 0)).toHaveLength(200);
    expect(s.elements.map((e) => e.index)).toEqual([...s.elements.map((e) => e.index)].sort((a, b) => a - b));
    expect(s.elements[1]).toEqual({ index: 1, role: "button", name: "b1", tag: "button", text: "shown", type: "submit", testId: "t1" });
  });

  it("asks operation + target choice questions and returns the lower confidence", async () => {
    const requests: any[] = [];
    const client: JevClientLike = {
      systemOne: async (req) => {
        requests.push(req);
        return {
          answers: {
            operation: { type: "choice", choice: "click", confidence: 0.95, probabilities: {} },
            target: { type: "choice", choice: "3", confidence: 0.85, probabilities: {} },
          },
        };
      },
    };
    const d = await jevFromClient(client).decide({ goal: "g", snapshot: snapshot(5) });
    expect(d).toEqual({ operation: "click", index: 3, confidence: 0.85 });
    const q = requests[0].questions;
    expect(Object.keys(q.operation.criteria)).toEqual(["click", "type", "scroll", "press_key", "wait", "done", "blocked"]);
    expect(Object.keys(q.target.criteria)).toEqual(["0", "1", "2", "3", "4", "none"]);
    expect(requests[0].state.goal).toBe("g");
  });

  it("createJev goes through the SDK with the given fetch", async () => {
    const seen: { url: string; body: any; headers: any }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            operation: { type: "choice", choice: "type", confidence: 0.9, probabilities: {} },
            target: { type: "choice", choice: "none", confidence: 0.99, probabilities: {} },
          },
          usage: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const jev = createJev("test-key", { fetch: fakeFetch, model: "jev-test" });
    const d = await jev.decide({ goal: "write", snapshot: snapshot(3) });
    expect(d).toEqual({ operation: "type", index: null, confidence: 0.9 });
    expect(seen[0]!.url).toMatch(/\/v1\/systemone$/);
    expect(seen[0]!.body.model).toBe("jev-test");
    expect(seen[0]!.body.state.goal).toBe("write");
  });
});

describe("switchXAccount", () => {
  it("normalizes handles and matches them exactly", () => {
    expect(normalizeHandle(" bob ")).toBe("@bob");
    expect(normalizeHandle("@@bob")).toBe("@bob");
    expect(mentionsHandle("Bob @Bob", "@bob")).toBe(true);
    expect(mentionsHandle("Bobby @bobby", "@bob")).toBe(false);
  });

  it("navigates to x.com/home first when off X, and explains a missing switcher", async () => {
    const x = new FakeX({ url: "about:blank", account: "alice" });
    expect((await switchXAccount(x.caller(), "carol", { sleep: noSleep })).text).toMatch(/Switched to @carol/);
    expect(x.calls[1]).toEqual({ method: "browser.navigate", params: { url: "https://x.com/home" } });
    const r = await switchXAccount(new FakeX({ hasSwitcher: false }).caller(), "bob", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/step 1 failed.*SideNav_AccountSwitcher_Button/);
  });
});

describe("prompts", () => {
  const task = { id: "T1", instructions: "Post: hello world", account: "@bob" };

  it("system prompt keeps the post-URL rules and lists the tools", () => {
    const p = buildSystemPrompt({ tools: TOOL_NAMES, jev: false });
    expect(p).toContain("A post URL contains /status/");
    expect(p).toContain("- task_complete:");
    expect(p).toContain("switch_x_account");
    expect(p).not.toMatch(/batching several small steps/);
  });

  it("jev prompt tells Claude to plan and batch steps with act", () => {
    const p = buildSystemPrompt({ tools: TOOL_NAMES, jev: true });
    expect(p).toMatch(/Plan the whole task/);
    expect(p).toMatch(/one act call \(up to 8\)/);
    expect(p).toMatch(/act replaces click and type/);
    expect(p).toMatch(/a fast model finds it/);
    expect(p).toContain("If act stops at step N");
    const noJev = buildSystemPrompt({ tools: TOOL_NAMES, jev: false });
    expect(noJev).toMatch(/each naming the element index/);
    expect(noJev).not.toMatch(/a fast model finds it/);
  });

  it("interactive prompt has no task_* tools and mentions the human in a terminal", () => {
    const p = buildSystemPrompt({ tools: INTERACTIVE_TOOL_NAMES, jev: true, interactive: true });
    expect(p).toMatch(/chatting with you in a terminal/);
    expect(p).not.toContain("- task_complete:");
    expect(p).not.toMatch(/Finish by calling exactly one of task_complete/);
    // even if task tools are passed, they are not listed
    expect(buildSystemPrompt({ tools: TOOL_NAMES, jev: false, interactive: true })).not.toContain("- task_pause:");
  });

  it("task prompt carries instructions, account, media and the retry check", () => {
    const p = buildTaskPrompt(task, ["C:\\m\\a.png"], { isRetry: false });
    expect(p).toContain("Task ID: T1");
    expect(p).toContain("Account: @bob");
    expect(p).toContain("Post: hello world");
    expect(p).toContain("- C:\\m\\a.png");
    expect(p).not.toMatch(/retry/i);
    const r = buildTaskPrompt(task, [], { isRetry: true });
    expect(r).toContain("Media files: none.");
    expect(r).toContain("open https://x.com/bob");
    expect(r).toMatch(/post with this exact text already exists/);
    expect(r).toMatch(/call task_complete with that post's \/status\/ URL/);
  });
});

describe("classifyFailure", () => {
  const table: [string, "transient" | "permanent"][] = [
    ["Claude API rate limit (HTTP 429: rate_limit_error)", "transient"],
    ["HTTP 529 overloaded_error", "transient"],
    ["Claude AI usage limit reached|1760000000", "transient"],
    ["You've hit your usage limit", "transient"],
    ["Overloaded", "transient"],
    ["Claude API server error (HTTP 500: api_error)", "transient"],
    ["connect ECONNREFUSED 127.0.0.1:443", "transient"],
    ["read ECONNRESET", "transient"],
    ["TypeError: fetch failed", "transient"],
    ["Failed to fetch", "transient"],
    ["browser.readPage timed out after 60000 ms", "transient"],
    ["request timeout", "transient"],
    ["helper disconnected", "transient"],
    ["agent exited without reporting a result", "transient"],
    ["agent ended without reporting a result", "transient"],
    ["could not verify the post", "transient"],
    ["Debugger detached (target_closed)", "transient"],
    ["debugger detached: canceled_by_user", "permanent"],
    ["Debugger was detached by the user", "permanent"],
    ["Claude API key rejected", "permanent"],
    ["No compose textbox found on https://x.com/home", "permanent"],
    ["The account is suspended", "permanent"],
    ["Login page: Log in to X", "permanent"],
    ["tool call limit exceeded (60 calls)", "permanent"],
    ["task time limit of 10 minutes reached", "permanent"],
    ["", "permanent"],
  ];
  it.each(table)("%s -> %s", (reason, kind) => {
    expect(classifyFailure(reason)).toBe(kind);
  });
});

describe("verifyXPost", () => {
  const post = { account: "bob", text: "Hello   World, this is a fairly long post that goes past forty characters", files: [], url: "https://x.com/bob/status/77" };

  it("navigates to the post and finds the snippet (whitespace and case insensitive)", async () => {
    const x = new FakeX({ posts: [post] });
    const r = await verifyXPost(x.caller(), post.url, "hello world, THIS is a fairly long post that goes past forty characters");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("found");
    expect(x.calls[0]).toEqual({ method: "browser.navigate", params: { url: post.url } });
  });

  it("fails when the text is not there, for non-post URLs, and on browser errors", async () => {
    const x = new FakeX({ posts: [post] });
    expect((await verifyXPost(x.caller(), post.url, "something else entirely")).ok).toBe(false);
    expect((await verifyXPost(x.caller(), "https://x.com/home", "Hello")).ok).toBe(false);
    const broken = { call: async () => Promise.reject(new Error("debugger detached")) };
    const r = await verifyXPost(broken, post.url, "Hello");
    expect(r).toEqual({ ok: false, detail: `could not open ${post.url}: debugger detached` });
  });
});

describe("verifyXPost missing-post page", () => {
  it("fails when X says the post does not exist", async () => {
    const { verifyXPost } = await import("../src/verify.js");
    const browser = {
      call: async (m: string) =>
        m === "browser.readPage"
          ? { url: "https://x.com/a/status/1", title: "X", text: "Hmm...this page doesn't exist. Try searching for something else.", elements: [], truncated: false }
          : { url: "https://x.com/a/status/1", title: "X" },
    };
    const r = await verifyXPost(browser as never, "https://x.com/a/status/1", "");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not exist/);
  });
});
