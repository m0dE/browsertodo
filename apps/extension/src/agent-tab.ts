import { MAX_AGENT_TABS } from "@browsertodo/shared";

const TAB_KEY = "agentTabId";
/** The run's tabs (main + opened by open_tabs) and which one is current. */
const TABS_KEY = "agentTabs";
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

/** One tab of the run: short id ("t1", "t2", ...), Chrome tab id, and whether the agent opened it. */
export interface RunTab {
  id: string;
  tabId: number;
  /** True for tabs opened by open_tabs; they are closed when the run ends. */
  opened: boolean;
}

interface TabsState {
  /** Chrome id of the current tab (the one single-tab browser methods act on). */
  current: number;
  /** tabs[0] is the run's main tab (from prepare()). */
  tabs: RunTab[];
  next: number;
}

/**
 * The tabs the agent acts in, inside the user's own browser window: the run's
 * main tab (picked by prepare()) plus tabs it opened with open_tabs, one of
 * them current. The state lives in chrome.storage.session so a restarted
 * service worker finds it again. Every agent tab is put in a tab group titled
 * "browsertodo".
 */
export class AgentTab {
  /**
   * Picks the main tab for a run and makes it the current tab. The driver
   * keeps using the current tab until the next prepare() or switch, even if
   * the user switches tabs. Tabs an earlier run opened and left open are closed.
   */
  async prepare(mode: TabMode): Promise<number> {
    const tabId = mode === "current-tab" ? await this.pickCurrentTab() : await this.pickOwnTab();
    const previous = await this.state();
    await removeTabs((previous?.tabs ?? []).filter((t) => t.opened && t.tabId !== tabId).map((t) => t.tabId));
    const state: TabsState = { current: tabId, tabs: [{ id: "t1", tabId, opened: false }], next: 2 };
    await chrome.storage.session.set({ [TAB_KEY]: tabId, [TABS_KEY]: state });
    await this.label(tabId);
    return tabId;
  }

  /**
   * The current tab for the next browser call. Opens one (own-tab) when there
   * is none yet. If the main tab was closed, fails once with a readable error
   * and forgets it, so a later call can start afresh. If the current tab was
   * one the agent opened and it was closed, fails once and falls back to the
   * main tab.
   */
  async ensureTab(): Promise<number> {
    const state = await this.state();
    if (state === null) return this.prepare("own-tab");
    if (await tabExists(state.current)) return state.current;
    const main = state.tabs[0]!;
    const gone = state.tabs.find((t) => t.tabId === state.current);
    if (!gone || gone === main || !(await tabExists(main.tabId))) {
      await chrome.storage.session.remove([TAB_KEY, TABS_KEY]);
      throw new Error(AGENT_TAB_CLOSED);
    }
    await this.save({ ...state, current: main.tabId, tabs: state.tabs.filter((t) => t !== gone) });
    throw new Error(`tab ${gone.id} was closed; the current tab is now ${main.id}`);
  }

  /** Chrome id of a run tab by short id ("t2"). Throws a readable error for unknown or closed tabs. */
  async resolve(id: string): Promise<number> {
    const state = await this.state();
    const key = normalizeId(id);
    const tab = state?.tabs.find((t) => t.id === key);
    if (!state || !tab) throw new Error(`unknown tab "${id}"; call list_tabs`);
    if (await tabExists(tab.tabId)) return tab.tabId;
    if (tab.opened) await this.save({ ...state, tabs: state.tabs.filter((t) => t !== tab) });
    throw new Error(`tab ${tab.id} was closed`);
  }

  /** The run's tabs that still exist, main first, with which one is current. */
  async list(): Promise<(RunTab & { current: boolean })[]> {
    const state = await this.state();
    if (!state) return [];
    const main = state.tabs[0]!;
    const alive: RunTab[] = [];
    for (const t of state.tabs) if (await tabExists(t.tabId)) alive.push(t);
    const opened = alive.filter((t) => t !== main);
    if (opened.length !== state.tabs.length - 1) await this.save({ ...state, tabs: [main, ...opened] });
    return alive.map((t) => ({ ...t, current: t.tabId === state.current }));
  }

  /** Chrome ids of every tab of the run (main and opened). */
  async tabIds(): Promise<number[]> {
    return (await this.state())?.tabs.map((t) => t.tabId) ?? [];
  }

  /** The short id of a Chrome tab of the run, or null. */
  async shortId(tabId: number): Promise<string | null> {
    return (await this.state())?.tabs.find((t) => t.tabId === tabId)?.id ?? null;
  }

