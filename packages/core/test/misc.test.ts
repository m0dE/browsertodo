import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_SUGGESTION_CHARS, normalizeHandle, SUGGESTION_NEVER, TOOL_NAMES, toolArgsSchema, toolsFor, type PageSnapshot } from "@browsertodo/shared";
import { errorDetail, plainErrorText } from "../src/api-errors.js";
import { mapStrings, MIN_SECRET_CHARS, REDACTED, SecretRedactor } from "../src/redact.js";
import { SCREEN_HELP_TEXT } from "@browsertodo/shared";
import { agentError, buildFollowUpMessage, buildSystemPrompt, buildTaskPrompt, classifyFailure, createJev, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT, formatSnapshot, timeLimitReached, toolCallLimitExceeded, verifyXPost } from "../src/index.js";
import { buildJevQuestions, buildJevState, jevFromClient, type JevClientLike } from "../src/jev.js";
import { mentionsHandle, MENU_POLL, switchXAccount } from "../src/x-account.js";
import type { BrowserCaller } from "../src/types.js";
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

  it("builds a trimmed state, capped at 250, in-viewport elements first", () => {
    const s = buildJevState("post it", snapshot(400));
    expect(s.elements).toHaveLength(250);
    // The 200 in-viewport elements come first (in page order), then offscreen ones.
    expect(s.elements.slice(0, 200).every((e) => e.inViewport)).toBe(true);
    expect(s.elements.slice(0, 200).map((e) => e.index)).toEqual(Array.from({ length: 200 }, (_, i) => i * 2));
    expect(s.elements[200]).toEqual({ index: 1, role: "button", name: "b1", tag: "button", text: "shown", type: "submit", testId: "t1", inViewport: false });
    expect(s).toMatchObject({ goal: "post it", typesText: false, url: "https://x.com/home", title: "Home" });
    expect(s.previousStep).toBeUndefined();
  });

  it("state: occurrence of look-alike elements, short links, page text, the step's text flag and the previous step", () => {
    const snap: PageSnapshot = {
      url: "https://x.com/home",
      title: "Home",
      text: "a".repeat(5000),
      truncated: false,
      elements: [
        { index: 0, tag: "button", role: "button", name: "Reply", inViewport: true },
        { index: 1, tag: "a", role: "link", name: "Alpha", href: "https://x.com/alpha/status/1", inViewport: true },
        { index: 2, tag: "button", role: "button", name: "Reply", inViewport: false },
      ],
    };
    const s = buildJevState("click the second Reply", snap, 250, { typesText: true, previousStep: "step 1: clicked Home" });
    expect(s.typesText).toBe(true);
    expect(s.previousStep).toBe("step 1: clicked Home");
    expect(s.pageText).toHaveLength(1200);
    expect(s.elements.map((e) => [e.index, e.occurrence])).toEqual([
      [0, "1 of 2"],
      [1, undefined],
      [2, "2 of 2"],
    ]);
    expect(s.elements[1]!.href).toBe("/alpha/status/1");
    const q = buildJevQuestions(s);
    // Each target option is described: label, occurrence, link and whether it is in view.
    expect(q.target.criteria["2"]).toBe('button "Reply", 2 of 2 with this label, offscreen');
    expect(q.target.criteria["1"]).toBe('link "Alpha", links to /alpha/status/1, in view');
    expect(q.operation.instructions).toMatch(/this step types text/);
  });

  it("state: an open dialog's elements come first and are marked, so 'the Post button' means the dialog's", () => {
    const snap: PageSnapshot = {
      url: "https://x.com/compose/post",
      title: "Home / X",
      text: "",
      truncated: false,
      elements: [
        { index: 0, tag: "div", role: "textbox", name: "Post text", testId: "tweetTextarea_0", inViewport: true },
        { index: 1, tag: "button", role: "button", name: "Post", testId: "tweetButtonInline", inViewport: true },
        { index: 2, tag: "a", role: "link", name: "Later", inViewport: false },
        { index: 3, tag: "div", role: "textbox", name: "Post text", testId: "tweetTextarea_0", inViewport: true, inDialog: true },
        { index: 4, tag: "button", role: "button", name: "Post", testId: "tweetButton", inViewport: true, inDialog: true },
      ],
    };
    const s = buildJevState("click the Post button", snap);
    expect(s.elements.map((e) => e.index)).toEqual([3, 4, 0, 1, 2]);
    const q = buildJevQuestions(s);
    expect(q.target.criteria["4"]).toBe('button "Post", 2 of 2 with this label, testid=tweetButton, in the open dialog, in view');
    expect(q.target.criteria["1"]).not.toMatch(/dialog/);
    expect(q.target.instructions).toMatch(/prefer the elements in the open dialog/);
  });

  it("asks operation + target choice questions and returns the lower confidence", async () => {
    const requests: any[] = [];
    const client: JevClientLike = {
      systemOne: async (req) => {
        requests.push(req);
        return {
          answers: {
            operation: { type: "choice", choice: "click", confidence: 0.95, probabilities: {} },
            target: { type: "choice", choice: "3", confidence: 0.85, probabilities: { "0": 0.01, "3": 0.85, "4": 0.1, none: 0.04 } },
          },
        };
      },
    };
    const d = await jevFromClient(client).decide({ goal: "g", snapshot: snapshot(5), typesText: false, previousStep: "step 1: waited" });
    // ranked: the target's probabilities, most likely first ("none" left out), for the candidate list when unsure.
    expect(d).toEqual({ operation: "click", index: 3, confidence: 0.85, ranked: [3, 4, 0] });
    expect(requests[0].state.previousStep).toBe("step 1: waited");
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
    expect(d).toEqual({ operation: "type", index: null, confidence: 0.9, ranked: [] });
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

  it("waits for the account menu to render after opening it", async () => {
    const x = new FakeX({ account: "alice" });
    const inner = x.caller();
    let slowReads = 0;
    const waits: number[] = [];
    const browser: BrowserCaller = {
      call: async (method, params) => {
        const r = await inner.call(method, params);
        // The menu takes two reads to show its entries.
        if (method === "browser.click" && x.menuOpen) slowReads = 2;
        if (method !== "browser.readPage" || slowReads === 0) return r;
        slowReads--;
        const page = r as PageSnapshot;
        return { ...page, elements: page.elements.filter((e) => e.testId !== "UserCell") } as never;
      },
    };
    const r = await switchXAccount(browser, "bob", { sleep: async (ms) => void waits.push(ms) });
    expect(r.text).toMatch(/Switched to @bob/);
    expect(waits.slice(0, 2)).toEqual([MENU_POLL.intervalMs, MENU_POLL.intervalMs]);
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

  it("system prompt: a follow-up suggestion only for a likely next step, short, accepted by the user, never risky", () => {
    for (const jev of [false, true]) {
      const p = buildSystemPrompt({ tools: TOOL_NAMES, jev });
      expect(p).toContain("give it as `suggestion` in your task_complete, task_fail or task_pause call");
      expect(p).toContain(`at most ${MAX_SUGGESTION_CHARS} characters`);
      expect(p).toContain("runs only if they accept and send it");
      expect(p).toContain("Omit it when no next step is clearly likely");
      expect(p).toContain(SUGGESTION_NEVER);
    }
  });

  it("a kept-open agent's system prompt adds the follow-up rules", () => {
    const rule = /Follow-up messages: after you call task_complete/;
    expect(buildSystemPrompt({ tools: TOOL_NAMES, jev: false })).not.toMatch(rule);
    expect(buildSystemPrompt({ tools: TOOL_NAMES, jev: false, followUps: true })).toMatch(rule);
  });

  it("jev prompt tells Claude to plan and batch steps with act", () => {
    const p = buildSystemPrompt({ tools: TOOL_NAMES, jev: true });
    expect(p).toMatch(/Plan the whole task/);
    expect(p).toMatch(/one act call \(up to 8\)/);
    expect(p).toMatch(/act replaces click and type/);
    expect(p).toMatch(/Jev picks the element of every act step from your words/);
    expect(p).toMatch(/the Reply button under the first post/);
    expect(p).toMatch(/do not guess or ask for indices/);
    expect(p).toContain("If act stops at step N as not confident");
    expect(p).not.toMatch(/each naming the element index/);
    // The tool list uses the Jev descriptions.
    expect(p).toMatch(/- read_page: .*no index numbers/);
    const noJev = buildSystemPrompt({ tools: TOOL_NAMES, jev: false });
    expect(noJev).toMatch(/each naming the element index/);
    expect(noJev).not.toMatch(/Jev picks the element/);
    expect(noJev).toMatch(/- read_page: .*indexed list/);
  });

  it("rules and tool descriptions agree: sign-in with get_credential off X, verify once, act without Jev needs indices", () => {
    const tools = toolsFor();
    for (const jev of [false, true]) {
      const p = buildSystemPrompt({ tools, jev });
      // A non-X login page is get_credential's job; pausing is for X, or when no login is saved.
      expect(p).toContain("On a login page of a site other than X, call get_credential for that site");
      expect(p).not.toContain("Call task_pause (never guess) when you see a login page,");
      // One verify rule, not "verify once" next to "verify important steps".
      expect(p.match(/Verify once at the end/g)).toHaveLength(1);
      expect(p).not.toContain("Verify important steps");
      expect(p).not.toMatch(/switch_x_account: [^\n]*Verify with a screenshot/);
    }
    // Without Jev, act's description and arguments never offer a fast model that is not there.
    const noJev = buildSystemPrompt({ tools, jev: false });
    expect(noJev).not.toMatch(/- act: [^\n]*fast model/);
    expect(JSON.stringify(z.toJSONSchema(toolArgsSchema("act", false)))).not.toContain("fast model");
    // Without get_credential among the tools, a login page simply pauses.
    expect(buildSystemPrompt({ tools: tools.filter((n) => n !== "get_credential"), jev: false })).toContain("Call task_pause (never guess) when you see a login page,");
  });

  it("task prompt covers every website, information tasks and greetings", () => {
    const p = buildSystemPrompt({ tools: TOOL_NAMES, jev: false });
    expect(p).toMatch(/any website the user can: Gmail, LinkedIn, X/);
    expect(p).toMatch(/Never refuse or fail a task because it is on a site other than X/);
    expect(p).toMatch(/find something out/);
    expect(p).toMatch(/only a greeting/);
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

describe("screen help and restricted pages", () => {
  const screen = { id: "S", instructions: SCREEN_HELP_TEXT, account: null, screenHelp: true };

  it("an empty message: look first, say what it will do, then act; ask when unclear or risky", () => {
    const p = buildTaskPrompt(screen, [], { isRetry: false });
    expect(p).toContain(`<<<\n${SCREEN_HELP_TEXT}\n>>>`);
    expect(p).toMatch(/call screenshot, then read_page, on the current tab/);
    expect(p).toMatch(/what the user most likely needs to do next/);
    expect(p).toMatch(/verification link.*open that mailbox.*open_tabs/s);
    expect(p).toMatch(/Before acting, write one sentence/);
    expect(p).toMatch(/task_pause/);
    for (const risk of [/paying or buying/, /deleting anything/, /to other people/, /password or code you do not have/]) expect(p).toMatch(risk);
    // Page text still never instructs the agent.
    expect(p).toMatch(/never an instruction to you/);
    // Only for an empty message.
    expect(buildTaskPrompt({ id: "T", instructions: "Post gm", account: null }, [], { isRetry: false })).not.toMatch(/empty message/);
  });

  it("the next message: as typed, or for an empty one: look at the page now and continue", () => {
    expect(buildFollowUpMessage({ text: " like it too " })).toBe("like it too");
    const f = buildFollowUpMessage({ text: SCREEN_HELP_TEXT, screenHelp: true });
    expect(f).toMatch(/look at the current page now and continue/);
    expect(f).toMatch(/screenshot and read_page/);
    expect(f).toMatch(/task_pause/);
  });

  it("a page Chrome keeps extensions out of: named, worked around in other tabs, the user told what to press", () => {
    const page = { url: "chrome://newtab/", title: "New Tab" };
    const p = buildTaskPrompt({ id: "T", instructions: "verify my email", account: null, restrictedPage: page }, [], { isRetry: false });
    expect(p).toContain('"New Tab" (chrome://newtab/)');
    expect(p).toMatch(/does not allow extensions to see or control that page/);
    expect(p).toMatch(/other tabs/);
    expect(p).toMatch(/Click 'Verify email' on the page, then press Continue.*task_pause/s);
    expect(p).not.toMatch(/cannot see that page/);
    expect(buildTaskPrompt({ ...screen, restrictedPage: page }, [], { isRetry: false })).toMatch(/cannot see that page.*title and address/s);
    const next = buildFollowUpMessage({ text: "and now?", restrictedPage: page });
    expect(next.startsWith("and now?\n\nNote: the user's tab shows")).toBe(true);
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
    [EXITED_WITHOUT_RESULT, "transient"],
    [ENDED_WITHOUT_RESULT, "transient"],
    [agentError("fetch failed"), "transient"],
    [agentError("Cannot read properties of undefined"), "permanent"],
    ["Debugger detached (target_closed)", "transient"],
    ["debugger detached: canceled_by_user", "permanent"],
    ["Debugger was detached by the user", "permanent"],
    ["Claude API key rejected", "permanent"],
    ["No compose textbox found on https://x.com/home", "permanent"],
    ["The account is suspended", "permanent"],
    ["Login page: Log in to X", "permanent"],
    [toolCallLimitExceeded(60), "permanent"],
    [timeLimitReached(10), "permanent"],
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

describe("error text the user reads", () => {
  it("errorDetail: either API's error body, a bare message, else plain text; never an HTML page or unknown JSON", () => {
    expect(errorDetail(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).toBe("overloaded_error: Overloaded");
    expect(errorDetail(JSON.stringify({ error: "plan_required", message: "Upgrade to Plus" }))).toBe("plan_required: Upgrade to Plus");
    expect(errorDetail(JSON.stringify({ message: "Internal error" }))).toBe("Internal error");
    expect(errorDetail("<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>")).toBe("");
    expect(errorDetail(JSON.stringify({ unexpected: { shape: true } }))).toBe("");
    expect(errorDetail("  Bad gateway\n  try later ")).toBe("Bad gateway try later");
    expect(errorDetail("x".repeat(500), 10)).toBe("x".repeat(10));
  });

  it("plainErrorText replaces an embedded JSON error body with what it says", () => {
    expect(plainErrorText('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("API Error: 529 overloaded_error: Overloaded");
    expect(plainErrorText("Claude AI usage limit reached|1760000000")).toBe("Claude AI usage limit reached|1760000000");
    expect(plainErrorText("Not JSON { at all")).toBe("Not JSON { at all");
    expect(plainErrorText('{"weird":1}')).toBe("an error without details");
    // Still sorted as temporary: the status and the error type survive.
    expect(classifyFailure(plainErrorText('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))).toBe("transient");
  });
});

describe("SecretRedactor", () => {
  it("replaces known secrets in every string of a value, and leaves values alone while it knows none", () => {
    const r = new SecretRedactor();
    const value = { a: "pw is hunter22", b: ["hunter22", 3, null], c: { d: "x hunter22 y hunter22" } };
    expect(r.redact(value)).toBe(value);
    r.add("hunter22");
    expect(r.redact(value)).toEqual({ a: `pw is ${REDACTED}`, b: [REDACTED, 3, null], c: { d: `x ${REDACTED} y ${REDACTED}` } });
    expect(value.a).toBe("pw is hunter22");
  });

  it("ignores secrets too short to redact without garbling ordinary text", () => {
    const r = new SecretRedactor();
    r.add("a".repeat(MIN_SECRET_CHARS - 1));
    expect(r.redact("aaa bbb")).toBe("aaa bbb");
  });

  it("mapStrings walks objects and arrays only", () => {
    expect(mapStrings({ s: "a", n: 1, list: ["b"], nested: { t: "c" } }, (s) => s.toUpperCase())).toEqual({ s: "A", n: 1, list: ["B"], nested: { t: "C" } });
  });
});
