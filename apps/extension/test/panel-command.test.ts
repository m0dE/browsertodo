/** The keyboard shortcuts: one opens the side panel with the cursor in its input; the other talks (voice input) there. */
import { describe, expect, it, vi } from "vitest";
import { fakePort, type FakePort } from "./chrome-fake.js";
import { PanelCommands, type PanelPort } from "../src/panel-command.js";
import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "../src/shortcut.js";

/** A side panel's port (its messages come in through deliver()). */
function panelPort(): FakePort {
  return fakePort("browsertodo-ui") satisfies PanelPort;
}

function setup(opts: { openFails?: boolean } = {}) {
  const calls: string[] = [];
  const open = vi.fn(async (w: number) => {
    calls.push(`open ${w}`);
    if (opts.openFails) throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
  });
  const closeAllInstantly = vi.fn(async () => void calls.push("closeAll"));
  const pc = new PanelCommands({ open, closeAllInstantly });
  return { pc, open, closeAllInstantly, calls };
}

/** A panel of window `windowId` that said hello; `focused`: its page has the keyboard focus. */
function openPanel(pc: PanelCommands, windowId: number, focused = true, draft = ""): FakePort {
  const port = panelPort();
  pc.attach(port);
  port.deliver({ type: "panel.hello", windowId });
  port.deliver({ type: "panel.document", focused, draft });
  return port;
}

