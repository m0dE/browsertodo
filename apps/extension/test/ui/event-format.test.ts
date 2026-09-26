import { describe, expect, it } from "vitest";
import { SCREEN_HELP_TEXT, type AgentEvent, type SessionInfo } from "@browsertodo/shared";
import { describeEvent, isBrainStartLine, isNearBottom, openingTurn, sameWords, spokenEchoes, turnPicks } from "../../src/sidepanel/event-format.js";
import { shortUrl, toolArgsSummary } from "../../src/text.js";

describe("toolArgsSummary", () => {
  it("summarizes the known tools", () => {
    expect(toolArgsSummary("navigate", { url: "https://www.x.com/home" })).toBe("x.com/home");
    expect(toolArgsSummary("read_page", {})).toBe("");
    expect(toolArgsSummary("click", { index: 12 })).toBe("#12");
    expect(toolArgsSummary("type", { index: 4, text: "hello" })).toBe('#4 "hello"');
    expect(toolArgsSummary("press_key", { key: "Control+Enter" })).toBe("Control+Enter");
    expect(toolArgsSummary("scroll", { direction: "down", amount: 2 })).toBe("down ×2");
    expect(toolArgsSummary("upload", { index: 3, paths: ["C:\\a\\b\\cat.png", "/x/dog.jpg"] })).toBe("#3 cat.png, dog.jpg");
    expect(toolArgsSummary("switch_x_account", { handle: "@me" })).toBe("@me");
    expect(toolArgsSummary("act", { steps: [{ goal: "open composer" }, { goal: "type", text: "hi" }, { goal: "post" }] })).toBe(
      "open composer (+2 more)",
    );
    expect(toolArgsSummary("task_fail", { reason: "login wall" })).toBe("login wall");
  });
  it("clips long text and handles unknown tools", () => {
    expect(toolArgsSummary("paste", { text: "a".repeat(200) }).length).toBeLessThanOrEqual(72);
    expect(toolArgsSummary("mystery", { a: 1, b: "two" })).toBe("a=1 b=two");
    expect(toolArgsSummary("mystery", undefined)).toBe("");
    expect(toolArgsSummary("click", "bad-args")).toBe("#undefined");
  });
});

describe("describeEvent", () => {
  it("tool results get a short preview and keep the full text", () => {
    const v = describeEvent({ type: "tool_result", id: "1", name: "read_page", text: "line one\nline two ".repeat(20) });
    expect(v.kind).toBe("result");
    if (v.kind !== "result") return;
    expect(v.preview.length).toBeLessThanOrEqual(90);
    expect(v.preview.startsWith("line one line two")).toBe(true);
    expect(v.full).toContain("\n");
  });
  it("image-only results say image", () => {
    const v = describeEvent({ type: "tool_result", id: "1", name: "screenshot", thumbnail: "AAAA" });
    expect(v).toMatchObject({ kind: "result", preview: "image", thumbnail: "AAAA", isError: false });
  });
  it("jev decisions become badges with ms", () => {
    const v = describeEvent({ type: "jev", goal: "click Post", operation: "click", index: 7, confidence: 0.934, executed: true, ms: 182 });
    expect(v).toEqual({ kind: "jev", label: "Jev: click #7 · 0.93", ms: 182, executed: true, title: "Jev (a faster helper for simple clicks and typing): click Post" });
    const n = describeEvent({ type: "jev", goal: "g", operation: "type", index: null, confidence: 0.4, executed: false, ms: 90 });
    expect(n).toMatchObject({ label: "Jev unsure (0.40) · Claude decides", executed: false });
    if (n.kind === "jev") expect(n.title).toContain("left to Claude");
  });
  it("task_end carries outcome, text and url", () => {
    expect(describeEvent({ type: "task_end", outcome: "done", summary: "Posted", url: "https://x.com/a/status/1" })).toEqual({
      kind: "end",
      chip: { label: "done", tone: "ok" },
      text: "Posted",
      url: "https://x.com/a/status/1",
    });
    expect(describeEvent({ type: "task_end", outcome: "failed", reason: "no" })).toMatchObject({ text: "no", chip: { tone: "bad" } });
  });
  it("the end card shows who picked the turn's elements; the picks status line itself is folded into it", () => {
    const events: AgentEvent[] = [
      { type: "status", text: "Jev chose 1 of 1 element pick (clicks and typing)", picks: { jev: 1, claude: 0 } },
      { type: "task_end", outcome: "done", summary: "first" },
      { type: "user_message", text: "again" },
      { type: "status", text: "Jev chose 9 of 11 element picks (clicks and typing); Claude chose 2", picks: { jev: 9, claude: 2 } },
      { type: "status", text: "Post verified" },
      { type: "task_end", outcome: "done", summary: "second" },
      { type: "user_message", text: "no Jev this time" },
      { type: "task_end", outcome: "done", summary: "third" },
    ];
    expect(turnPicks(events, 1)).toEqual({ jev: 1, claude: 0 });
    expect(turnPicks(events, 5)).toEqual({ jev: 9, claude: 2 });
    expect(turnPicks(events, 7)).toBeUndefined();
    expect(describeEvent(events[5]!, { picks: turnPicks(events, 5) })).toMatchObject({
      kind: "end",
      picks: "Jev chose 9 of 11 element picks (clicks and typing); Claude chose 2",
    });
    expect(describeEvent(events[7]!, {})).not.toHaveProperty("picks");
    expect(describeEvent(events[3]!)).toEqual({ kind: "status", text: events[3]!.type === "status" ? events[3]!.text : "", picks: true });
  });
  it("other kinds", () => {
    expect(describeEvent({ type: "assistant_text", text: "  hi \n" })).toEqual({ kind: "text", text: "hi" });
    expect(describeEvent({ type: "tool_call", id: "a", name: "navigate", args: { url: "https://a.b/c" } })).toEqual({
      kind: "tool",
      id: "a",
      name: "navigate",
      args: "a.b/c",
    });
    expect(describeEvent({ type: "user_message", text: "stop" }).kind).toBe("user");
    expect(describeEvent({ type: "error", text: "boom" })).toEqual({
      kind: "error",
      help: { message: "Something went wrong.", fixes: [], retry: true, known: false, details: "boom" },
    });
  });
});

