/** Sending an empty box: in Chat it looks at the page; elsewhere it does nothing, with a hint. */
import { describe, expect, it } from "vitest";
import { SCREEN_HELP_TEXT } from "@browsertodo/shared";
import { emptySend, SCREEN_PLACEHOLDER } from "../../src/sidepanel/composer.js";
import { describeEvent, isScreenHelp } from "../../src/sidepanel/event-format.js";

const base = { panelTab: "chat" as const, mode: "new" as const, sessionId: null, hasFiles: false, tabId: 7 };

describe("emptySend", () => {
  it("a new chat: a one-off run with the screen flag, in the panel's tab", () => {
    expect(emptySend(base)).toEqual({ request: { type: "run.adhoc", instructions: "", screen: true, tabId: 7 } });
    expect(emptySend({ ...base, tabId: null })).toEqual({ request: { type: "run.adhoc", instructions: "", screen: true } });
  });

  it("an ended conversation: its next turn, look at the page now and continue", () => {
    expect(emptySend({ ...base, mode: "conversation", sessionId: "S1" })).toEqual({
      request: { type: "run.message", sessionId: "S1", text: "", screen: true, tabId: 7 },
    });
  });

  it("nothing is sent under TODO, while a turn runs, or with files but no words", () => {
    expect(emptySend({ ...base, panelTab: "todo" })).toEqual({ hint: "Type a task to run it now" });
    expect(emptySend({ ...base, mode: "running", sessionId: "S1" })).toMatchObject({ hint: expect.stringMatching(/working/) });
    expect(emptySend({ ...base, hasFiles: true })).toMatchObject({ hint: expect.stringMatching(/files/) });
  });

  it("the Chat placeholder says what an empty send does, and the user's turn reads the same", () => {
    expect(SCREEN_PLACEHOLDER).toBe(SCREEN_HELP_TEXT);
    expect(isScreenHelp(SCREEN_HELP_TEXT)).toBe(true);
    expect(isScreenHelp("hello")).toBe(false);
    expect(describeEvent({ type: "user_message", text: SCREEN_HELP_TEXT })).toEqual({ kind: "user", text: SCREEN_HELP_TEXT, screen: true });
    expect(describeEvent({ type: "user_message", text: "hi" })).toEqual({ kind: "user", text: "hi" });
  });
});
