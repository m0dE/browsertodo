/**
 * The side panel is per browser tab: it opens for the tab it was opened in
 * and shows only there. Chrome hides it when another tab is shown and shows
 * it again (the same page, state and all) when that tab is back. There is no
 * window-wide panel: the manifest names no default page and the default
 * options are disabled, so a tab without its own options has no panel.
 *
 * A tab's panel page is sidepanel.html?tab=<id>, so the page knows its tab
 * before anything is awaited. Opening it (setOptions for the tab, then
 * open) must happen inside a user gesture: both calls go out synchronously,
 * in order, and Chrome applies them in that order.
 */
import { errorMessage } from "@browsertodo/shared";
import { tabExists } from "./chrome-tabs.js";

const PANEL_PAGE = "sidepanel.html";
const TAB_PARAM = "tab";
const KEY = "panelTabs";

/** The panel page of a tab. */
export function panelPath(tabId: number): string {
  return `${PANEL_PAGE}?${TAB_PARAM}=${tabId}`;
}

/** The tab a panel page belongs to, from its location.search (null: the page is not a tab's panel, e.g. opened as a tab). */
export function panelTabOf(search: string): number | null {
  const raw = new URLSearchParams(search).get(TAB_PARAM);
  const tabId = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

/** Enables the tab's own panel and opens it. Call it synchronously in a user gesture (open() needs one). */
export function openTabPanel(tabId: number): Promise<void> {
  const enabled = chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([enabled, opened]).then(() => undefined);
}

/** What PanelCommands needs of the remembered tabs. */
export interface PanelTabSet {
  has(tabId: number): boolean;
  add(tabId: number): void;
  delete(tabId: number): void;
}

/**
 * The tabs whose panel is open, kept in chrome.storage.session so a
 * restarted service worker knows them before their pages say hello again;
 * gone when the browser restarts, like the tabs and Chrome's per-tab panel
 * options. Synchronous to read (the key press handler cannot await); tabs
 * closed while the worker was not running are dropped when it loads.
 */
export class StoredPanelTabs implements PanelTabSet {
  private readonly tabs = new Set<number>();
  /** Deleted before the stored tabs were read: not taken back from storage. */
  private readonly deletedEarly = new Set<number>();
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(private readonly opts: { exists?(tabId: number): Promise<boolean>; log?(message: string): void } = {}) {
    this.ready = this.load().catch((err: unknown) => {
      this.loaded = true;
      this.log(`reading the tabs with a side panel failed: ${errorMessage(err)}`);
    });
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  add(tabId: number): void {
    this.deletedEarly.delete(tabId);
    if (this.tabs.has(tabId)) return;
    this.tabs.add(tabId);
    this.save();
  }

  delete(tabId: number): void {
    if (!this.loaded) this.deletedEarly.add(tabId);
    if (this.tabs.delete(tabId)) this.save();
  }

  private async load(): Promise<void> {
    const got = await chrome.storage.session.get(KEY);
    const stored = Array.isArray(got[KEY]) ? (got[KEY] as unknown[]) : [];
    const exists = this.opts.exists ?? tabExists;
    for (const t of stored) {
      if (typeof t === "number" && Number.isInteger(t) && !this.deletedEarly.has(t) && (await exists(t))) this.tabs.add(t);
    }
    this.loaded = true;
    this.deletedEarly.clear();
    this.save();
  }

  /** Written once the stored tabs were read (an earlier write would drop them). */
  private save(): void {
    if (!this.loaded) return;
    chrome.storage.session.set({ [KEY]: [...this.tabs] }).catch((err: unknown) => this.log(`saving the tabs with a side panel failed: ${errorMessage(err)}`));
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}
