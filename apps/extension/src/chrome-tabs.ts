/** Small chrome.tabs / chrome.windows helpers for the agent's tabs. */

export const TAB_GROUP_TITLE = "BrowserTODO";

/** Older versions titled the group "browsertodo"; those groups are still the agent's. */
function isAgentGroupTitle(title: string | undefined): boolean {
  return title === TAB_GROUP_TITLE || title === "browsertodo";
}

/**
 * Puts the tabs (all in one window) in the window's "BrowserTODO" tab group
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
    const existing = (await chrome.tabGroups.query({ windowId: tab.windowId })).find((g) => isAgentGroupTitle(g.title));
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: ids });
      if (existing.title !== TAB_GROUP_TITLE) await chrome.tabGroups.update(existing.id, { title: TAB_GROUP_TITLE });
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

/**
 * Closes the agent's tabs the user has not taken over: a tab the user is
 * looking at (active in its window) or moved out of the BrowserTODO group
 * is theirs now and stays. Returns how many were closed.
 */
export async function removeAgentTabs(tabIds: number[]): Promise<number> {
  const left: number[] = [];
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && !tab.active && (await inAgentGroup(tab))) left.push(id);
  }
  await removeTabs(left);
  return left.length;
}

/** In the BrowserTODO group (always true where Chrome has no tab groups). */
async function inAgentGroup(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!chrome.tabGroups) return true;
  const groupId = tab.groupId ?? -1;
  if (groupId === -1) return false;
  return isAgentGroupTitle((await chrome.tabGroups.get(groupId).catch(() => null))?.title);
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
