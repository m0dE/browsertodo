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
 * awaited. The side panels report their window and whether their input has
 * the focus over the UI port (PanelMessage), so the decision needs no await
 * either. A panel that the shortcut opened is told to focus when it says
 * hello (its ready handshake), not after some delay.
 *
 * Extension shortcuts work while a Chrome window has the focus. They are
 * not system-wide: Chrome allows "global" only for Ctrl+Shift+[0-9], and a
 * side panel cannot open without a focused Chrome window anyway.
 */

import { OPEN_CHAT_COMMAND } from "./shortcut.js";

/** Panel -> background on the UI port. */
export type PanelMessage =
  | { type: "panel.hello"; windowId: number }
  | { type: "panel.input"; focused: boolean };

/** A UI port as this uses it (chrome.runtime.Port). */
export interface PanelPort {
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface PanelCommandDeps {
  /** chrome.sidePanel.open({ windowId }). Called synchronously in the command listener. */
  open(windowId: number): Promise<void>;
  log?(message: string): void;
}

export type CommandOutcome = "opened" | "focused" | "voice" | "ignored";

interface PanelInfo {
  windowId: number | null;
  inputFocused: boolean;
}

export class PanelCommands {
  private readonly panels = new Map<PanelPort, PanelInfo>();
  /** Windows whose panel the shortcut is opening: focus it when it says hello. */
  private readonly opening = new Set<number>();

  constructor(private readonly deps: PanelCommandDeps) {}

  /** A side panel's UI port (after UiHub.attach accepted it). */
  attach(port: PanelPort): void {
    const info: PanelInfo = { windowId: null, inputFocused: false };
    this.panels.set(port, info);
    port.onDisconnect.addListener(() => this.panels.delete(port));
    port.onMessage.addListener((raw) => {
      const msg = raw as Partial<PanelMessage> | null;
      if (msg?.type === "panel.hello" && typeof msg.windowId === "number") {
        info.windowId = msg.windowId;
        if (this.opening.delete(msg.windowId)) this.post(port, { type: "panel.focus" });
      } else if (msg?.type === "panel.input" && typeof msg.focused === "boolean") {
        info.inputFocused = msg.focused;
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
    if (panels.length) {
      // Already open: open() is a no-op, the panel just takes the focus.
      this.deps.open(windowId).catch((err: unknown) => this.log(`opening the side panel failed: ${String(err)}`));
      for (const [port] of panels) this.post(port, { type: "panel.focus" });
      return "focused";
    }
    this.opening.add(windowId);
    this.deps.open(windowId).catch((err: unknown) => {
      // Nothing opens, so no hello will consume it.
      this.opening.delete(windowId);
      this.log(`opening the side panel failed: ${String(err)}`);
    });
    return "opened";
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
