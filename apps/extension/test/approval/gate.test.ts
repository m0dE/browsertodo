import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_REFUSAL_PREFIX,
  effectiveLevel,
  isApprovalRefusal,
  type AgentEvent,
  type ApprovalOutcome,
  type ApprovalRequest,
  type BrowserMethod,
  type EffectiveLevel,
  type PageSnapshot,
} from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import { ApprovalBroker } from "../../src/approval/broker.js";
import { ApprovalGate, approvalAsk, describeAction, type GateDeps } from "../../src/approval/gate.js";
import type { SystemOneLike } from "../../src/approval/jev-judge.js";
import { el } from "./cases.js";

const editor = el("textbox", "Post text", { tag: "div", testId: "tweetTextarea_0", index: 7 });
const postBtn = el("button", "Post", { testId: "tweetButtonInline", index: 8 });
const replyIcon = el("button", "Reply", { testId: "reply", index: 9 });
const homeLink = el("link", "Home", { href: "https://x.com/home", index: 10 });
const X_PAGE: PageSnapshot = { url: "https://x.com/home", title: "Home / X", text: "What is happening?!", elements: [editor, postBtn, replyIcon, homeLink], truncated: false };

/** A browser that records what ran. */
function fakeBrowser(page: PageSnapshot = X_PAGE) {
  const ran: { method: BrowserMethod; params: unknown }[] = [];
  const browser: BrowserCaller = {
    call: async (method, params) => {
      ran.push({ method, params });
      if (method === "browser.readPage") return page as never;
      if (method === "browser.navigate") return { url: (params as { url: string }).url, title: "" } as never;
      return { ok: true } as never;
    },
  };
  return { browser, ran, methods: () => ran.map((r) => r.method) };
}

interface Setup {
  level?: EffectiveLevel;
  instructions?: string;
  answer?: ApprovalOutcome | ((req: Omit<ApprovalRequest, "id" | "expiresAt">) => ApprovalOutcome);
  jev?: SystemOneLike | null;
  session?: () => string | null;
}

function setup(o: Setup = {}) {
  const b = fakeBrowser();
  const asked: Omit<ApprovalRequest, "id" | "expiresAt">[] = [];
  let level = o.level ?? "ask_consequential";
  const deps: GateDeps = {
    context: async () => ({ level, ...(o.instructions ? { instructions: o.instructions } : {}) }),
    request: async (_sessionId, ask) => {
      asked.push(ask);
      const a = o.answer ?? "allow_once";
      return typeof a === "function" ? a(ask) : a;
    },
    jev: () => o.jev ?? null,
  };
  const gate = new ApprovalGate(b.browser, o.session ?? (() => "s1"), deps);
  return { ...b, gate, asked, setLevel: (l: EffectiveLevel) => (level = l), call: gate.browser.call };
}

/** Reads the page, types the post, clicks Post: the X post flow. */
async function postFlow(call: BrowserCaller["call"]): Promise<void> {
  await call("browser.readPage", {});
  await call("browser.type", { index: 7, text: "Hello world" });
  await call("browser.click", { index: 8 });
}

