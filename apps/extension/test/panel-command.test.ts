/**
 * The side panel of each tab and the keyboard shortcuts: one opens the tab's panel with the cursor in its input; the
 * other talks (voice input) there.
 */
import { describe, expect, it, vi } from "vitest";
import { fakePort, type FakePort } from "./chrome-fake.js";
import { PanelCommands, type PanelCommandDeps, type PanelPort } from "../src/panel-command.js";
import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "../src/shortcut.js";

/** A side panel's port (its messages come in through deliver()). */
function panelPort(): FakePort {
  return fakePort("browsertodo-ui") satisfies PanelPort;
}

const WIN = 3;
/** The tab the key is pressed in, in window WIN. */
const tab = (id: number, windowId = WIN) => ({ id, windowId });

function setup(opts: { openFails?: boolean; reportsClosed?: boolean } = {}) {
  const calls: string[] = [];
  const tabs = new Set<number>();
  const open = vi.fn(async (t: number) => {
    calls.push(`open ${t}`);
    if (opts.openFails) throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
  });
  const disable = vi.fn(async (t: number) => void calls.push(`disable ${t}`));
  const badge = vi.fn();
  const deps: PanelCommandDeps = { open, disable, tabs, badge, ...(opts.reportsClosed ? { reportsClosed: true } : {}) };
  return { pc: new PanelCommands(deps), open, disable, badge, tabs, calls };
}

/** Tab `tabId`'s own panel that said hello; `focused`: its page has the keyboard focus. */
function openPanel(pc: PanelCommands, tabId: number, focused = true, draft = "", windowId = WIN): FakePort {
  const port = panelPort();
  pc.attach(port);
  port.deliver({ type: "panel.hello", windowId, tabId });
  port.deliver({ type: "panel.document", focused, draft });
  return port;
}

/** The panel page opened as a tab of the window (no tab of its own). */
function pageInTab(pc: PanelCommands, focused: boolean, windowId = WIN): FakePort {
  const port = panelPort();
  pc.attach(port);
  port.deliver({ type: "panel.hello", windowId });
  port.deliver({ type: "panel.document", focused, draft: "" });
  return port;
}

