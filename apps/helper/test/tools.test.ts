import { describe, expect, it, vi } from "vitest";
import { TOOL_NAMES, type PageSnapshot, type ToolName } from "@browsertodo/shared";
import { ToolRouter, type TaskFinish, type ToolSession } from "../src/tool-router.js";
import { buildJevState, jevDecide, type JevClientLike } from "../src/jev.js";
import { mentionsHandle, normalizeHandle, switchXAccount } from "../src/x-account.js";
import { formatSnapshot, parseSnapshotText } from "../src/page-format.js";
import { FakeX } from "./fake-x.js";

const noSleep = async () => {};

function makeSession(over: Partial<ToolSession> = {}) {
  const finished: TaskFinish[] = [];
  const events: Record<string, unknown>[] = [];
  const session: ToolSession = {
    taskId: "T1",
    allowedTools: new Set<ToolName>(TOOL_NAMES),
    jevThreshold: 0.8,
    beforeCall: () => null,
    finish: (r) => finished.push(r),
    log: (e) => events.push(e),
    ...over,
  };
  return { session, finished, events };
}

function makeRouter(x: FakeX, session: ToolSession | null, jev: JevClientLike | null = null) {
  return new ToolRouter({ browser: x.caller(), getSession: () => session, jev, sleep: noSleep, switchConfirmTimeoutMs: 50 });
}

function fakeJev(op: string, opConf: number, target: string, targetConf: number): JevClientLike & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    systemOne: async (req) => {
      requests.push(req);
      return {
        answers: {
          operation: { type: "choice", choice: op, confidence: opConf, probabilities: {} },
          target: { type: "choice", choice: target, confidence: targetConf, probabilities: {} },
        },
      };
    },
  };
}

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
        { index: 3, tag: "input", role: "textbox", name: "Q", value: "a, b", inViewport: true },
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
        '[3] textbox "Q" (input, value="a, b")',
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

