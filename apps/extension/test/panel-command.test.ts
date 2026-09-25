/** The keyboard shortcut: open the side panel, focus its input, toggle voice from there. */
import { describe, expect, it, vi } from "vitest";
import { fakePort, type FakePort } from "./chrome-fake.js";
import { PanelCommands, type PanelPort } from "../src/panel-command.js";
import { OPEN_CHAT_COMMAND } from "../src/shortcut.js";

/** A side panel's port (its messages come in through deliver()). */
function panelPort(): FakePort {
  return fakePort("browsertodo-ui") satisfies PanelPort;
}

function setup(opts: { openFails?: boolean } = {}) {
  const open = vi.fn(async (_w: number) => {
    if (opts.openFails) throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
  });
  const pc = new PanelCommands({ open });
  return { pc, open };
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

  it("the panel is open: Chat and the input get the focus (only that window's panel)", () => {
    const { pc, open } = setup();
    const here = panelPort();
    const other = panelPort();
    pc.attach(here);
    pc.attach(other);
    here.deliver({ type: "panel.hello", windowId: 3 });
    other.deliver({ type: "panel.hello", windowId: 4 });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("focused");
    expect(here.posted).toEqual([{ type: "panel.focus" }]);
    expect(other.posted).toEqual([]);
    expect(open).toHaveBeenCalledWith(3);
  });

  it("pressed while the panel's input has the focus: toggles voice in that panel", () => {
    const { pc, open } = setup();
    const port = panelPort();
    const other = panelPort();
    pc.attach(port);
    pc.attach(other);
    port.deliver({ type: "panel.hello", windowId: 3 });
    other.deliver({ type: "panel.hello", windowId: 4 });
    port.deliver({ type: "panel.input", focused: true });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("voice");
    expect(port.posted).toEqual([{ type: "panel.voice" }]);
    expect(other.posted).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    // Focus left the input: the shortcut focuses it again.
    port.deliver({ type: "panel.input", focused: false });
    expect(pc.onCommand(OPEN_CHAT_COMMAND, { windowId: 3 })).toBe("focused");
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
