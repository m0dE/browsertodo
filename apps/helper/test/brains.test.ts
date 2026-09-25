import { describe, expect, it } from "vitest";
import { UserInput } from "../src/brains/brain.js";
import { extractPostText, extractStartUrl } from "../src/brains/scripted.js";
import { buildClaudeArgs, mapStreamEvent, userMessageLine } from "../src/brains/claude-code.js";

describe("UserInput", () => {
  it("queues until subscribed, and refuses after close", () => {
    const input = new UserInput();
    expect(input.push("a")).toBe(true);
    const got: string[] = [];
    input.onMessage((t) => got.push(t));
    input.push("b");
    let closed = 0;
    input.onClose(() => closed++);
    input.close();
    input.close();
    expect(input.push("c")).toBe(false);
    expect(got).toEqual(["a", "b"]);
    expect(closed).toBe(1);
  });
});

describe("ScriptedBrain helpers", () => {
  it("extracts the post text and the start URL", () => {
    expect(extractPostText("Go to the site. Post: hi there ")).toBe("hi there");
    expect(extractPostText("just this")).toBe("just this");
    expect(extractStartUrl("Open http://localhost:8787/compose. Post: see https://ex.com")).toBe("http://localhost:8787/compose");
    expect(extractStartUrl("Post: see https://ex.com")).toBeNull();
    expect(extractStartUrl("no url")).toBeNull();
  });
});

describe("ClaudeCodeBrain helpers", () => {
  it("builds the exact claude arguments (stream-json in and out, prompt on stdin)", () => {
    expect(
      buildClaudeArgs({
        systemPrompt: "rules",
        mcpConfigPath: "C:\\run\\mcp-config.json",
        allowedTools: ["mcp__browsertodo__click", "mcp__browsertodo__task_complete"],
        model: "sonnet",
      }),
    ).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      "C:\\run\\mcp-config.json",
      "--allowedTools",
      "mcp__browsertodo__click,mcp__browsertodo__task_complete",
      "--append-system-prompt",
      "rules",
      "--no-session-persistence",
      "--model",
      "sonnet",
    ]);
    expect(userMessageLine('say "hi"\nnow')).toBe('{"type":"user","message":{"role":"user","content":"say \\"hi\\"\\nnow"}}\n');
  });

  it("maps stream-json events to AgentEvents (no tool events)", () => {
    expect(
      mapStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "Opening the composer." }, { type: "tool_use", id: "x", name: "mcp__browsertodo__act", input: {} }] },
      }),
    ).toEqual([{ type: "assistant_text", text: "Opening the composer." }]);
    expect(mapStreamEvent({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: false, result: "done" })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|123" })).toEqual([
      { type: "error", text: "Claude Code: Claude AI usage limit reached|123" },
    ]);
    expect(mapStreamEvent({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([{ type: "error", text: "Claude Code: error_max_turns" }]);
    expect(mapStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5" })).toEqual([{ type: "status", text: "Claude Code started (claude-sonnet-5)" }]);
  });
});