describe("ToolRouter", () => {
  it("rejects invalid args without calling the browser", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session).call("T1", "click", { index: "three" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid arguments for click: index/);
    expect(x.calls).toHaveLength(0);
  });

  it("refuses calls for another task, and tools that are not allowed", async () => {
    const x = new FakeX();
    const { session } = makeSession({ allowedTools: new Set<ToolName>(["read_page"]) });
    const router = makeRouter(x, session);
    expect((await router.call("OTHER", "read_page", {})).isError).toBe(true);
    expect((await router.call("T1", "act", { goal: "x" })).text).toMatch(/not available/);
    expect(router.allowedTools("T1")).toEqual(["read_page"]);
  });

  it("maps plain tools to browser.* methods with a 60 s timeout", async () => {
    const x = new FakeX();
    const calls: any[] = [];
    const { session } = makeSession();
    const router = new ToolRouter({
      browser: { call: async (m: any, p: any, o: any) => (calls.push([m, p, o]), x.handle(m, p)) } as any,
      getSession: () => session,
    });
    await router.call("T1", "navigate", { url: "https://x.com/home" });
    await router.call("T1", "read_page", {});
    await router.call("T1", "click", { index: 1 });
    await router.call("T1", "type", { index: 1, text: "hi" });
    await router.call("T1", "paste", { text: "yo" });
    await router.call("T1", "press_key", { key: "Control+Enter" });
    await router.call("T1", "scroll", { direction: "down", amount: 2 });
    await router.call("T1", "upload", { index: 2, paths: ["C:\\a.png"] });
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["browser.navigate", { url: "https://x.com/home" }],
      ["browser.readPage", {}],
      ["browser.click", { index: 1 }],
      ["browser.type", { index: 1, text: "hi" }],
      ["browser.paste", { text: "yo" }],
      ["browser.pressKey", { key: "Control+Enter" }],
      ["browser.scroll", { direction: "down", amount: 2 }],
      ["browser.upload", { index: 2, paths: ["C:\\a.png"] }],
    ]);
    expect(calls.every((c) => c[2].timeoutMs === 60_000)).toBe(true);
  });

  it("returns read_page as compact text", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session).call("T1", "read_page", {});
    expect(r.text).toContain("URL: https://x.com/compose/post");
    expect(r.text).toContain('textbox "Post text" (div, testid=tweetTextarea_0)');
    expect(r.text).toContain("--- visible text ---");
  });

  it("returns screenshots as images and saves them", async () => {
    const x = new FakeX();
    const saved = vi.fn();
    const { session } = makeSession({ saveScreenshot: saved });
    const r = await makeRouter(x, session).call("T1", "screenshot", {});
    expect(r.image).toEqual({ base64: Buffer.from("fake-jpeg").toString("base64"), mimeType: "image/jpeg" });
    expect(saved).toHaveBeenCalledOnce();
  });

  it("turns browser errors into error results", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session).call("T1", "click", { index: 99 });
    expect(r).toEqual({ text: "click failed: element 99 not found; call read_page again", isError: true });
  });

  it("get_credential refuses X, and redacts the password in the log", async () => {
    const x = new FakeX({ credentials: { "example.com": { username: "u", password: "p4ss" } } });
    const { session, events } = makeSession();
    const router = makeRouter(x, session);
    for (const site of ["x.com", "https://www.x.com/login", "mobile.twitter.com"]) {
      const r = await router.call("T1", "get_credential", { site });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/never used for X/);
    }
    expect(x.calls).toHaveLength(0);
    const ok = await router.call("T1", "get_credential", { site: "https://www.example.com/login" });
    expect(ok.text).toBe("username: u\npassword: p4ss");
    expect(JSON.stringify(events)).not.toContain("p4ss");
    expect((await router.call("T1", "get_credential", { site: "other.com" })).text).toMatch(/No credential/);
    x.vaultLocked = true;
    expect((await router.call("T1", "get_credential", { site: "example.com" })).text).toMatch(/vault is locked/);
  });

  it("task_* tools record the outcome on the session", async () => {
    const x = new FakeX();
    const { session, finished } = makeSession();
    const router = makeRouter(x, session);
    await router.call("T1", "task_complete", { summary: "posted", url: "https://x.com/a/status/1" });
    await router.call("T1", "task_fail", { reason: "nope" });
    await router.call("T1", "task_pause", { reason: "2FA" });
    expect(finished).toEqual([
      { outcome: "done", summary: "posted", url: "https://x.com/a/status/1" },
      { outcome: "failed", reason: "nope" },
      { outcome: "paused", reason: "2FA" },
    ]);
  });

  it("returns the session's limit message instead of running the tool", async () => {
    const x = new FakeX();
    const { session } = makeSession({ beforeCall: (n) => (n.startsWith("task_") ? null : "Tool call limit of 60 reached. Call task_fail now.") });
    const router = makeRouter(x, session);
    const r = await router.call("T1", "read_page", {});
    expect(r).toEqual({ text: "Tool call limit of 60 reached. Call task_fail now.", isError: true });
    expect(x.calls).toHaveLength(0);
    expect((await router.call("T1", "task_fail", { reason: "limit" })).isError).toBeFalsy();
  });
});

