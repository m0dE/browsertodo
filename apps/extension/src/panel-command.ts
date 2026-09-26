/**
 * The keyboard shortcut (the manifest's "commands" entry OPEN_CHAT_COMMAND,
 * see shortcut.ts): opens the side panel of the window and
 * puts the cursor in the chat input; when the panel is already open, it
 * switches it to Chat and focuses the input; pressed again while that input
 * has the focus, it starts or stops voice input there (the panel decides:
 * without a plan that includes voice it points at the locked mic button).
 *
 * Chrome counts a command as a user gesture, which sidePanel.open() needs,
 * but only while the listener runs: open() is called before anything is
 * awaited. The side panels report their window and where the keyboard focus
 * is over the UI port (PanelMessage), so the decision needs no await
 * either. A panel that the shortcut opened is told to focus when it says
 * hello (its ready handshake), not after some delay.
 *
 * Chrome moves the keyboard focus into a side panel only when it creates
 * the panel's page. open() on an open panel, close() then open() (Chrome
 * keeps the page through the close animation, and the gesture ends with the
 * listener), a new path, or the page's own window.focus() all leave the
 * focus in the web page, so typed keys would go there. So when the focus is
 * outside the panel, the shortcut closes the panels at once and opens them
 * again, all within the gesture. Chrome can only do that for every window
 * at once (see closeAllInstantly), so every window's panel is reopened; each
 * new page is told to focus and gets back the text its box had (the chat
 * itself comes from the background).
 *
 * Extension shortcuts work while a Chrome window has the focus. They are
 * not system-wide: Chrome allows "global" only for Ctrl+Shift+[0-9], and a
 * side panel cannot open without a focused Chrome window anyway.
 */

import { OPEN_CHAT_COMMAND } from "./shortcut.js";

/** Panel -> background on the UI port. */
export type PanelMessage =
  | { type: "panel.hello"; windowId: number }
  /** The cursor is in the chat input and the panel's page has the keyboard focus. */
  | { type: "panel.input"; focused: boolean }
  /** The panel's page got or lost the keyboard focus; `draft`: the text in its box then (a recreated panel gets it back). */
  | { type: "panel.document"; focused: boolean; draft: string };

/** A UI port as this uses it (chrome.runtime.Port). */
export interface PanelPort {
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface PanelCommandDeps {
  /** chrome.sidePanel.open({ windowId }). Called synchronously in the command listener. */
  open(windowId: number): Promise<void>;
  /**
   * Closes every window's side panel at once, without the close animation,
   * so that the next open() creates the panel's page anew. Called
   * synchronously in the command listener, right before open().
   */
  closeAllInstantly(): Promise<void>;
  log?(message: string): void;
}

export type CommandOutcome = "opened" | "reopened" | "focused" | "voice" | "ignored";

interface PanelInfo {
  windowId: number | null;
  inputFocused: boolean;
  /** The panel's page has the keyboard focus. */
  focused: boolean;
  /** The text in the box when the page last got or lost the focus. */
  draft: string;
}

export class PanelCommands {
  private readonly panels = new Map<PanelPort, PanelInfo>();
  /** Windows whose panel the shortcut is opening -> the text to put back in its box: focus it when it says hello. */
  private readonly opening = new Map<number, string>();

  constructor(private readonly deps: PanelCommandDeps) {}

  /** A side panel's UI port (after UiHub.attach accepted it). */
  attach(port: PanelPort): void {
    const info: PanelInfo = { windowId: null, inputFocused: false, focused: false, draft: "" };
    this.panels.set(port, info);
    port.onDisconnect.addListener(() => this.panels.delete(port));
    port.onMessage.addListener((raw) => {
      const msg = raw as Partial<PanelMessage> | null;
      if (msg?.type === "panel.hello" && typeof msg.windowId === "number") {
        info.windowId = msg.windowId;
        const draft = this.opening.get(msg.windowId);
        if (draft === undefined) return;
        this.opening.delete(msg.windowId);
        this.post(port, draft ? { type: "panel.focus", draft } : { type: "panel.focus" });
      } else if (msg?.type === "panel.input" && typeof msg.focused === "boolean") {
        info.inputFocused = msg.focused;
      } else if (msg?.type === "panel.document" && typeof msg.focused === "boolean") {
        info.focused = msg.focused;
        info.draft = typeof msg.draft === "string" ? msg.draft : "";
      }
    });
  }

  /** The window has an open side panel (it said hello). */
  isOpen(windowId: number): boolean {
    return this.panelsOf(windowId).length > 0;
  }

  /** The window's side panel has the keyboard focus in its chat input (the shortcut then toggles voice). */
  inputFocused(windowId: number): boolean {
    return this.panelsOf(windowId).some(([, p]) => p.inputFocused);
  }

  /**
   * chrome.commands.onCommand. Synchronous until sidePanel.open() was
   * called, so Chrome still counts the key press as the user gesture.
   */
  onCommand(command: string, tab?: { windowId?: number } | null): CommandOutcome {
    if (command !== OPEN_CHAT_COMMAND) return "ignored";
    const windowId = tab?.windowId;
    if (windowId === undefined || windowId < 0) return "ignored";
    const panels = this.panelsOf(windowId);
    const typing = panels.filter(([, p]) => p.inputFocused);
    if (typing.length) {
      for (const [port] of typing) this.post(port, { type: "panel.voice" });
      return "voice";
    }
    if (!panels.length) {
      this.openFocused(windowId, "");
      return "opened";
    }
    if (panels.some(([, p]) => p.focused)) {
      // The focus is in the panel already: open() is a no-op, the panel moves it to the input.
      this.deps.open(windowId).catch((err: unknown) => this.log(`opening the side panel failed: ${String(err)}`));
      for (const [port] of panels) this.post(port, { type: "panel.focus" });
      return "focused";
    }
    // The focus is in the web page: only a newly created panel gets it (see the top of this file).
    const drafts = this.draftsByWindow();
    this.deps.closeAllInstantly().catch((err: unknown) => this.log(`closing the side panels failed: ${String(err)}`));
    this.openFocused(windowId, drafts.get(windowId) ?? "");
    for (const [other, draft] of drafts) if (other !== windowId) this.openFocused(other, draft);
    return "reopened";
  }

  /** Opens the window's panel; when it says hello it takes the focus, with `draft` back in its box. */
  private openFocused(windowId: number, draft: string): void {
    this.opening.set(windowId, draft);
    this.deps.open(windowId).catch((err: unknown) => {
      // Nothing opens, so no hello will consume it.
      this.opening.delete(windowId);
      this.log(`opening the side panel failed: ${String(err)}`);
    });
  }

  /** Each window with a panel -> the text in its box (a non-empty one, when the window has several panel pages). */
  private draftsByWindow(): Map<number, string> {
    const drafts = new Map<number, string>();
    for (const { windowId, draft } of this.panels.values()) {
      if (windowId !== null && !drafts.get(windowId)) drafts.set(windowId, draft);
    }
    return drafts;
  }

  private panelsOf(windowId: number): [PanelPort, PanelInfo][] {
    return [...this.panels].filter(([, p]) => p.windowId === windowId);
  }

  private post(port: PanelPort, msg: unknown): void {
    try {
      port.postMessage(msg);
    } catch {
      this.panels.delete(port);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