it("shortUrl and isNearBottom", () => {
  expect(shortUrl("http://www.example.com/x")).toBe("example.com/x");
  expect(isNearBottom({ scrollTop: 480, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
  expect(isNearBottom({ scrollTop: 300, clientHeight: 500, scrollHeight: 1000 })).toBe(false);
});

describe("openingTurn: the conversation's first message", () => {
  const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime();
  const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 24 + dayOffset, h, m).toISOString();
  const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionId: "s1",
    source: "adhoc",
    title: "did i get my extension approved yet? can u check the e…",
    brain: "browsertodo",
    jev: true,
    startedAt: at(11, 58),
    ...over,
  });
  const PROMPT = "did i get my extension approved yet? can u check the email from the chrome web store\nand tell me what it says";

  it("a typed prompt: its full text (not the clipped title), no origin label, the time it started", () => {
    expect(openingTurn(session({ instructions: PROMPT }), [], NOW)).toEqual({ text: PROMPT, when: "11:58", at: at(11, 58) });
  });
  it("the start of the first turn, not the latest one; other days say which", () => {
    expect(openingTurn(session({ instructions: "x", startedAt: at(11, 59), firstStartedAt: at(9, 5) }), [], NOW).when).toBe("09:05");
    expect(openingTurn(session({ instructions: "x", startedAt: at(23, 0, -1) }), [], NOW).when).toBe("yesterday 23:00");
  });
  it("an old session without its instructions: the title it was saved with", () => {
    expect(openingTurn(session(), [], NOW).text).toBe("did i get my extension approved yet? can u check the e…");
  });
  it("an empty send: the screen-help turn", () => {
    const v = openingTurn(session({ title: SCREEN_HELP_TEXT, instructions: SCREEN_HELP_TEXT }), [], NOW);
    expect(v).toMatchObject({ text: SCREEN_HELP_TEXT, screen: true });
    expect(v.origin).toBeUndefined();
  });
  it("TODO list and cloud queue runs: their instructions, labelled with where they came from", () => {
    expect(openingTurn(session({ source: "local", taskId: "t1", title: "Post gm on X" }), [], NOW)).toMatchObject({ text: "Post gm on X", origin: "From your TODO list" });
    expect(openingTurn(session({ source: "cloud", taskId: "c1", title: "Post gm on X" }), [], NOW)).toMatchObject({ origin: "Scheduled" });
  });
  it("files: counted from the first turn's preparing line only", () => {
    const events: AgentEvent[] = [
      { type: "status", text: "Preparing 2 file(s)" },
      { type: "task_end", outcome: "done" },
      { type: "user_message", text: "again" },
      { type: "status", text: "Preparing 5 file(s)" },
    ];
    expect(openingTurn(session({ instructions: "Post these" }), events, NOW).files).toBe(2);
    expect(openingTurn(session({ instructions: "Post these" }), events.slice(1), NOW).files).toBeUndefined();
  });
});