describe("ApprovalGate per level", () => {
  it("full: nothing waits", async () => {
    const t = setup({ level: "full" });
    await postFlow(t.call);
    expect(t.asked).toEqual([]);
    expect(t.methods()).toEqual(["browser.readPage", "browser.type", "browser.click"]);
  });

  it("ask_all: every action that changes something waits; reads, scrolls and tab switches do not", async () => {
    const t = setup({ level: "ask_all" });
    await postFlow(t.call);
    await t.call("browser.scroll", { direction: "down" });
    await t.call("browser.screenshot", {});
    await t.call("browser.listTabs", {});
    await t.call("browser.pressKey", { key: "Escape" });
    await t.call("browser.navigate", { url: "https://x.com/explore" });
    expect(t.asked.map((a) => a.action)).toEqual(['Type into "Post text"', 'Click "Post"', "Press Escape", "Open x.com/explore"]);
    expect(t.asked[0]).toMatchObject({ text: "Hello world", site: "x.com" });
    expect(t.asked[0]!.why).toMatch(/approve every action/);
  });

  it("ask_consequential: typing runs, the Post click waits with the exact text and why", async () => {
    const t = setup();
    await postFlow(t.call);
    expect(t.asked).toEqual([{ action: 'Click "Post"', site: "x.com", why: "publishes", kind: "publish", text: "Hello world" }]);
    expect(t.methods()).toEqual(["browser.readPage", "browser.type", "browser.click"]);
  });

  it("ask_consequential: the Post button read while disabled, then typed and clicked in one act, still waits", async () => {
    const b = fakeBrowser({ ...X_PAGE, elements: X_PAGE.elements.map((e) => (e.index === 8 ? { ...e, disabled: true } : e)) });
    const asked: string[] = [];
    const gate = new ApprovalGate(b.browser, () => "s1", { context: async () => ({ level: "ask_consequential" }), request: async (_s, a) => (asked.push(a.action), "deny") });
    await gate.browser.call("browser.readPage", {});
    await gate.browser.call("browser.type", { index: 7, text: "Hello" });
    await expect(gate.browser.call("browser.click", { index: 8 })).rejects.toThrow(/did not approve/);
    expect(asked).toEqual(['Click "Post"']);
  });

  it("ask_consequential: a benign click or navigation needs no approval", async () => {
    const t = setup();
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 10 });
    await t.call("browser.navigate", { url: "https://x.com/home" });
    expect(t.asked).toEqual([]);
  });

  it("deny: the action does not run and the agent is told not to retry", async () => {
    const t = setup({ answer: "deny" });
    await t.call("browser.readPage", {});
    await t.call("browser.type", { index: 7, text: "Hello" });
    const err = await t.call("browser.click", { index: 8 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(APPROVAL_REFUSAL_PREFIX);
    expect((err as Error).message).toMatch(/denied it \(Click "Post"\).*Don't retry/);
    expect(isApprovalRefusal((err as Error).message)).toBe(true);
    expect(t.methods()).not.toContain("browser.click");
  });

  it("timeout counts as denied, with its own note", async () => {
    const t = setup({ answer: "timeout" });
    await t.call("browser.readPage", {});
    const err = (await t.call("browser.click", { index: 8 }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/No answer in time/);
    expect(t.methods()).not.toContain("browser.click");
  });

  it("an approval waits at most until shortly before the turn's time limit", async () => {
    const b = fakeBrowser();
    const timeouts: (number | undefined)[] = [];
    let endsAt: number | undefined = 1_000_000 + 5 * 60_000;
    const gate = new ApprovalGate(b.browser, () => "s1", {
      context: async () => ({ level: "ask_consequential", ...(endsAt === undefined ? {} : { endsAt }) }),
      request: async (_s, _a, opts) => (timeouts.push(opts?.timeoutMs), "allow_once"),
      now: () => 1_000_000,
    });
    await gate.browser.call("browser.readPage", {});
    await gate.browser.call("browser.click", { index: 8 });
    endsAt = 1_000_000 + 60 * 60_000;
    await gate.browser.call("browser.click", { index: 8 });
    endsAt = undefined;
    await gate.browser.call("browser.click", { index: 8 });
    expect(timeouts).toEqual([5 * 60_000 - 30_000, undefined, undefined]);
  });

  it("allow for this task: later actions of the same turn run without asking; a new turn asks again", async () => {
    const t = setup({ answer: "allow_task" });
    await postFlow(t.call);
    await t.call("browser.click", { index: 8 });
    expect(t.asked).toHaveLength(1);
    t.gate.release();
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 8 });
    expect(t.asked).toHaveLength(2);
  });

  it("an approval that comes after the slot moved to another session does not run the action", async () => {
    let session: string | null = "s1";
    const t = setup({ session: () => session, answer: () => ((session = "s2"), "allow_once") });
    await t.call("browser.readPage", {});
    const err = (await t.call("browser.click", { index: 8 }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/task ended before the user answered/);
    expect(t.methods()).not.toContain("browser.click");
  });

  it("no session (the user's own Claude Code attached): nothing waits", async () => {
    const t = setup({ session: () => null });
    await postFlow(t.call);
    expect(t.asked).toEqual([]);
  });

  it("a level changed mid-run applies to the next action", async () => {
    const t = setup({ level: "full" });
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 8 });
    t.setLevel("ask_consequential");
    await t.call("browser.click", { index: 8 });
    expect(t.asked).toHaveLength(1);
  });

  it("an index the last read did not list is unsure: it asks", async () => {
    const t = setup();
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 99 });
    expect(t.asked[0]).toMatchObject({ action: 'Click an element', why: expect.stringMatching(/could not be told apart/) });
  });

  it("another tab's read does not replace the page the actions go to", async () => {
    const t = setup();
    await t.call("browser.readPage", {});
    await t.call("browser.readPage", { tab: "t2" });
    await t.call("browser.click", { index: 8 });
    expect(t.asked[0]).toMatchObject({ action: 'Click "Post"' });
  });

  it("uses Jev for what the rules are unsure about: a Reply icon Jev calls harmless runs", async () => {
    const jev: SystemOneLike = { systemOne: async () => ({ answers: { consequence: { choice: "none", confidence: 0.97 } } }) };
    const t = setup({ jev });
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 9 });
    expect(t.asked).toEqual([]);
  });

  it("without Jev, an unsure action asks", async () => {
    const t = setup();
    await t.call("browser.readPage", {});
    await t.call("browser.click", { index: 9 });
    expect(t.asked).toHaveLength(1);
  });
});