describe("jev", () => {
  const snapshot = (n: number, visibleEvery = 2): PageSnapshot => ({
    url: "https://x.com/home",
    title: "Home",
    text: "",
    truncated: false,
    elements: Array.from({ length: n }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `b${i}`,
      inViewport: i % visibleEvery === 0,
      ...(i === 1 ? { testId: "t1", type: "submit" } : {}),
    })),
  });

  it("builds a trimmed state, capped at 250 and preferring in-viewport elements", () => {
    const s = buildJevState("post it", snapshot(400));
    expect(s.goal).toBe("post it");
    expect(s.elements).toHaveLength(250);
    // all 200 visible ones, plus the first 50 offscreen ones, in page order
    expect(s.elements.filter((e) => e.index % 2 === 0)).toHaveLength(200);
    expect(s.elements.map((e) => e.index)).toEqual([...s.elements.map((e) => e.index)].sort((a, b) => a - b));
    expect(s.elements[1]).toEqual({ index: 1, role: "button", name: "b1", tag: "button", type: "submit", testId: "t1" });
    expect(Object.keys(s.elements[0]!)).not.toContain("inViewport");
  });

  it("asks two choice questions and returns the lower confidence", async () => {
    const jev = fakeJev("click", 0.95, "3", 0.85);
    const d = await jevDecide({ goal: "g", snapshot: snapshot(5) }, jev);
    expect(d).toMatchObject({ operation: "click", index: 3, confidence: 0.85 });
    const q = jev.requests[0].questions;
    expect(Object.keys(q.operation.criteria)).toEqual(["click", "type", "scroll", "press_key", "wait", "done", "blocked"]);
    expect(Object.keys(q.target.criteria)).toEqual(["0", "1", "2", "3", "4", "none"]);
    expect(jev.requests[0].state.goal).toBe("g");
  });

  it("act: a confident click is executed and returns a fresh page", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const jev = fakeJev("click", 0.97, "1", 0.9); // [1] is the Home link
    const r = await makeRouter(x, session, jev).call("T1", "act", { goal: "go home" });
    expect(r.text).toMatch(/^Jev clicked \[1\] link "Home"/);
    expect(r.text).toContain("URL: ");
    expect(x.calls.map((c) => c.method)).toEqual(["browser.readPage", "browser.click", "browser.readPage"]);
  });

  it("act: low confidence returns not confident with the element list", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session, fakeJev("click", 0.95, "1", 0.5)).call("T1", "act", { goal: "go home" });
    expect(r.text).toMatch(/^not confident/);
    expect(r.text).toContain('[1] link "Home"');
    expect(x.calls.map((c) => c.method)).toEqual(["browser.readPage"]);
  });

  it("act: type returns guidance instead of typing", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session, fakeJev("type", 0.99, "2", 0.99)).call("T1", "act", { goal: "write the post" });
    expect(r.text).toMatch(/Jev chose to type into \[2\] textbox "Post text".*call type yourself/);
    expect(x.calls.map((c) => c.method)).toEqual(["browser.readPage"]);
  });

  it("act: blocked returns not confident even when sure", async () => {
    const x = new FakeX();
    const { session } = makeSession();
    const r = await makeRouter(x, session, fakeJev("blocked", 0.99, "none", 0.99)).call("T1", "act", { goal: "x" });
    expect(r.text).toMatch(/^not confident \(blocked/);
  });

  it("act: a Jev failure falls back to not confident", async () => {
    const x = new FakeX();
    const { session, events } = makeSession();
    const broken: JevClientLike = { systemOne: async () => Promise.reject(new Error("503")) };
    const r = await makeRouter(x, session, broken).call("T1", "act", { goal: "x" });
    expect(r.text).toMatch(/^not confident \(Jev is unavailable\)/);
    expect(events.some((e) => e.type === "jev_error")).toBe(true);
  });
});

describe("switch_x_account", () => {
  it("normalizes handles and matches them exactly", () => {
    expect(normalizeHandle(" bob ")).toBe("@bob");
    expect(normalizeHandle("@@bob")).toBe("@bob");
    expect(mentionsHandle("Bob @Bob", "@bob")).toBe(true);
    expect(mentionsHandle("Bobby @bobby", "@bob")).toBe(false);
  });

  it("reports already-on without clicking", async () => {
    const x = new FakeX({ account: "alice" });
    const r = await switchXAccount(x.caller(), "alice", { sleep: noSleep });
    expect(r).toEqual({ text: "Already on @alice." });
    expect(x.calls.some((c) => c.method === "browser.click")).toBe(false);
  });

  it("switches through the account menu and confirms", async () => {
    const x = new FakeX({ account: "alice" });
    const r = await switchXAccount(x.caller(), "@Bob", { sleep: noSleep });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Switched to @Bob/);
    expect(x.account).toBe("bob");
  });

  it("navigates to x.com/home first when off X", async () => {
    const x = new FakeX({ url: "about:blank", account: "alice" });
    const r = await switchXAccount(x.caller(), "carol", { sleep: noSleep });
    expect(r.text).toMatch(/Switched to @carol/);
    expect(x.calls[1]).toEqual({ method: "browser.navigate", params: { url: "https://x.com/home" } });
  });

  it("explains which step failed when the switcher is missing", async () => {
    const x = new FakeX({ hasSwitcher: false });
    const r = await switchXAccount(x.caller(), "bob", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/step 1 failed.*SideNav_AccountSwitcher_Button.*read_page and click.*screenshot/);
  });

  it("explains when the account is not signed in", async () => {
    const x = new FakeX({ accounts: ["alice"] });
    const r = await switchXAccount(x.caller(), "dave", { sleep: noSleep });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/step 2 failed.*@dave.*task_pause/);
  });
});
