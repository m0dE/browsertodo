import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { chatForTab, followChat, isBound, otherRunning, ownChatOfTab, tabOfSession } from "../../src/sidepanel/tab-chat.js";

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
    // Left with New chat: that tab is a new chat again.
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

describe("ownChatOfTab: the chat hands-free voice talks to and narrates", () => {
  it("the tab's bound or just-started chat, never a scheduled run that only acts in the tab (its results were read out)", () => {
    expect(ownChatOfTab(1, state)).toBe("A");
    expect(ownChatOfTab(3, state, { pending: { tab: 3, sessionId: "N" } })).toBe("N");
    // Tab 9 has no chat; a scheduled run S works in it: the panel shows S there, voice does not follow it.
    expect(chatForTab(9, state)).toBe("S");
    expect(ownChatOfTab(9, state)).toBeNull();
    expect(ownChatOfTab(null, state)).toBeNull();
  });
});

describe("followChat: a tab's own panel keeps its conversation when the agent moves it", () => {
  it("the chat shown went on in the new tab its agent works in (the panel's tab shows a chrome:// page): that tab", () => {
    // Tab 3 (chrome://newtab) started N; the run works in new tab 8 and the chat now belongs there.
    expect(followChat(3, "N", { tabChats: { "8": "N" }, runningTabs: { N: [8] } })).toBe(8);
    // A quick turn is over by the time the state shows the move: the chat last sent to from here is still followed.
    expect(followChat(3, "N", { tabChats: { "8": "N" }, runningTabs: {} }, { tab: 3, sessionId: "N" })).toBe(8);
    // Sent from another tab, or another chat: not this panel's doing.
    expect(followChat(3, "N", { tabChats: { "8": "N" }, runningTabs: {} }, { tab: 5, sessionId: "N" })).toBe(3);
    expect(followChat(3, "N", { tabChats: { "8": "N" }, runningTabs: {} }, { tab: 3, sessionId: "M" })).toBe(3);
  });

  it("otherwise the tab stays", () => {
    // Still bound here.
    expect(followChat(3, "N", { tabChats: { "3": "N" }, runningTabs: { N: [3] } })).toBe(3);
    // The tab has a chat again (another one bound to it): it shows that one.
    expect(followChat(3, "N", { tabChats: { "3": "M", "8": "N" }, runningTabs: { N: [8] } })).toBe(3);
    // The user moved it to another tab (History's "open here" there): not the agent's doing.
    expect(followChat(3, "N", { tabChats: { "4": "N" }, runningTabs: {} })).toBe(3);
    // Nothing shown, or the chat is bound nowhere.
    expect(followChat(3, null, { tabChats: { "8": "N" }, runningTabs: { N: [8] } })).toBe(3);
    expect(followChat(3, "N", { runningTabs: { N: [8] } })).toBe(3);
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