describe("ApprovalGate for scheduled runs (full_within_task)", () => {
  it("what the task asks for runs; a consequential action it does not ask for waits", async () => {
    const t = setup({ level: "full_within_task", instructions: "Post 'Hello world' on X" });
    await postFlow(t.call);
    expect(t.asked).toEqual([]);
    const like = setup({ level: "full_within_task", instructions: "Summarize my timeline" });
    await postFlow(like.call);
    expect(like.asked[0]).toMatchObject({ action: 'Click "Post"', why: "publishes; the task does not ask for this" });
  });

  it("effectiveLevel: chat runs follow the chat level, scheduled ones the scheduled setting", () => {
    const s = { automationLevel: "ask_all" as const, scheduledAutomation: "full_within_task" as const };
    expect(effectiveLevel(s, false)).toBe("ask_all");
    expect(effectiveLevel(s, true)).toBe("full_within_task");
  });
});

describe("approval card words", () => {
  it("never shows a password, and lists several typed fields by name", () => {
    const pw = el("textbox", "Password", { type: "password" });
    const subject = el("textbox", "Subject");
    const body = el("textbox", "Message Body");
    const page = { url: "https://mail.google.com/mail/u/0/", title: "Gmail" };
    const send = approvalAsk(
      { method: "click", element: el("button", "Send"), page, typed: [{ element: pw, text: "hunter2" }, { element: subject, text: "Hi" }, { element: body, text: "See you" }] },
      "sends a message",
      "send",
    );
    expect(send.text).toBe("Subject: Hi\nMessage Body: See you");
    expect(approvalAsk({ method: "type", element: pw, text: "hunter2", page, typed: [] }, "x").text).toBeUndefined();
  });

  it("describes each kind of action", () => {
    const page = { url: "https://x.com/home", title: "" };
    expect(describeAction({ method: "click", element: el("checkbox", "Remember me"), checked: true, page, typed: [] })).toBe('Check "Remember me"');
    expect(describeAction({ method: "pressKey", key: "Control+Enter", page, typed: [] })).toBe("Press Control+Enter");
    expect(describeAction({ method: "upload", paths: ["C:\\photos\\cat.jpg"], page, typed: [] })).toBe("Upload cat.jpg");
    expect(describeAction({ method: "openTabs", urls: ["https://a.com/x", "https://b.com"], page, typed: [] })).toBe("Open 2 tabs");
    expect(describeAction({ method: "closeTabs", tabs: ["t2"], page, typed: [] })).toBe("Close tab t2");
  });
});

describe("ApprovalBroker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function broker() {
    const events: { sessionId: string; e: AgentEvent }[] = [];
    let n = 0;
    const b = new ApprovalBroker({ note: (sessionId, e) => void events.push({ sessionId, e }), now: () => Date.parse("2026-09-26T10:00:00Z"), newId: () => `a${++n}` });
    return { b, events };
  }
  const ask = { action: 'Click "Post"', site: "x.com", why: "publishes" };

  it("adds the request to the chat, resolves with the answer, and records how it ended", async () => {
    const { b, events } = broker();
    const p = b.request("s1", ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(events[0]).toEqual({ sessionId: "s1", e: { type: "approval_request", request: { ...ask, id: "a1", expiresAt: "2026-09-26T10:10:00.000Z" } } });
    expect(b.waiting("s1").map((r) => r.id)).toEqual(["a1"]);
    expect(b.answer("s2", "a1", "allow_once")).toBe(false);
    expect(b.answer("s1", "a1", "allow_once", "voice")).toBe(true);
    expect(await p).toBe("allow_once");
    expect(events[1]!.e).toEqual({ type: "approval_resolved", id: "a1", outcome: "allow_once", by: "voice" });
    expect(b.answer("s1", "a1", "deny")).toBe(false);
  });

  it("a shorter timeout (the turn ends sooner) sets when the card stops waiting", async () => {
    const { b, events } = broker();
    const p = b.request("s1", ask, { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(events[0]!.e).toMatchObject({ request: { expiresAt: "2026-09-26T10:01:00.000Z" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe("timeout");
  });

  it("no answer in 10 minutes: timeout", async () => {
    const { b, events } = broker();
    const p = b.request("s1", ask);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await p).toBe("timeout");
    expect(events.at(-1)!.e).toMatchObject({ type: "approval_resolved", outcome: "timeout" });
  });

  it("the turn ends first: its requests end, other conversations' wait on", async () => {
    const { b } = broker();
    const p1 = b.request("s1", ask);
    const p2 = b.request("s2", ask);
    b.end("s1");
    expect(await p1).toBe("ended");
    expect(b.waiting().map((r) => r.id)).toEqual(["a2"]);
    b.answer("s2", "a2", "deny");
    expect(await p2).toBe("deny");
  });

  it("a request that cannot be shown ends at once instead of waiting out its timeout", async () => {
    const b = new ApprovalBroker({ note: () => Promise.reject(new Error("storage full")) });
    expect(await b.request("s1", ask)).toBe("ended");
  });
});
