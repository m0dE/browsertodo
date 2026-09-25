/** Small chrome.tabs / chrome.windows helpers for the agent's tabs. */

export const TAB_GROUP_TITLE = "browsertodo";

/**
 * Puts the tabs (all in one window) in the window's "browsertodo" tab group
 * (creating it if needed), like Claude's own "Claude" group. Best effort:
 * never blocks a task.
 */
export async function addToGroup(tabIds: number | number[]): Promise<void> {
  try {
    if (!chrome.tabGroups || !chrome.tabs.group) return;
    const list = Array.isArray(tabIds) ? tabIds : [tabIds];
    if (!list.length) return;
    const ids = list as [number, ...number[]];
    const tab = await chrome.tabs.get(ids[0]);
    const current = tab.groupId ?? -1;
    if (ids.length === 1 && current !== -1 && (await chrome.tabGroups.get(current)).title === TAB_GROUP_TITLE) return;
    const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: TAB_GROUP_TITLE });
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: ids });
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: "blue" });
  } catch {
    /* grouping is cosmetic */
  }
}

export async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Closes tabs, ignoring ones that are already gone. */
export async function removeTabs(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map((id) => chrome.tabs.remove(id).catch(() => undefined)));
}

export async function lastNormalWindow(): Promise<chrome.windows.Window | null> {
  try {
    return await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch {
    return null;
  }
}

/** A new window with a blank tab; focused: false for runs the user did not just start. */
export async function createWindowTab(focused = true): Promise<number> {
  const win = await chrome.windows.create({ url: "about:blank", focused, type: "normal" });
  const tabId = win?.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error("Could not open a browser window for the agent");
  return tabId;
}

/** The tab finished loading (nothing pending). */
export function isTabLoaded(tab: Pick<chrome.tabs.Tab, "status" | "pendingUrl">): boolean {
  return tab.status === "complete" && !tab.pendingUrl;
}

/** The address a tab shows, or the one it is loading ("" when neither is known). */
export function tabUrl(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl">): string {
  return tab.url || tab.pendingUrl || "";
}

export function mustId(tab: chrome.tabs.Tab | undefined): number {
  if (tab?.id === undefined) throw new Error("Could not open a tab for the agent");
  return tab.id;
}
