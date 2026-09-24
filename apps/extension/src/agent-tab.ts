const TAB_KEY = "agentTabId";
export const TAB_GROUP_TITLE = "browsertodo";

/**
 * current-tab: act on the tab the user is looking at (one-off runs).
 * own-tab: reuse the agent tab from earlier in this browser session, or open one (scheduled runs).
 */
export type TabMode = "current-tab" | "own-tab";

export const AGENT_TAB_CLOSED = "the agent tab was closed";

/** URLs the debugger cannot attach to (browser pages, other extensions, the Web Store). */
export function isControllableUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url === "about:blank") return true;
  if (/^(chrome|chrome-extension|chrome-untrusted|edge|brave|opera|vivaldi|devtools|view-source|about|data|file):/i.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.hostname === "chromewebstore.google.com") return false;
    if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The tab the agent acts in, inside the user's own browser window. Its ID lives
 * in chrome.storage.session so a restarted service worker finds it again. Every
 * agent tab is put in a tab group titled "browsertodo".
 */
export class AgentTab {
  /**
   * Picks the tab for a run and remembers it. The driver keeps using this tab
   * for every browser call until the next prepare(), even if the user switches tabs.
   */
  async prepare(mode: TabMode): Promise<number> {
    const tabId = mode === "current-tab" ? await this.pickCurrentTab() : await this.pickOwnTab();
    await chrome.storage.session.set({ [TAB_KEY]: tabId });
    await this.label(tabId);
    return tabId;
  }

  /**
   * The agent tab for the next browser call. Opens one (own-tab) when there is
   * none yet. If the remembered tab was closed, fails once with a readable
   * error and forgets it, so a later call can start afresh.
   */
  async ensureTab(): Promise<number> {
    const stored = await this.storedTabId();
    if (stored === null) return this.prepare("own-tab");
    if (await tabExists(stored)) return stored;
    await chrome.storage.session.remove(TAB_KEY);
    throw new Error(AGENT_TAB_CLOSED);
  }

  /** Brings the agent tab's window to the front and activates the tab. */
  async show(): Promise<boolean> {
    const tabId = await this.storedTabId();
    if (tabId === null) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(tab.windowId, win.state === "minimized" ? { focused: true, state: "normal" } : { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      return true;
    } catch {
      return false;
    }
  }

  /** The window the agent tab is in, or null when there is no agent tab. */
  async windowId(): Promise<number | null> {
    const tabId = await this.storedTabId();
    if (tabId === null) return null;
    try {
      return (await chrome.tabs.get(tabId)).windowId;
    } catch {
      return null;
    }
  }

  async tabId(): Promise<number | null> {
    return this.storedTabId();
  }

  async isAgentTab(tabId: number): Promise<boolean> {
    return (await this.storedTabId()) === tabId;
  }

  private async storedTabId(): Promise<number | null> {
    const got = await chrome.storage.session.get(TAB_KEY);
    const id = got[TAB_KEY];
    return typeof id === "number" ? id : null;
  }

  private async pickCurrentTab(): Promise<number> {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
    if (!tab) {
      const win = await lastNormalWindow();
      if (!win) return createWindowTab();
      [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    }
    if (tab?.id === undefined) return createWindowTab();
    if (isControllableUrl(tab.url ?? tab.pendingUrl)) return tab.id;
    const created = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true, url: "about:blank" });
    return mustId(created);
  }

  private async pickOwnTab(): Promise<number> {
    const stored = await this.storedTabId();
    if (stored !== null && (await tabExists(stored))) return stored;
    const win = await lastNormalWindow();
    if (!win?.id) return createWindowTab();
    const created = await chrome.tabs.create({ windowId: win.id, active: true, url: "about:blank" });
    return mustId(created);
  }

  /**
   * Puts the tab in the window's "browsertodo" tab group (creating it if
   * needed), like Claude's own "Claude" group. Best effort: never blocks a task.
   */
  private async label(tabId: number): Promise<void> {
    try {
      if (!chrome.tabGroups || !chrome.tabs.group) return;
      const tab = await chrome.tabs.get(tabId);
      const current = tab.groupId ?? -1;
      if (current !== -1 && (await chrome.tabGroups.get(current)).title === TAB_GROUP_TITLE) return;
      const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: TAB_GROUP_TITLE });
      if (existing) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
        return;
      }
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: "blue" });
    } catch {
      /* grouping is cosmetic */
    }
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function lastNormalWindow(): Promise<chrome.windows.Window | null> {
  try {
    return await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    return null;
  }
}

async function createWindowTab(): Promise<number> {
  const win = await chrome.windows.create({ url: "about:blank", focused: true, type: "normal" });
  const tabId = win?.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error("Could not open a browser window for the agent");
  return tabId;
}

function mustId(tab: chrome.tabs.Tab | undefined): number {
  if (tab?.id === undefined) throw new Error("Could not open a tab for the agent");
  return tab.id;
}
