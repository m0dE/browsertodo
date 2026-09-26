/**
 * The keyboard shortcuts (the manifest's "commands", see shortcut.ts).
 * OPEN_CHAT_COMMAND opens the side panel of the window and puts the cursor
 * in the chat input; when the panel is already open, it switches it to Chat
 * and focuses the input. VOICE_COMMAND does the same and then starts a
 * hands-free session there (sidepanel/hands-free.ts); pressed while the
 * panel is listening (hands-free, or a dictation from the mic button), it
 * reaches that panel, which ends the session (or stops and sends the
 * dictation). The panel decides: without a plan that includes voice it
 * points at the locked mic button and says why. A listening panel is
 * never recreated: stopping needs no keyboard focus.
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

import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "./shortcut.js";

/** Panel -> background on the UI port. */
export type PanelMessage =
  | { type: "panel.hello"; windowId: number }
  /** Voice input started or stopped listening in the panel. */
  | { type: "panel.listening"; listening: boolean }
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
  /** Voice input is listening (or starting to). */
  listening: boolean;
  /** The panel's page has the keyboard focus. */
  focused: boolean;
  /** The text in the box when the page last got or lost the focus. */
  draft: string;
}

export class PanelCommands {
  private readonly panels = new Map<PanelPort, PanelInfo>();
  /**
   * Windows whose panel a shortcut is opening -> the text to put back in its box, and whether to start
   * listening: when it says hello, it is told to focus (and to start voice input).
   */
  private readonly opening = new Map<number, { draft: string; voice: boolean }>();

  constructor(private readonly deps: PanelCommandDeps) {}

  /** A side panel's UI port (after UiHub.attach accepted it). */
  attach(port: PanelPort): void {
    const info: PanelInfo = { windowId: null, listening: false, focused: false, draft: "" };
    this.panels.set(port, info);
    port.onDisconnect.addListener(() => this.panels.delete(port));
    port.onMessage.addListener((raw) => {
      const msg = raw as Partial<PanelMessage> | null;
      if (msg?.type === "panel.hello" && typeof msg.windowId === "number") {
        info.windowId = msg.windowId;
        const pending = this.opening.get(msg.windowId);
        if (!pending) return;
        this.opening.delete(msg.windowId);
        this.focus(port, pending.draft, pending.voice);
      } else if (msg?.type === "panel.listening" && typeof msg.listening === "boolean") {
        info.listening = msg.listening;
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

  /** The window's side panel is listening (the voice shortcut then goes to it: hands-free ends, a dictation is sent). */
  listening(windowId: number): boolean {
    return this.panelsOf(windowId).some(([, p]) => p.listening);
  }

  /**
   * chrome.commands.onCommand. Synchronous until sidePanel.open() was
   * called, so Chrome still counts the key press as the user gesture.
   */
  onCommand(command: string, tab?: { windowId?: number } | null): CommandOutcome {
    const voice = command === VOICE_COMMAND;
    if (!voice && command !== OPEN_CHAT_COMMAND) return "ignored";
    const windowId = tab?.windowId;
    if (windowId === undefined || windowId < 0) return "ignored";
    const panels = this.panelsOf(windowId);
    const listening = panels.filter(([, p]) => p.listening);
    if (voice && listening.length) {
      for (const [port] of listening) this.post(port, { type: "panel.voice" });
      return "voice";
    }
    if (!panels.length) {
      this.openFocused(windowId, "", voice);
      return "opened";
    }
    if (panels.some(([, p]) => p.focused)) {
      // The focus is in the panel already: open() is a no-op, the panel moves it to the input.
      this.deps.open(windowId).catch((err: unknown) => this.log(`opening the side panel failed: ${String(err)}`));
      // Voice starts in the panel that has the focus only (a window may have its panel page open in a tab too).
      for (const [port, p] of panels) this.focus(port, "", voice && p.focused);
      return voice ? "voice" : "focused";
    }
    // The focus is in the web page: only a newly created panel gets it (see the top of this file).
    const drafts = this.draftsByWindow();
    this.deps.closeAllInstantly().catch((err: unknown) => this.log(`closing the side panels failed: ${String(err)}`));
    this.openFocused(windowId, drafts.get(windowId) ?? "", voice);
    for (const [other, draft] of drafts) if (other !== windowId) this.openFocused(other, draft, false);
    return "reopened";
  }

  /** Tells a panel to put the cursor in its box (with `draft` back in it), then to start listening. */
  private focus(port: PanelPort, draft: string, voice: boolean): void {
    this.post(port, draft ? { type: "panel.focus", draft } : { type: "panel.focus" });
    if (voice) this.post(port, { type: "panel.voice" });
  }

  /** Opens the window's panel; when it says hello it takes the focus, with `draft` back in its box (and listens). */
  private openFocused(windowId: number, draft: string, voice: boolean): void {
    this.opening.set(windowId, { draft, voice });
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