describe("PanelCommands: the shortcut opens the panel of the tab it was pressed in", () => {
  it("no panel in the tab: opens it synchronously (the key press is the user gesture), focused when it says hello", () => {
    const { pc, open, tabs } = setup();
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
    // Called before onCommand returned: nothing was awaited first.
    expect(open).toHaveBeenCalledWith(7);
    expect(tabs.has(7)).toBe(true);
    const port = openPanel(pc, 7);
    expect(port.posted).toEqual([{ type: "panel.focus" }]);
    expect(pc.hasPanel(7)).toBe(true);
    expect(pc.isOpen(WIN)).toBe(true);
  });

  it("another tab's panel does not count: the key in tab B opens B's own panel, A's is left alone", () => {
    const { pc, open, disable } = setup();
    const a = openPanel(pc, 7, false, "A's draft");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(8))).toBe("opened");
    expect(open.mock.calls).toEqual([[8]]);
    expect(disable).not.toHaveBeenCalled();
    const b = openPanel(pc, 8);
    expect(b.posted).toEqual([{ type: "panel.focus" }]);
    expect(a.posted).toEqual([]);
    expect(pc.hasPanel(7) && pc.hasPanel(8)).toBe(true);
    expect(pc.hasPanel(9)).toBe(false);
  });

  it("only the panel the shortcut opened is told to focus: once, and not when opening failed", async () => {
    const { pc } = setup();
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    const first = openPanel(pc, 7);
    // A later page of that tab (a reconnect after a worker restart) keeps what it shows.
    const later = openPanel(pc, 7);
    expect(first.posted).toEqual([{ type: "panel.focus" }]);
    expect(later.posted).toEqual([]);

    const failing = setup({ openFails: true });
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, tab(5))).toBe("opened");
    await Promise.resolve();
    expect(openPanel(failing.pc, 5).posted).toEqual([]);
  });

  it("the tab's panel has the keyboard focus (e.g. on History): Chat and the input get it, nothing is recreated", () => {
    const { pc, open, disable } = setup();
    const here = openPanel(pc, 7, true);
    const otherWindow = openPanel(pc, 9, true, "", 4);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("focused");
    expect(here.posted).toEqual([{ type: "panel.focus" }]);
    expect(otherWindow.posted).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it("the focus is in the page: only the tab's panel is recreated in the gesture (Chrome focuses only a new page)", () => {
    const { pc, calls, tabs } = setup();
    const here = openPanel(pc, 7, false, "half a message");
    const hidden = openPanel(pc, 8, false, "B's draft");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("reopened");
    // Synchronously, in this order: the tab's panel off (closed at once), then opened anew.
    expect(calls).toEqual(["disable 7", "open 7"]);
    expect([here.posted, hidden.posted]).toEqual([[], []]);
    // The old page goes (not taken for the user closing it); the new one gets the focus and the text it had.
    here.hostDisconnect();
    expect(calls).toEqual(["disable 7", "open 7"]);
    expect(tabs.has(7)).toBe(true);
    const here2 = openPanel(pc, 7, true);
    expect(here2.posted).toEqual([{ type: "panel.focus", draft: "half a message" }]);
    // Once: a later page of the tab keeps its own state.
    expect(openPanel(pc, 7).posted).toEqual([]);
  });

  it("recreating: a panel whose open() fails is not told to focus later; an empty box has no draft to restore", async () => {
    const failing = setup({ openFails: true });
    openPanel(failing.pc, 5, false);
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, tab(5))).toBe("reopened");
    await Promise.resolve();
    await Promise.resolve();
    expect(openPanel(failing.pc, 5).posted).toEqual([]);

    const { pc } = setup();
    openPanel(pc, 7, false, "");
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    expect(openPanel(pc, 7).posted).toEqual([{ type: "panel.focus" }]);
  });

  it("the draft to restore is the one of the panel's last focus change", () => {
    const { pc } = setup();
    const port = openPanel(pc, 7, true, "old");
    port.deliver({ type: "panel.document", focused: false, draft: "newer" });
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    port.hostDisconnect();
    expect(openPanel(pc, 7).posted).toEqual([{ type: "panel.focus", draft: "newer" }]);
  });

  it("the panel page opened as a tab, with the focus: it gets Chat and the input (it has no tab panel to open)", () => {
    const { pc, open } = setup();
    const page = pageInTab(pc, true);
    expect(pc.onCommand(VOICE_COMMAND, { windowId: WIN })).toBe("voice");
    expect(page.posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
    expect(open).not.toHaveBeenCalled();
    // Without the focus and without a tab, there is no panel to open.
    page.deliver({ type: "panel.document", focused: false, draft: "" });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: WIN })).toBe("ignored");
  });

  it("voice with no panel: opens it in the gesture; when it says hello it takes the focus, then starts listening", () => {
    const { pc, open } = setup();
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("opened");
    expect(open).toHaveBeenCalledWith(7);
    expect(openPanel(pc, 7, true).posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("voice with the focus in the page: the tab's panel is recreated like open-chat, and the new page listens", () => {
    const { pc, calls } = setup();
    const here = openPanel(pc, 7, false, "Post on X:");
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("reopened");
    expect(calls).toEqual(["disable 7", "open 7"]);
    here.hostDisconnect();
    expect(openPanel(pc, 7).posted).toEqual([{ type: "panel.focus", draft: "Post on X:" }, { type: "panel.voice" }]);
  });

  it("voice while a panel of the window listens: stops it, wherever the focus is and whichever tab is shown", () => {
    const { pc, open, disable } = setup();
    const port = openPanel(pc, 7, false);
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    // Pressed in another tab of the window (A's panel is hidden there, still listening).
    expect(pc.onCommand(VOICE_COMMAND, tab(8))).toBe("voice");
    expect(port.posted).toEqual([{ type: "panel.voice" }]);
    expect(open).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    // Stopped: the next press starts again, through the focus path.
    port.deliver({ type: "panel.listening", listening: false });
    port.deliver({ type: "panel.document", focused: true, draft: "" });
    expect(pc.onCommand(VOICE_COMMAND, tab(7))).toBe("voice");
    expect(port.posted.slice(1)).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("open-chat while the tab's panel listens and the focus is in the page: never recreated (the session would end)", () => {
    const { pc, disable, open } = setup();
    const port = openPanel(pc, 7, false);
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("focused");
    expect(port.posted).toEqual([{ type: "panel.focus" }]);
    expect(disable).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("other commands and calls without a window are ignored", () => {
    const { pc, open } = setup();
    expect(pc.onCommand("other", tab(7))).toBe("ignored");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, undefined)).toBe("ignored");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { id: 7 })).toBe("ignored");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("PanelCommands: the toolbar button and closing", () => {
  it("the toolbar button in a tab without its panel opens it there (synchronously: the click is the gesture)", () => {
    const { pc, open } = setup();
    pc.onAction({ id: 7, windowId: WIN });
    expect(open).toHaveBeenCalledWith(7);
    pc.onAction({ windowId: WIN });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a panel the user closes is disabled for its tab and forgotten; a new page there is a new panel", () => {
    const { pc, disable, tabs } = setup();
    const port = openPanel(pc, 7);
    expect(tabs.has(7)).toBe(true);
    port.hostDisconnect();
    expect(disable).toHaveBeenCalledWith(7);
    expect(tabs.has(7)).toBe(false);
    expect(pc.hasPanel(7)).toBe(false);
    expect(pc.isOpen(WIN)).toBe(false);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
  });

  it("where Chrome reports closed panels (onClosed), a page's port closing (a reload) is not a close", () => {
    const { pc, disable, tabs } = setup({ reportsClosed: true });
    openPanel(pc, 7).hostDisconnect();
    expect(disable).not.toHaveBeenCalled();
    expect(tabs.has(7)).toBe(true);
    pc.panelClosed(7);
    expect(disable).toHaveBeenCalledWith(7);
    expect(tabs.has(7)).toBe(false);
  });

  it("the shortcut recreating a panel: Chrome's close of the old page does not disable the tab", () => {
    const { pc, calls } = setup({ reportsClosed: true });
    const old = openPanel(pc, 7, false);
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    pc.panelClosed(7);
    old.hostDisconnect();
    expect(calls).toEqual(["disable 7", "open 7"]);
    // Once the new page is there, a close is a close again.
    openPanel(pc, 7);
    pc.panelClosed(7);
    expect(calls.at(-1)).toBe("disable 7");
  });

  it("a closed tab is forgotten, with a shortcut's pending focus", () => {
    const { pc, tabs } = setup();
    pc.onCommand(OPEN_CHAT_COMMAND, tab(7));
    pc.tabRemoved(7);
    expect(tabs.has(7)).toBe(false);
    expect(pc.hasPanel(7)).toBe(false);
  });

  it("after a worker restart, the remembered tabs have their panel before the pages say hello again", () => {
    const { pc, tabs } = setup();
    tabs.add(7);
    expect(pc.hasPanel(7)).toBe(true);
    // The key pressed then: open() (a no-op on the open panel) and focus when the page says hello; nothing recreated.
    expect(pc.onCommand(OPEN_CHAT_COMMAND, tab(7))).toBe("opened");
    expect(openPanel(pc, 7, false).posted).toEqual([{ type: "panel.focus" }]);
  });
});

describe("PanelCommands: the voice badge", () => {
  it("on the tab a listening panel's session belongs to, moved with it, set again when the tab loads, gone when it stops or the panel closes", () => {
    const { pc, badge } = setup();
    const port = openPanel(pc, 3);
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    expect(badge.mock.calls).toEqual([[7, true]]);
    // The same again (the panel says hello to a restarted background): nothing changes.
    port.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    expect(badge).toHaveBeenCalledTimes(1);
    // Chrome clears a tab's badge when it loads a page: set again, only there.
    pc.tabLoading(8);
    pc.tabLoading(7);
    expect(badge.mock.calls.at(-1)).toEqual([7, true]);
    expect(badge).toHaveBeenCalledTimes(2);
    // Moved to another tab (Use this tab).
    port.deliver({ type: "panel.listening", listening: true, tabId: 8 });
    expect(badge.mock.calls.slice(2)).toEqual([[7, false], [8, true]]);
    port.deliver({ type: "panel.listening", listening: false });
    expect(badge.mock.calls.at(-1)).toEqual([8, false]);
    pc.tabLoading(8);
    expect(badge).toHaveBeenCalledTimes(5);
    // Closed while listening: cleared.
    port.deliver({ type: "panel.listening", listening: true, tabId: 9 });
    port.hostDisconnect();
    expect(badge.mock.calls.slice(-2)).toEqual([[9, true], [9, false]]);
  });

  it("a badge stays while another panel still listens in that tab; listening without a tab sets none", () => {
    const { pc, badge } = setup();
    const a = openPanel(pc, 3);
    const b = pageInTab(pc, false);
    a.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    b.deliver({ type: "panel.listening", listening: true, tabId: 7 });
    a.deliver({ type: "panel.listening", listening: false });
    expect(badge.mock.calls.filter(([, on]) => !on)).toEqual([]);
    b.hostDisconnect();
    expect(badge.mock.calls.at(-1)).toEqual([7, false]);
    const c = openPanel(pc, 4, true, "", 5);
    badge.mockClear();
    c.deliver({ type: "panel.listening", listening: true });
    expect(badge).not.toHaveBeenCalled();
    expect(pc.listening(5)).toBe(true);
  });
});
