import { describe, expect, it } from "vitest";
import { CONVERSATION_TOOLS, INTERACTIVE_TOOL_NAMES, toolsFor, type TaskRunResult } from "@browsertodo/shared";
import { buildFollowUpMessage, buildSystemPrompt, buildTaskPrompt, createToolExecutor, type MemoryCall } from "../src/index.js";
import { FakeX } from "./fake-x.js";
import { collect, noSleep } from "./helpers.js";

function setup(memory?: MemoryCall) {
  const x = new FakeX({ credentials: { "shop.example": { username: "ada", password: "correcthorse9" } } });
  const { events, onEvent } = collect();
  const ended: TaskRunResult[] = [];
  const exec = createToolExecutor({
    browser: x.caller(),
    jev: null,
    jevThreshold: 0.8,
    onEvent,
    onTaskEnd: (r) => void ended.push(r),
    mediaPaths: [],
    sleep: noSleep,
    ...(memory ? { memory } : {}),
  });
  return { exec, events, ended };
}

describe("memory tools in the executor", () => {
  it("passes remember, recall and forget to the conversation's memory, with checked arguments", async () => {
    const calls: [string, unknown][] = [];
    const { exec } = setup(async (tool, args) => {
      calls.push([tool, args]);
      return tool === "forget" ? { text: "No memory entry m9.", isError: true } : { text: `${tool} ok` };
    });
    expect(await exec.call("remember", { kind: "account", subject: "Work email", text: "admin@runhq.io, /u/2" })).toEqual({ text: "remember ok" });
    expect(await exec.call("recall", { query: "work email" })).toEqual({ text: "recall ok" });
    expect(await exec.call("forget", { id: "m9" })).toEqual({ text: "No memory entry m9.", isError: true });
    expect(calls.map(([t]) => t)).toEqual(["remember", "recall", "forget"]);
    // A task's record: remember with a key (no subject), recall by key.
    expect(await exec.call("remember", { kind: "task", key: "48213", text: "Refund sent." })).toEqual({ text: "remember ok" });
    expect(await exec.call("recall", { key: "48213" })).toEqual({ text: "recall ok" });
    expect(calls.slice(3)).toEqual([["remember", { kind: "task", key: "48213", text: "Refund sent." }], ["recall", { key: "48213" }]]);
    calls.length = 3;
    // Bad arguments never reach memory.
    expect((await exec.call("remember", { kind: "secrets", subject: "x", text: "y" })).isError).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("refuses without a conversation (mcp-server --attach)", async () => {
    const { exec } = setup();
    expect(await exec.call("recall", { query: "x" })).toMatchObject({ isError: true, text: expect.stringMatching(/not available here/) });
  });

  it("never passes on a password get_credential handed out, in remember or in a run note", async () => {
    const calls: unknown[] = [];
    const { exec, ended } = setup(async (_tool, args) => {
      calls.push(args);
      return { text: "ok" };
    });
    await exec.call("get_credential", { site: "shop.example" });
    const r = await exec.call("remember", { kind: "account", subject: "Shop login", text: "ada / correcthorse9" });
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/password you were given/) });
    expect(calls).toEqual([]);
    await exec.call("task_complete", { summary: "Bought it", memory_note: "Signed in with correcthorse9 and bought the lamp" });
    expect(ended[0]).toEqual({ outcome: "done", summary: "Bought it" });
  });

  it("task_complete's memory_note becomes the result's memoryNote", async () => {
    const { exec, ended } = setup(async () => ({ text: "ok" }));
    await exec.call("task_complete", { summary: "Posted", memory_note: "Posted the tip about lists. Next: bookmarks." });
    expect(ended[0]).toEqual({ outcome: "done", summary: "Posted", memoryNote: "Posted the tip about lists. Next: bookmarks." });
  });
});

describe("memory in the prompts", () => {
  it("the tools are offered to task sessions, not to the user's own Claude Code", () => {
    expect(toolsFor()).toEqual(expect.arrayContaining(["remember", "recall", "forget"]));
    expect(CONVERSATION_TOOLS).toEqual(expect.arrayContaining(["remember", "recall", "forget"]));
    expect(INTERACTIVE_TOOL_NAMES).not.toContain("remember");
  });

  it("the system prompt says when to remember, to use memory first, and to correct stale entries", () => {
    const p = buildSystemPrompt({ tools: toolsFor(), jev: true });
    expect(p).toMatch(/Memory: .*Read it before exploring/);
    expect(p).toMatch(/Never save page content/);
    expect(p).toMatch(/proves wrong .* same kind and subject .* or forget it by id/);
    expect(p).toMatch(/memory_note/);
    expect(p).toMatch(/many separate things .*file what you learn about each under its identifier with remember .*key.*in a chat in the user.s own.*recall its key/);
    expect(buildSystemPrompt({ tools: toolsFor({ interactive: true }), jev: true })).not.toMatch(/Memory: /);
  });

  it("the memory block goes before the task's instructions, and before a follow-up message", () => {
    const memory = "Memory from earlier chats and runs (ids in brackets).\nAccounts:\n- [m1] Work email: /u/2";
    const task = buildTaskPrompt({ id: "t1", instructions: "Check my work inbox", account: null, memory }, [], { isRetry: false });
    expect(task.indexOf("[m1] Work email")).toBeGreaterThan(0);
    expect(task.indexOf("[m1] Work email")).toBeLessThan(task.indexOf("Task instructions:"));
    expect(buildTaskPrompt({ id: "t1", instructions: "x", account: null }, [], { isRetry: false })).not.toMatch(/Memory from/);
    const next = buildFollowUpMessage({ text: "and the other inbox?", memory, userTab: { url: "https://mail.google.com/", title: "Inbox", access: "here" } });
    expect(next.indexOf("[m1]")).toBeLessThan(next.indexOf("and the other inbox?"));
    expect(buildFollowUpMessage({ text: "hi", memory })).toBe(`${memory}\n\nhi`);
  });
});
