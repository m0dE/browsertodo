import { describe, expect, it } from "vitest";
import {
  elsewhereLabel,
  endsWithTab,
  listensElsewhere,
  lookingElsewhereNote,
  lookingHomeNote,
  remoteSession,
  spokenUseThisTab,
  TAB_TITLE_CHARS,
  useThisTabAnswer,
  useThisTabLine,
  viewedTab,
  voiceKeyAction,
} from "../../src/voice/hands-free-tab.js";
import type { VoiceSessionView } from "../../src/voice-session.js";

const tabs = (...ids: number[]) => new Set(ids);

describe("hands-free voice belongs to the tab it started in", () => {
  it("the voice key starts a session when none is on, and ends the one that is on, wherever it listens", () => {
    expect(voiceKeyAction(false)).toBe("start");
    expect(voiceKeyAction(true)).toBe("stop");
  });

  it("a tab its chat lives in (the agent's own tab brought to the front) is the session's own", () => {
    expect(listensElsewhere(tabs(1, 7), 7)).toBe(false);
    expect(listensElsewhere(tabs(1, 7), 2)).toBe(true);
  });

  it("the voice bar says where it listens only on other tabs", () => {
    expect(listensElsewhere(tabs(1), 1)).toBe(false);
    expect(listensElsewhere(tabs(1), 2)).toBe(true);
    expect(listensElsewhere(tabs(), 2)).toBe(false);
    expect(listensElsewhere(tabs(1), null)).toBe(false);
  });

  it("closing the session's tab ends it; closing another tab does not", () => {
    expect(endsWithTab(1, 1)).toBe(true);
    expect(endsWithTab(1, 2)).toBe(false);
    expect(endsWithTab(null, 2)).toBe(false);
  });

  it("names the tab it listens in, cut short, or 'another tab' without a title", () => {
    expect(elsewhereLabel("Inbox (3) - Gmail")).toBe("Voice is on in Inbox (3) - Gmail");
    const long = elsewhereLabel("Quarterly planning   doc — Google Docs — shared with the whole team");
    expect(long).toMatch(/^Voice is on in Quarterly planning doc — G.*…$/);
    expect(long.length - "Voice is on in ".length).toBeLessThanOrEqual(TAB_TITLE_CHARS);
    expect(elsewhereLabel(null)).toBe("Voice is on in another tab");
    expect(elsewhereLabel("  ")).toBe("Voice is on in another tab");
  });
});

const session = (s: Partial<VoiceSessionView> = {}): VoiceSessionView => ({ tabId: 1, windowId: 9, host: 1, engine: "realtime", viewing: 1, ...s });

describe("one session, known to every panel through the background", () => {
  it("a tab's own panel learns from the background which tab the user looks at (its page is hidden on others)", () => {
    // Tab 1's panel, shown tab 1 (its own), while the user looks at tab 2.
    expect(viewedTab(1, session({ viewing: 2 }), 1)).toBe(2);
    // Not known yet: the tab it shows.
    expect(viewedTab(1, null, 1)).toBe(1);
    expect(viewedTab(1, session({ viewing: null }), 1)).toBe(1);
    // The panel page opened as a tab shows the active tab of its window (the user looks at that page itself).
    expect(viewedTab(null, session({ viewing: 5 }), 2)).toBe(2);
    // On screen, a tab's own panel is where the user looks (whatever the window focus events said).
    expect(viewedTab(1, session({ viewing: 2 }), 1, true)).toBe(1);
  });

  it("another tab's panel shows the session (a notice), the panel of the tab it was moved to takes it over, its own stale report is nothing", () => {
    expect(remoteSession(null, 2)).toBe("none");
    expect(remoteSession(session(), 2)).toBe("notice");
    // Moved to tab 2 by voice while tab 1's panel runs it: tab 2's panel takes it over.
    expect(remoteSession(session({ tabId: 2 }), 2)).toBe("adopt");
    // This panel's own report (it has just stopped): nothing to show.
    expect(remoteSession(session({ host: 2 }), 2)).toBe("none");
    // The panel page opened as a tab has no tab: it only ever shows a notice.
    expect(remoteSession(session(), null)).toBe("notice");
    expect(remoteSession(session({ host: null }), null)).toBe("notice");
  });
});

describe("what the agent and the narrator are told while the user looks at another tab", () => {
  const shop = { title: "Shop A", url: "https://shop.example.com/cart" };
  const recipes = { title: "Recipes  B", url: "http://127.0.0.1:5173/b" };

  it("names both tabs, with their sites, short", () => {
    expect(lookingElsewhereNote(recipes, shop)).toBe("The user is looking at another tab: Recipes B (127.0.0.1:5173). You work in Shop A (shop.example.com).");
    expect(lookingElsewhereNote(null, null)).toBe("The user is looking at another tab: another tab. You work in the tab where voice started.");
    expect(lookingElsewhereNote({ title: "", url: "chrome://newtab/" }, { title: "Shop A", url: null })).toBe("The user is looking at another tab: newtab. You work in Shop A.");
    expect(lookingHomeNote(shop)).toBe("The user is looking at Shop A (shop.example.com) again, the tab you work in.");
  });

  it("hears 'use this tab' and its variants, not requests that mention a tab", () => {
    for (const said of ["Use this tab.", "use this tab please", "OK, switch here!", "Switch to this tab", "move over here", "Use voice here", "work in the current tab"]) {
      expect(spokenUseThisTab(said), said).toBe(true);
    }
    for (const said of ["Close this tab", "use this tab to find the cheapest flight", "What's on this tab?", "switch the heater on here", ""]) {
      expect(spokenUseThisTab(said), said).toBe(false);
    }
  });

  it("tells the narrator (and Standard, aloud) what use this tab did", () => {
    expect(useThisTabAnswer({ moved: recipes })).toBe("Moved: you now work in Recipes B (127.0.0.1:5173); what the user says goes to that tab's chat.");
    expect(useThisTabAnswer({ moved: { title: "New Tab", url: "chrome://newtab/" } })).toMatch(/Chrome doesn't let the agent see that page/);
    expect(useThisTabAnswer("here")).toBe("The user is already looking at the tab you work in.");
    expect(useThisTabAnswer("unknown")).toMatch(/Use voice here/);
    expect(useThisTabAnswer("gone")).toBe("That tab is gone: nothing moved.");
    expect(useThisTabLine({ moved: recipes })).toBe("Now working in Recipes B.");
    expect(useThisTabLine("here")).toBe("I'm already working in this tab.");
  });
});