describe("isBrainStartLine: the brain's own start line, which the chat's brain chip already says", () => {
  it("matches what each brain writes, including older sessions' lower-case hosted label", () => {
    for (const t of [
      "BrowserTODO AI (claude-opus-5-5) with Jev",
      "browsertodo AI (claude-opus-5-5) with Jev",
      "Claude API (claude-sonnet-5)",
      "Claude Code started (claude-sonnet-5)",
      "Claude Code started",
    ]) {
      expect(isBrainStartLine(t), t).toBe(true);
    }
  });
  it("leaves every other status line alone", () => {
    for (const t of [
      "Preparing 2 file(s)",
      "Continuing the same Claude Code session",
      "Claude API rate limit (HTTP 429); retrying in 5 s",
      "Post verified",
      "Jev chose 2 of 2 element picks (clicks and typing)",
    ]) {
      expect(isBrainStartLine(t), t).toBe(false);
    }
  });
});

describe("voice in the chat: spoken messages and lines said aloud", () => {
  it("a message the user spoke is marked; a typed one is not", () => {
    expect(describeEvent({ type: "user_message", text: "Read my mail", voice: true })).toEqual({ kind: "user", text: "Read my mail", voice: true });
    expect(describeEvent({ type: "user_message", text: "Read my mail" })).toEqual({ kind: "user", text: "Read my mail" });
  });

  it("the first message of a conversation started by voice is marked", () => {
    const s: SessionInfo = { sessionId: "s", source: "adhoc", title: "Read my mail", instructions: "Read my mail", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z", voice: true };
    expect(openingTurn(s, []).voice).toBe(true);
    expect(openingTurn({ ...s, voice: undefined } as SessionInfo, []).voice).toBeUndefined();
  });

  it("a line said aloud is its own kind of message", () => {
    expect(describeEvent({ type: "spoken", text: "Sarah says dinner moved to eight." })).toEqual({ kind: "spoken", text: "Sarah says dinner moved to eight." });
    expect(describeEvent({ type: "spoken", text: "I'll open Gmail." }, { echo: true })).toEqual({ kind: "spoken", text: "I'll open Gmail.", echo: true });
  });

  it("a spoken line that is the first sentence of the text above it (the plan, the summary) echoes it", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "Read my newest email", voice: true },
      { type: "assistant_text", text: "I'll open **Gmail** and read your newest email. Starting now." },
      { type: "spoken", text: "I'll open Gmail and read your newest email." },
      { type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com" } },
      { type: "task_end", outcome: "done", summary: "You have 1 new email from Sarah: dinner moved to 8. Nothing else is new." },
      { type: "spoken", text: "You have 1 new email from Sarah: dinner moved to 8." },
      { type: "spoken", text: "Sarah says dinner moved to eight." },
    ];
    expect(spokenEchoes(events, 2)).toBe(true);
    expect(spokenEchoes(events, 5)).toBe(true);
    // The agent's own spoken words are not written anywhere: a full spoken bubble.
    expect(spokenEchoes(events, 6)).toBe(false);
    // Not a spoken line, or the text is of an earlier turn.
    expect(spokenEchoes(events, 1)).toBe(false);
    const nextTurn: AgentEvent[] = [...events, { type: "user_message", text: "thanks" }, { type: "spoken", text: "I'll open Gmail and read your newest email." }];
    expect(spokenEchoes(nextTurn, nextTurn.length - 1)).toBe(false);
  });

  it("sameWords ignores case, spacing and punctuation", () => {
    expect(sameWords("Hi! What should I do?", "hi what should i do")).toBe(true);
    expect(sameWords("Hi", "Hi there")).toBe(false);
  });
});
