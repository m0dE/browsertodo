const WINDOW_KEY = "agentWindowId";
export const TAB_GROUP_TITLE = "browsertodo";

/**
 * The dedicated window tasks run in. Its ID lives in chrome.storage.session so
 * a restarted service worker finds it again. Other windows are never touched.
 */
export class AgentWindow {
  /** The agent window's active tab, creating the window if needed. */
  async ensureTab(): Promise<number> {
    const existing = await this.existingTab();
    if (existing !== null) {
      await this.label(existing);
      return existing;
    }
    const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1280, height: 900 });
    const tabId = win?.tabs?.[0]?.id;
    if (!win?.id || tabId === undefined) throw new Error("Could not create the agent window");
    await chrome.storage.session.set({ [WINDOW_KEY]: win.id });
    await this.label(tabId);
    return tabId;
  }

  /**
   * Puts the agent tab in a tab group titled "browsertodo" so it is easy to
   * recognize, like Claude's own "Claude" group. Best effort: never blocks a task.
   */
  private async label(tabId: number): Promise<void> {
    try {
      if (!chrome.tabGroups || !chrome.tabs.group) return;
      const tab = await chrome.tabs.get(tabId);
      let groupId = tab.groupId ?? -1;
      if (groupId === -1) groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      const group = await chrome.tabGroups.get(groupId);
      if (group.title !== TAB_GROUP_TITLE) await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: "blue" });
    } catch {
      /* grouping is cosmetic */
    }
  }

  async windowId(): Promise<number | null> {
    const got = await chrome.storage.session.get(WINDOW_KEY);
    const id = got[WINDOW_KEY];
    return typeof id === "number" ? id : null;
  }

  async isAgentTab(tabId: number): Promise<boolean> {
    const windowId = await this.windowId();
    if (windowId === null) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.windowId === windowId;
    } catch {
      return false;
    }
  }

  private async existingTab(): Promise<number | null> {
    const windowId = await this.windowId();
    if (windowId === null) return null;
    try {
      const win = await chrome.windows.get(windowId, { populate: true });
      const tab = win.tabs?.find((t) => t.active) ?? win.tabs?.[0];
      return tab?.id ?? null;
    } catch {
      return null;
    }
  }
}
