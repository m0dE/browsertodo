import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { chatForTab, isBound, otherRunning, tabOfSession } from "../../src/sidepanel/tab-chat.js";

const state = {
  tabChats: { "1": "A", "2": "B" },
  runningTabs: { B: [2, 5], S: [9], A: [1] },
};

describe("chatForTab: the conversation the panel shows for a tab", () => {
  it("the tab's own conversation, or an empty new chat", () => {
    expect(chatForTab(1, state)).toBe("A");
    expect(chatForTab(2, state)).toBe("B");
    expect(chatForTab(3, state)).toBeNull();
    expect(chatForTab(null, state)).toBeNull();
    expect(chatForTab(1, {})).toBeNull();
  });

  it("a run in a tab with no chat (a scheduled run) shows there; an agent's extra tab does not steal a bound chat", () => {
    expect(chatForTab(9, state)).toBe("S");
    // Tab 5 was opened by B's agent, and B belongs to tab 2.
    expect(chatForTab(5, state)).toBeNull();
    // Left with New Chat: that tab is a new chat again.
    expect(chatForTab(9, state, { left: new Map([[9, "S"]]) })).toBeNull();
  });

  it("a conversation just started from the tab shows before the state says so", () => {
    expect(chatForTab(3, state, { pending: { tab: 3, sessionId: "N" } })).toBe("N");
    expect(chatForTab(4, state, { pending: { tab: 3, sessionId: "N" } })).toBeNull();
    // Once it is bound somewhere (it moved to a new tab), the pending note no longer applies.
    expect(chatForTab(3, { tabChats: { "8": "N" } }, { pending: { tab: 3, sessionId: "N" } })).toBeNull();
    expect(chatForTab(8, { tabChats: { "8": "N" } }, { pending: { tab: 3, sessionId: "N" } })).toBe("N");
  });
});

describe("where a conversation lives", () => {
  it("its tab, else the tab it runs in", () => {
    expect(tabOfSession("B", state)).toBe(2);
    expect(tabOfSession("S", state)).toBe(9);
    expect(tabOfSession("X", state)).toBeNull();
    expect(isBound("A", state)).toBe(true);
    expect(isBound("S", state)).toBe(false);
  });

  it("the switcher offers the running conversations of other tabs", () => {
    const s = (id: string) => ({ sessionId: id }) as SessionInfo;
    expect(otherRunning([s("A"), s("B"), s("S")], "A").map((x) => x.sessionId)).toEqual(["B", "S"]);
    expect(otherRunning([s("A")], null).map((x) => x.sessionId)).toEqual(["A"]);
  });
});
