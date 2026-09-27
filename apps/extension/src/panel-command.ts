/**
 * The side panels of the tabs (see panel-tabs.ts: each tab has its own) and
 * the keyboard shortcuts (the manifest's "commands", see shortcut.ts).
 * OPEN_CHAT_COMMAND opens the side panel of the tab the key was pressed in
 * and puts the cursor in the chat input; when that tab's panel is already
 * open, it switches it to Chat and focuses the input. VOICE_COMMAND does the
 * same and then starts a hands-free session there (sidepanel/hands-free.ts),
 * as the mic button does; pressed while a panel of the window is listening,
 * it reaches that panel, which ends the session. The panel decides: without
 * a plan that includes voice it points at the locked mic button and says
 * why. A listening panel is never recreated: stopping needs no keyboard
 * focus.
 *
 * Chrome counts a command (and a toolbar click) as a user gesture, which
 * sidePanel.open() needs, but only while the listener runs: open() is called
 * before anything is awaited. The side panels report their tab, window and
 * where the keyboard focus is over the UI port (PanelMessage), so the
 * decision needs no await either. A panel that the shortcut opened is told
 * to focus when it says hello (its ready handshake), not after some delay.
 *
 * Chrome moves the keyboard focus into a side panel only when it creates
 * the panel's page. So when the focus is outside the tab's panel, the
 * shortcut disables the tab's panel (which closes it at once, without the
 * close animation) and opens it again, all within the gesture; the new page
 * is told to focus and gets back the text its box had (the chat itself comes
 * from the background). Other tabs' panels are not touched.
 *
 * A panel the user closes is disabled for its tab: the tab has no panel
 * until it is opened there again (toolbar button or shortcut).
 * chrome.sidePanel.onClosed says so (Chrome 142+); on older Chrome its
 * page's port closing does (Chrome keeps a hidden tab's page, so the port
 * stays while the user is on another tab). A page the shortcut is
 * recreating does not count.
 *
 * Which panel runs the hands-free session (its tab, window and engine) goes
 * to the voice dep (voice-session.ts), which tells every panel and sets the
 * toolbar badges; it ends when the panel stops listening or closes. Stop
 * and Use voice here in another panel reach the panel running it
 * (panel.voiceStop -> voice.stop): one session, one microphone.
 *
 * Extension shortcuts work while a Chrome window has the focus. They are
 * not system-wide: Chrome allows "global" only for Ctrl+Shift+[0-9], and a
 * side panel cannot open without a focused Chrome window anyway.
 */

import type { VoiceEngineId } from "@browsertodo/shared";
import type { PanelTabSet } from "./panel-tabs.js";
import { OPEN_CHAT_COMMAND, VOICE_COMMAND } from "./shortcut.js";
import type { VoiceSessionInfo } from "./voice-session.js";

/** Panel -> background on the UI port. */
export type PanelMessage =
  /** tabId: the tab the panel belongs to (absent: the panel page opened as a tab, which follows its window's active tab). */
  | { type: "panel.hello"; windowId: number; tabId?: number }
  /** Hands-free voice started or stopped listening in the panel; tabId: the tab its session belongs to; engine: the one it runs on; muted: its microphone is muted. */
  | { type: "panel.listening"; listening: boolean; tabId?: number; engine?: VoiceEngineId; muted?: boolean }
  /** End the hands-free session, whichever panel runs it (Stop, or Use voice here, in another tab's panel). */
  | { type: "panel.voiceStop" }
  /** The panel's page got or lost the keyboard focus; `draft`: the text in its box then (a recreated panel gets it back). */
  | { type: "panel.document"; focused: boolean; draft: string };

