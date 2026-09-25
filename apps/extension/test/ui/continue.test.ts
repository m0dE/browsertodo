import { describe, expect, it } from "vitest";
import type { AgentEvent, StampedAgentEvent } from "@browsertodo/shared";
import {
  buildContinueInstructions,
  continueTitle,
  doneSoFar,
  isContinuable,
  lastAssistantText,
  stopReason,
} from "../../src/continue.js";

const ev = (e: AgentEvent): StampedAgentEvent => ({ ...e, ts: "2026-09-24T10:00:00Z", sessionId: "s1" }) as StampedAgentEvent;

const EVENTS: StampedAgentEvent[] = [
  ev({ type: "status", text: "Started" }),
  ev({ type: "assistant_text", text: "Opening X." }),
  ev({ type: "tool_call", id: "1", name: "mcp__browsertodo__navigate", args: { url: "https://www.x.com/home" } }),
  ev({ type: "tool_result", id: "1", name: "navigate", text: "\nOpened https://x.com/home (title: Home / X)\nsecond line" }),
  ev({ type: "tool_call", id: "2", name: "click", args: { index: 7 } }),
  ev({ type: "tool_result", id: "2", name: "click", text: "no element 7", isError: true }),
  ev({ type: "tool_call", id: "3", name: "screenshot", args: {} }),
  ev({ type: "tool_result", id: "3", name: "screenshot", thumbnail: "abc" }),
  ev({ type: "user_message", text: "use the second draft" }),
  ev({ type: "tool_call", id: "4", name: "type", args: { index: 9, text: "hello\nworld" } }),
  ev({ type: "assistant_text", text: "Typed it; pressing Post next." }),
];

describe("isContinuable", () => {
  const s = (outcome: string | undefined, extra: object = {}) => ({ outcome, endedAt: "x", source: "adhoc", ...extra }) as never;
  it("paused, failed and retry runs that ended here", () => {
    expect(isContinuable(s("paused"))).toBe(true);
    expect(isContinuable(s("failed", { source: "local" }))).toBe(true);
    expect(isContinuable(s("retry"))).toBe(true);
  });
  it("not done, running, missing or cloud runs", () => {
    expect(isContinuable(s("done"))).toBe(false);
    expect(isContinuable(s(undefined, { endedAt: undefined }))).toBe(false);
    expect(isContinuable(s("paused", { endedAt: undefined }))).toBe(false);
    expect(isContinuable(s("paused", { source: "cloud" }))).toBe(false);
    expect(isContinuable(null)).toBe(false);
  });
});

describe("doneSoFar", () => {
  it("lists tool calls with short args and the first line of their result, plus user messages", () => {
    expect(doneSoFar(EVENTS)).toEqual({
      steps: [
        "navigate x.com/home → Opened https://x.com/home (title: Home / X)",
        "click #7 → error: no element 7",
        "screenshot → (screenshot)",
        'the user said: "use the second draft"',
        'type #9 "hello world" → (no result)',
      ],
      skipped: 0,
    });
  });

  it("keeps the last steps only and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ type: "tool_call", id: String(i), name: "press_key", args: { key: `K${i}` } }));
    const { steps, skipped } = doneSoFar(many);
    expect(steps).toHaveLength(15);
    expect(skipped).toBe(5);
    expect(steps[0]).toBe("press_key K5 → (no result)");
    expect(doneSoFar([])).toEqual({ steps: [], skipped: 0 });
  });
});

describe("continue helpers", () => {
  it("lastAssistantText, stopReason, continueTitle", () => {
    expect(lastAssistantText(EVENTS)).toBe("Typed it; pressing Post next.");
    expect(lastAssistantText([])).toBeNull();
    expect(stopReason({ outcome: "paused", reason: "stopped by user" })).toBe("stopped by user");
    expect(stopReason({ outcome: "retry" })).toBe("a temporary problem");
    expect(continueTitle("Post hello")).toBe("Continue: Post hello");
    expect(continueTitle("Continue: Post hello")).toBe("Continue: Post hello");
    expect(continueTitle("x".repeat(100))).toHaveLength(80);
  });
});

describe("buildContinueInstructions", () => {
  it("original task, what was done, the reason, the note and the no-repeat rules", () => {
    const text = buildContinueInstructions({
      instructions: "  Make a post on X about cats  ",
      session: { outcome: "paused", reason: "stopped by user" },
      events: EVENTS,
      note: "  it is already typed  ",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Make a post on X about cats");
    expect(text).toContain("--- Continuing a stopped run ---");
    expect(text).toContain("(reason: stopped by user)");
    expect(text).toContain("What it already did (oldest first):\n- navigate x.com/home");
    expect(text).toContain('Its last message: "Typed it; pressing Post next."');
    expect(text).toContain("The user adds: it is already typed");
    expect(text).toMatch(/read_page or screenshot/);
    expect(text).toMatch(/do not type it again/);
    expect(text).toMatch(/Never post twice/);
  });

  it("no tools used and no note", () => {
    const text = buildContinueInstructions({ instructions: "x", session: { outcome: "failed" }, events: [], note: " " });
    expect(text).toContain("(reason: it failed)");
    expect(text).toContain("It did not get to use any tools.");
    expect(text).not.toContain("The user adds");
    expect(text).not.toContain("Its last message");
  });
});
