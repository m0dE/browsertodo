/** The automation level's line in the agent's prompts: the first task prompt and each follow-up message. */
import { describe, expect, it } from "vitest";
import { automationPromptLine } from "@browsertodo/shared";
import { buildFollowUpMessage, buildTaskPrompt } from "../src/prompts.js";

const task = { id: "t1", instructions: "Post 'hello' on X", account: null };

describe("approvals in the prompts", () => {
  it("the task prompt carries the level's line after the instructions; none at full autonomy", () => {
    const line = automationPromptLine("ask_consequential");
    const p = buildTaskPrompt({ ...task, approvals: line }, [], { isRetry: false });
    expect(p.indexOf(line)).toBeGreaterThan(p.indexOf(">>>"));
    expect(line).toMatch(/Prepare everything first/);
    expect(automationPromptLine("full")).toBe("");
    expect(buildTaskPrompt(task, [], { isRetry: false })).not.toContain("Approvals:");
  });

  it("each level says what waits", () => {
    expect(automationPromptLine("ask_all")).toMatch(/every action that changes something/);
    expect(automationPromptLine("full_within_task")).toMatch(/that the task does not ask for waits/);
  });

  it("a follow-up message ends with the line of this turn's level", () => {
    const line = automationPromptLine("ask_all");
    expect(buildFollowUpMessage({ text: "now reply to Maya", approvals: line })).toBe(`now reply to Maya\n\n${line}`);
    expect(buildFollowUpMessage({ text: "now reply to Maya" })).toBe("now reply to Maya");
  });
});