  /**
   * Opens each URL in a new background tab of the main tab's window, right
   * after the run's tabs, in the browsertodo group. Returns them in order.
   * active: show the first one and make it current. Does not wait for loads.
   */
  async open(urls: string[], opts: { active?: boolean } = {}): Promise<RunTab[]> {
    await this.ensureTab();
    const alive = await this.list();
    if (alive.length + urls.length > MAX_AGENT_TABS) {
      throw new Error(`too many tabs: ${alive.length} open, at most ${MAX_AGENT_TABS} in total; close tabs you no longer need (close_tabs)`);
    }
    const state = (await this.state())!;
    const main = await chrome.tabs.get(state.tabs[0]!.tabId);
    let index = main.index;
    for (const t of alive) {
      const tab = await chrome.tabs.get(t.tabId).catch(() => null);
      if (tab && tab.windowId === main.windowId) index = Math.max(index, tab.index);
    }
    const created: RunTab[] = [];
    try {
      for (const url of urls) {
        const tab = await chrome.tabs.create({ windowId: main.windowId, index: ++index, active: false, url });
        created.push({ id: `t${state.next++}`, tabId: mustId(tab), opened: true });
      }
    } finally {
      // Remember what was created even if a later create failed, so it is cleaned up.
      state.tabs.push(...created);
      if (opts.active && created[0]) state.current = created[0].tabId;
      await this.save(state);
    }
    await this.label(created.map((t) => t.tabId));
    if (opts.active && created[0]) await chrome.tabs.update(created[0].tabId, { active: true }).catch(() => undefined);
    return created;
  }

  /** Makes a run tab current. Returns its Chrome id. */
  async setCurrent(id: string): Promise<number> {
    const tabId = await this.resolve(id);
    const state = (await this.state())!;
    await this.save({ ...state, current: tabId });
    return tabId;
  }

  /**
   * Closes tabs the agent opened. The main tab is never closed; an unknown id
   * or the main tab fails before anything is closed. If the current tab is
   * closed, the main tab becomes current. Returns the closed short ids.
   */
  async close(ids: string[]): Promise<string[]> {
    const state = await this.state();
    if (!state) throw new Error("there are no agent tabs");
    const targets: RunTab[] = [];
    for (const id of new Set(ids.map(normalizeId))) {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`unknown tab "${id}"; call list_tabs`);
      if (!tab.opened) throw new Error(`${tab.id} is the tab the task started on; it is never closed`);
      targets.push(tab);
    }
    await removeTabs(targets.map((t) => t.tabId));
    const tabs = state.tabs.filter((t) => !targets.includes(t));
    const current = tabs.some((t) => t.tabId === state.current) ? state.current : tabs[0]!.tabId;
    await this.save({ ...state, tabs, current });
    return targets.map((t) => t.id);
  }

  /** Closes every tab the agent opened in this run; the main tab becomes current again. Returns how many were closed. */
  async closeOpened(): Promise<number> {
    const state = await this.state();
    if (!state) return 0;
    const opened = state.tabs.filter((t) => t.opened);
    if (!opened.length) return 0;
    await removeTabs(opened.map((t) => t.tabId));
    const main = state.tabs[0]!;
    await this.save({ ...state, tabs: [main], current: main.tabId });
    return opened.length;
  }

  /** Brings the current agent tab's window to the front and activates the tab. */
  async show(): Promise<boolean> {
    const tabId = await this.tabId();
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

  /** The window the main agent tab is in, or null when there is no agent tab. */
  async windowId(): Promise<number | null> {
    const tabId = await this.storedTabId();
    if (tabId === null) return null;
    try {
      return (await chrome.tabs.get(tabId)).windowId;
    } catch {
      return null;
    }
  }

  /** The current agent tab (the one the driver acts on), or null. */
  async tabId(): Promise<number | null> {
    return (await this.state())?.current ?? null;
  }

  /** True for the run's main tab and every tab the agent opened. */
  async isAgentTab(tabId: number): Promise<boolean> {
    return (await this.tabIds()).includes(tabId);
  }

  /** The main tab (picked by prepare()). */
  private async storedTabId(): Promise<number | null> {
    const got = await chrome.storage.session.get(TAB_KEY);
    const id = got[TAB_KEY];
    return typeof id === "number" ? id : null;
  }

  /** The run's tab state; derived from the main tab when missing or stale (e.g. set by an older worker). */
  private async state(): Promise<TabsState | null> {
    const got = await chrome.storage.session.get([TAB_KEY, TABS_KEY]);
    const main = got[TAB_KEY];
    if (typeof main !== "number") return null;
    const s = got[TABS_KEY] as TabsState | undefined;
    if (!s || !Array.isArray(s.tabs) || s.tabs[0]?.tabId !== main || typeof s.current !== "number") {
      return { current: main, tabs: [{ id: "t1", tabId: main, opened: false }], next: 2 };
    }
    return s;
  }

  private async save(state: TabsState): Promise<void> {
    await chrome.storage.session.set({ [TABS_KEY]: state });
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
   * Puts the tabs (all in one window) in the window's "browsertodo" tab group
   * (creating it if needed), like Claude's own "Claude" group. Best effort:
   * never blocks a task.
   */
  private async label(tabIds: number | number[]): Promise<void> {
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
}

/** "T2", " t2 " and "2" all mean t2. */
function normalizeId(id: string): string {
  const s = id.trim().toLowerCase();
  return /^\d+$/.test(s) ? `t${s}` : s;
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Closes tabs, ignoring ones that are already gone. */
async function removeTabs(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map((id) => chrome.tabs.remove(id).catch(() => undefined)));
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
