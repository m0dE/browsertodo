import { describe, expect, it } from "vitest";
import { describeEvent, isNearBottom, shortUrl, toolArgsSummary } from "../../src/sidepanel/event-format.js";

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
    expect(v).toEqual({ kind: "jev", label: "Jev: click #7 · 0.93", ms: 182, executed: true, title: "click Post" });
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
  it("other kinds", () => {
    expect(describeEvent({ type: "assistant_text", text: "  hi \n" })).toEqual({ kind: "text", text: "hi" });
    expect(describeEvent({ type: "tool_call", id: "a", name: "navigate", args: { url: "https://a.b/c" } })).toEqual({
      kind: "tool",
      id: "a",
      name: "navigate",
      args: "a.b/c",
    });
    expect(describeEvent({ type: "user_message", text: "stop" }).kind).toBe("user");
    expect(describeEvent({ type: "error", text: "boom" })).toEqual({ kind: "error", text: "boom" });
  });
});

it("shortUrl and isNearBottom", () => {
  expect(shortUrl("http://www.example.com/x")).toBe("example.com/x");
  expect(isNearBottom({ scrollTop: 480, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
  expect(isNearBottom({ scrollTop: 300, clientHeight: 500, scrollHeight: 1000 })).toBe(false);
});