/** A UI port as this uses it (chrome.runtime.Port). */
export interface PanelPort {
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface PanelCommandDeps {
  /** Enables the tab's panel and opens it (openTabPanel). Called synchronously in the command listener. */
  open(tabId: number): Promise<void>;
  /**
   * Disables the tab's panel, which closes it at once (no close animation):
   * the next open() creates its page anew. Also how a closed panel stays off.
   */
  disable(tabId: number): Promise<void>;
  /** The tabs with an open panel, remembered across service worker restarts. */
  tabs?: PanelTabSet;
  /**
   * Chrome reports closed panels (chrome.sidePanel.onClosed, Chrome 142+, calls panelClosed): a page's port
   * closing is then not taken for one (it also closes when the page reloads).
   */
  reportsClosed?: boolean;
  /** The hands-free session changed: the one the panels run now (null: none). */
  voice?(session: VoiceSessionInfo | null): void;
  log?(message: string): void;
}

export type CommandOutcome = "opened" | "reopened" | "focused" | "voice" | "ignored";

interface PanelInfo {
  windowId: number | null;
  /** The tab the panel belongs to (null: a panel page opened as a tab). */
  tabId: number | null;
  /** Voice input is listening (or starting to). */
  listening: boolean;
  /** The tab its session belongs to. */
  voiceTab: number | null;
  /** The engine its session runs on (null: not chosen yet). */
  engine: VoiceEngineId | null;
  /** Its session's microphone is muted. */
  muted: boolean;
  /** When it started listening (the latest one is the session, should two ever report at once). */
  since: number;
  /** The panel's page has the keyboard focus. */
  focused: boolean;
  /** The text in the box when the page last got or lost the focus. */
  draft: string;
}

type Tab = { id?: number; windowId?: number } | null | undefined;

export class PanelCommands {
  private readonly panels = new Map<PanelPort, PanelInfo>();
  /**
   * Tabs whose panel a shortcut is opening -> the text to put back in its box, and whether to start listening:
   * when it says hello, it is told to focus (and to start voice input).
   */
  private readonly opening = new Map<number, { draft: string; voice: boolean }>();
  /** The session last reported to the voice dep (JSON). */
  private reported = "null";
  private reports = 0;

  constructor(private readonly deps: PanelCommandDeps) {}

  /** A side panel's UI port (after UiHub.attach accepted it). */
  attach(port: PanelPort): void {
    const info: PanelInfo = { windowId: null, tabId: null, listening: false, voiceTab: null, engine: null, muted: false, since: 0, focused: false, draft: "" };
    this.panels.set(port, info);
    port.onDisconnect.addListener(() => {
      this.panels.delete(port);
      this.setVoiceTab(info, null);
      // Chrome keeps a hidden tab's panel page: its port closes only when the panel closes (or its tab does).
      if (!this.deps.reportsClosed && info.tabId !== null && !this.panelsOfTab(info.tabId).length) this.panelClosed(info.tabId);
    });
    port.onMessage.addListener((raw) => {
      const msg = raw as Partial<PanelMessage> | null;
      if (msg?.type === "panel.hello" && typeof msg.windowId === "number") {
        info.windowId = msg.windowId;
        if (typeof msg.tabId === "number") info.tabId = msg.tabId;
        this.reportVoice();
        if (typeof msg.tabId !== "number") return;
        this.deps.tabs?.add(msg.tabId);
        const pending = this.opening.get(msg.tabId);
        if (!pending) return;
        this.opening.delete(msg.tabId);
        this.focus(port, pending.draft, pending.voice);
      } else if (msg?.type === "panel.listening" && typeof msg.listening === "boolean") {
        if (msg.listening && !info.listening) info.since = ++this.reports;
        info.listening = msg.listening;
        info.engine = msg.listening && (msg.engine === "realtime" || msg.engine === "standard") ? msg.engine : null;
        info.muted = msg.listening && msg.muted === true;
        this.setVoiceTab(info, msg.listening && typeof msg.tabId === "number" ? msg.tabId : null);
      } else if (msg?.type === "panel.voiceStop") {
        this.stopVoice();
      } else if (msg?.type === "panel.document" && typeof msg.focused === "boolean") {
        info.focused = msg.focused;
        info.draft = typeof msg.draft === "string" ? msg.draft : "";
      }
    });
  }

  /** The window has an open panel page (it said hello). */
  isOpen(windowId: number): boolean {
    return this.panelsOfWindow(windowId).length > 0;
  }

  /** The tab has its own side panel open (its page said hello, or it did before the service worker restarted). */
  hasPanel(tabId: number): boolean {
    return this.panelsOfTab(tabId).length > 0 || !!this.deps.tabs?.has(tabId);
  }

  /** A panel of the window is listening (the voice shortcut then goes to it, and hands-free ends). */
  listening(windowId: number): boolean {
    return this.panelsOfWindow(windowId).some(([, p]) => p.listening);
  }