describe("PanelCommands", () => {
  it("no panel in the window: opens it synchronously (the key press is the user gesture), then focuses it when it says hello", () => {
    const { pc, open } = setup();
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("opened");
    // Called before onCommand returned: nothing was awaited first.
    expect(open).toHaveBeenCalledWith(3);
    const port = panelPort();
    pc.attach(port);
    port.deliver({ type: "panel.hello", windowId: 3 });
    expect(port.posted).toEqual([{ type: "panel.focus" }]);
    expect(pc.isOpen(3)).toBe(true);
  });

  it("only the panel the shortcut opened is told to focus: once, and not when opening failed", async () => {
    const { pc } = setup();
    pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 });
    const first = panelPort();
    pc.attach(first);
    first.deliver({ type: "panel.hello", windowId: 3 });
    // A later panel of that window (the toolbar button, a reconnect) keeps the tab it shows.
    const later = panelPort();
    pc.attach(later);
    later.deliver({ type: "panel.hello", windowId: 3 });
    expect(first.posted).toEqual([{ type: "panel.focus" }]);
    expect(later.posted).toEqual([]);

    const failing = setup({ openFails: true });
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 5 })).toBe("opened");
    await Promise.resolve();
    const other = panelPort();
    failing.pc.attach(other);
    other.deliver({ type: "panel.hello", windowId: 5 });
    expect(other.posted).toEqual([]);
  });

  it("the panel is open and has the keyboard focus (e.g. on the Activity Log): Chat and the input get it (only that window's panel)", () => {
    const { pc, open, closeAllInstantly } = setup();
    const here = openPanel(pc, 3, true);
    const other = openPanel(pc, 4, true);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("focused");
    expect(here.posted).toEqual([{ type: "panel.focus" }]);
    expect(other.posted).toEqual([]);
    expect(open).toHaveBeenCalledWith(3);
    expect(closeAllInstantly).not.toHaveBeenCalled();
  });

  it("the panel is open but the keyboard focus is in the page: every panel is recreated in the gesture (Chrome focuses only a new one)", () => {
    const { pc, calls } = setup();
    const here = openPanel(pc, 3, false, "half a message");
    const other = openPanel(pc, 4, false, "draft in 4");
    const inTab = openPanel(pc, 3, false); // the panel page as a tab of the same window (e2e): not a second window to reopen
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("reopened");
    // Synchronously, in this order: closing every panel at once, then this window's, then the others' back.
    expect(calls).toEqual(["closeAll", "open 3", "open 4"]);
    expect([here.posted, other.posted, inTab.posted]).toEqual([[], [], []]);
    // The old pages go; the new ones say hello and get the focus with the text they had in the box.
    here.hostDisconnect();
    other.hostDisconnect();
    const here2 = openPanel(pc, 3, true);
    const other2 = openPanel(pc, 4, false);
    expect(here2.posted).toEqual([{ type: "panel.focus", draft: "half a message" }]);
    expect(other2.posted).toEqual([{ type: "panel.focus", draft: "draft in 4" }]);
    // Once: a later panel of the window keeps its own state.
    expect(openPanel(pc, 3).posted).toEqual([]);
  });

  it("recreating: a panel whose open() fails is not told to focus later; an empty box has no draft to restore", async () => {
    const failing = setup({ openFails: true });
    openPanel(failing.pc, 5, false);
    expect(failing.pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 5 })).toBe("reopened");
    await Promise.resolve();
    await Promise.resolve();
    expect(openPanel(failing.pc, 5).posted).toEqual([]);

    const { pc } = setup();
    openPanel(pc, 3, false, "");
    pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 });
    expect(openPanel(pc, 3).posted).toEqual([{ type: "panel.focus" }]);
  });

  it("the draft to restore is the one of the panel's last focus change", () => {
    const { pc } = setup();
    const port = openPanel(pc, 3, true, "old");
    port.deliver({ type: "panel.document", focused: false, draft: "newer" });
    pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 });
    port.hostDisconnect();
    expect(openPanel(pc, 3).posted).toEqual([{ type: "panel.focus", draft: "newer" }]);
  });

  it("open-chat only opens and focuses: pressed again with the cursor already in the box, it focuses (no voice)", () => {
    const { pc } = setup();
    const port = openPanel(pc, 3, true);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("focused");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("focused");
    expect(port.posted).toEqual([{ type: "panel.focus" }, { type: "panel.focus" }]);
  });

  it("voice with no panel: opens it in the gesture; when it says hello it takes the focus, then starts listening", () => {
    const { pc, open } = setup();
    expect(pc.onCommand(VOICE_COMMAND, { windowId: 3 })).toBe("opened");
    expect(open).toHaveBeenCalledWith(3);
    const port = openPanel(pc, 3, true);
    expect(port.posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("voice with the panel focused: focus the box and start listening there (only that window)", () => {
    const { pc, closeAllInstantly } = setup();
    const here = openPanel(pc, 3, true);
    const other = openPanel(pc, 4, true);
    expect(pc.onCommand(VOICE_COMMAND, { windowId: 3 })).toBe("voice");
    expect(here.posted).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
    expect(other.posted).toEqual([]);
    expect(closeAllInstantly).not.toHaveBeenCalled();
  });

  it("voice with the focus in the page: panels are recreated like open-chat; only this window's new panel starts listening", () => {
    const { pc, calls } = setup();
    const here = openPanel(pc, 3, false, "Post on X:");
    const other = openPanel(pc, 4, false);
    expect(pc.onCommand(VOICE_COMMAND, { windowId: 3 })).toBe("reopened");
    expect(calls).toEqual(["closeAll", "open 3", "open 4"]);
    here.hostDisconnect();
    other.hostDisconnect();
    expect(openPanel(pc, 3).posted).toEqual([{ type: "panel.focus", draft: "Post on X:" }, { type: "panel.voice" }]);
    expect(openPanel(pc, 4, false).posted).toEqual([{ type: "panel.focus" }]);
  });

  it("voice while listening: stops and sends in that panel, wherever the focus is (never recreated mid-recording)", () => {
    const { pc, open, closeAllInstantly } = setup();
    const port = openPanel(pc, 3, false);
    port.deliver({ type: "panel.listening", listening: true });
    expect(pc.onCommand(VOICE_COMMAND, { windowId: 3 })).toBe("voice");
    expect(port.posted).toEqual([{ type: "panel.voice" }]);
    expect(open).not.toHaveBeenCalled();
    expect(closeAllInstantly).not.toHaveBeenCalled();
    // Stopped: the next press starts again, through the focus path.
    port.deliver({ type: "panel.listening", listening: false });
    port.deliver({ type: "panel.document", focused: true, draft: "" });
    expect(pc.onCommand(VOICE_COMMAND, { windowId: 3 })).toBe("voice");
    expect(port.posted.slice(1)).toEqual([{ type: "panel.focus" }, { type: "panel.voice" }]);
  });

  it("a closed panel is forgotten; other commands and calls without a tab are ignored", () => {
    const { pc, open } = setup();
    const port = panelPort();
    pc.attach(port);
    port.deliver({ type: "panel.hello", windowId: 3 });
    port.hostDisconnect();
    expect(pc.isOpen(3)).toBe(false);
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("opened");
    expect(pc.onCommand("other", { windowId: 3 })).toBe("ignored");
    expect(pc.onCommand(OPEN_CHAT_COMMAND, undefined)).toBe("ignored");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