  /**
   * chrome.commands.onCommand, with the tab the key was pressed in. Synchronous until sidePanel.open() was
   * called, so Chrome still counts the key press as the user gesture.
   */
  onCommand(command: string, tab?: Tab): CommandOutcome {
    const voice = command === VOICE_COMMAND;
    if (!voice && command !== OPEN_CHAT_COMMAND) return "ignored";
    const windowId = tab?.windowId;
    if (windowId === undefined || windowId < 0) return "ignored";
    const inWindow = this.panelsOfWindow(windowId);
    const listening = inWindow.filter(([, p]) => p.listening);
    if (voice && listening.length) {
      for (const [port] of listening) this.post(port, { type: "panel.voice" });
      return "voice";
    }
    // The focus is in a panel page of the window already (a hidden tab's panel has none): it moves it to the input.
    const focused = inWindow.filter(([, p]) => p.focused);
    if (focused.length) {
      for (const [port] of focused) this.focus(port, "", voice);
      return voice ? "voice" : "focused";
    }
    const tabId = tab?.id;
    if (tabId === undefined || tabId < 0) return "ignored";
    const own = this.panelsOfTab(tabId);
    // No page of its own yet, or none said hello since the worker restarted (open() leaves an open one as it is).
    if (!own.length) {
      this.openFocused(tabId, "", voice);
      return "opened";
    }
    // Listening (so this is open-chat): never recreated, the voice session would end. Chat and the box it gets.
    if (own.some(([, p]) => p.listening)) {
      for (const [port] of own) this.focus(port, "", false);
      return "focused";
    }
    // The focus is in the web page: only a newly created panel page gets it (see the top of this file).
    const draft = own.find(([, p]) => p.draft)?.[1].draft ?? "";
    this.opening.set(tabId, { draft, voice });
    this.deps.disable(tabId).catch((err: unknown) => this.log(`closing the side panel failed: ${String(err)}`));
    this.openFocused(tabId, draft, voice);
    return "reopened";
  }

  /**
   * The toolbar button was clicked in a tab without its own panel (with one, Chrome opens or closes it itself:
   * openPanelOnActionClick). Synchronous, like onCommand.
   */
  onAction(tab?: Tab): void {
    const tabId = tab?.id;
    if (tabId === undefined || tabId < 0) return;
    this.deps.open(tabId).catch((err: unknown) => this.log(`opening the side panel failed: ${String(err)}`));
  }

  /**
   * The tab's panel closed (its page's port, or chrome.sidePanel.onClosed): it stays off for the tab until opened
   * there again. Not while the shortcut recreates it.
   */
  panelClosed(tabId: number): void {
    if (this.opening.has(tabId)) return;
    this.deps.tabs?.delete(tabId);
    this.deps.disable(tabId).catch(() => {
      // The tab is closing too: nothing to disable.
    });
  }

  /** The tab closed (chrome.tabs.onRemoved): its panel is gone with it. */
  tabRemoved(tabId: number): void {
    this.opening.delete(tabId);
    this.deps.tabs?.delete(tabId);
  }

  /** The hands-free session the panels run now: the panel that started listening last (null: none). */
  voiceSession(): VoiceSessionInfo | null {
    let latest: PanelInfo | null = null;
    for (const p of this.panels.values()) if (p.voiceTab !== null && (!latest || p.since > latest.since)) latest = p;
    if (!latest || latest.voiceTab === null) return null;
    return { tabId: latest.voiceTab, windowId: latest.windowId, host: latest.tabId, engine: latest.engine, ...(latest.muted ? { muted: true as const } : {}) };
  }

  /** The panel's session is now in `tab` (null: none). */
  private setVoiceTab(info: PanelInfo, tab: number | null): void {
    info.voiceTab = tab;
    this.reportVoice();
  }

  /** Tells the voice dep when the session changed. */
  private reportVoice(): void {
    const session = this.voiceSession();
    const json = JSON.stringify(session);
    if (json === this.reported) return;
    this.reported = json;
    this.deps.voice?.(session);
  }

  /**
   * Ends the session wherever it runs (the panels that listen are told to stop, and report it). None listens: a
   * session the voice dep still has (kept across a worker restart) is over.
   */
  private stopVoice(): void {
    const listening = [...this.panels].filter(([, p]) => p.listening);
    for (const [port] of listening) this.post(port, { type: "voice.stop" });
    if (!listening.length) {
      this.reported = "null";
      this.deps.voice?.(null);
    }
  }

  /** Tells a panel to put the cursor in its box (with `draft` back in it), then to start listening. */
  private focus(port: PanelPort, draft: string, voice: boolean): void {
    this.post(port, draft ? { type: "panel.focus", draft } : { type: "panel.focus" });
    if (voice) this.post(port, { type: "panel.voice" });
  }

  /** Opens the tab's panel; when it says hello it takes the focus, with `draft` back in its box (and listens). */
  private openFocused(tabId: number, draft: string, voice: boolean): void {
    this.opening.set(tabId, { draft, voice });
    this.deps.tabs?.add(tabId);
    this.deps.open(tabId).catch((err: unknown) => {
      // Nothing opens, so no hello will consume it.
      this.opening.delete(tabId);
      this.log(`opening the side panel failed: ${String(err)}`);
    });
  }

  private panelsOfWindow(windowId: number): [PanelPort, PanelInfo][] {
    return [...this.panels].filter(([, p]) => p.windowId === windowId);
  }

  private panelsOfTab(tabId: number): [PanelPort, PanelInfo][] {
    return [...this.panels].filter(([, p]) => p.tabId === tabId);
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
