import { delay, type AgentTabInfo, type PageSnapshot, type Screenshot, type Sleep } from "@browsertodo/shared";
import type { AgentTab } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { CdpActions } from "./cdp-actions.js";
import { isTabLoaded, tabUrl } from "./chrome-tabs.js";
import { assertOpenable, BACKGROUND_SHOT_SKIPPED, NAV_TIMEOUT_MS, pollUntil, type Params as P, type Result as R } from "./driver-common.js";
import { FALLBACK_NOTE, FallbackDriver } from "./fallback-driver.js";
import { keyEvents } from "./keys.js";
import { isDebuggerBlocked, isRestrictedError, restrictedToolError } from "./restricted.js";

/** A result that may carry FALLBACK_NOTE, once, for the caller to show. */
export type WithNote<T> = T & { note?: string };

/**
 * How long a screenshot of a background tab may take. In Chromium 153 (headed,
 * also without Playwright's anti-backgrounding flags) Page.captureScreenshot
 * of a background tab, a tab never shown, or a tab of a minimized or unfocused
 * window returns the real, current page in ~100 ms; this only guards against a
 * browser that never paints hidden tabs.
 */
const BACKGROUND_SHOT_TIMEOUT_MS = 10_000;

/**
 * Implements the browser.* methods on the agent's tabs through the debugger.
 * The single-tab methods act on the current tab (see AgentTab); readPage can
 * also read any other tab of the run without activating it, and several tabs
 * can be attached at once. openTabs/switchTab/listTabs/closeTabs manage the
 * run's tabs.
 *
 * Chrome refuses chrome.debugger for a whole tab once it contains a frame of
 * another extension (e.g. Streak inside Gmail): attach and every command fail
 * with "Cannot access a chrome-extension:// URL of different extension", and a
 * live session is detached ("target_closed") when such a frame appears. That
 * tab then switches to FallbackDriver (chrome.scripting + captureVisibleTab,
 * simulated input); other tabs of the run keep using the debugger. The first
 * result in fallback mode for a tab carries `note: FALLBACK_NOTE`. After a
 * navigation the debugger is tried again.
 */
export class Driver {
  private readonly sleep: Sleep;
  private readonly viaCdp: CdpActions;
  private readonly fallback: FallbackDriver;
  /** Every agent tab of every slot (drivers share the debugger): a driver only detaches tabs no slot uses. */
  private readonly knownTabs: () => Promise<number[]>;
  /** Tabs driven without the debugger. */
  private readonly fallbackTabs = new Set<number>();
  /** Tabs whose fallback note was already handed out (or is pending). */
  private readonly noted = new Set<number>();
  /** Tabs whose next result carries the fallback note. */
  private readonly pendingNotes = new Set<number>();
  /** The current tab as of the last ready(). */
  private lastTab: number | null = null;

  constructor(
    private readonly cdp: Cdp,
    private readonly agent: AgentTab,
    opts: { sleep?: Sleep; fallback?: FallbackDriver; knownTabs?: () => Promise<number[]> } = {},
  ) {
    this.sleep = opts.sleep ?? delay;
    this.viaCdp = new CdpActions(cdp, this.sleep);
    this.fallback = opts.fallback ?? new FallbackDriver({ sleep: this.sleep });
    this.knownTabs = opts.knownTabs ?? (() => this.agent.tabIds());
  }

  /** True when the current agent tab is driven without the debugger. */
  get inFallback(): boolean {
    return this.lastTab !== null && this.fallbackTabs.has(this.lastTab);
  }

  /**
   * Ensure the current agent tab exists and the debugger is attached to it, or
   * that the tab is in fallback mode because Chrome refuses the debugger there.
   * Detaches from tabs that are no longer part of the run.
   */
  async ready(): Promise<number> {
    const tabId = await this.agent.ensureTab();
    this.lastTab = tabId;
    await this.forgetStrays();
    await this.attachOrFallback(tabId, true);
    return tabId;
  }

  async navigate({ url }: P<"browser.navigate">): Promise<WithNote<R<"browser.navigate">>> {
    assertOpenable(url);
    let started = false;
    return this.use(
      (tabId) => this.viaCdp.navigate(tabId, url, () => (started = true)),
      async (tabId) => {
        // If Page.navigate went through before the debugger was refused, only wait for the load.
        const r = started ? await this.fallback.waitForLoad(tabId, url) : await this.fallback.navigate(tabId, { url });
        // The new page may not contain the other extension's frame: try the debugger again next call.
        this.fallbackTabs.delete(tabId);
        return r;
      },
    );
  }

  /** Snapshot of the current tab, or of `tab` (a short id) without activating it or making it current. */
  async readPage(p: P<"browser.readPage"> = {}): Promise<WithNote<PageSnapshot>> {
    const target = p.tab === undefined ? undefined : await this.agent.resolve(p.tab);
    const r = await this.use(
      (tabId) => this.viaCdp.readPage(tabId),
      (tabId) => this.fallback.readPage(tabId),
      target,
    );
    // Several tabs may be read in one tool call: say which tab the note is about.
    if (r?.note && target !== undefined) r.note = `Tab ${(await this.agent.shortId(target)) ?? p.tab}: ${r.note}`;
    return r;
  }

  /**
   * Screenshot of the current tab. The tab is never brought to the front (the
   * user may be using another tab): a background tab is captured through the
   * debugger as it is; when that is not possible the call fails with
   * BACKGROUND_SHOT_SKIPPED.
   */
  async screenshot(): Promise<WithNote<Screenshot>> {
    return this.use(
      (tabId) => this.cdpScreenshot(tabId),
      (tabId) => this.fallback.screenshot(tabId),
    );
  }

  click(p: P<"browser.click">): Promise<WithNote<R<"browser.click">>> {
    return this.use(
      (tabId) => this.viaCdp.click(tabId, p.index),
      (tabId) => this.fallback.click(tabId, p),
    );
  }

  type(p: P<"browser.type">): Promise<WithNote<R<"browser.type">>> {
    return this.use(
      (tabId) => this.viaCdp.type(tabId, p),
      (tabId) => this.fallback.type(tabId, p),
    );
  }

  paste(p: P<"browser.paste">): Promise<WithNote<R<"browser.paste">>> {
    return this.use(
      (tabId) => this.viaCdp.paste(tabId, p),
      (tabId) => this.fallback.paste(tabId, p),
    );
  }

  pressKey(p: P<"browser.pressKey">): Promise<WithNote<R<"browser.pressKey">>> {
    let events: ReturnType<typeof keyEvents>;
    try {
      events = keyEvents(p.key);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.use(
      (tabId) => this.viaCdp.pressKey(tabId, events),
      (tabId) => this.fallback.pressKey(tabId, p),
    );
  }

  scroll(p: P<"browser.scroll">): Promise<WithNote<R<"browser.scroll">>> {
    return this.use(
      (tabId) => this.viaCdp.scroll(tabId, p),
      (tabId) => this.fallback.scroll(tabId, p),
    );
  }

  upload(p: P<"browser.upload">): Promise<WithNote<R<"browser.upload">>> {
    return this.use(
      (tabId) => this.viaCdp.upload(tabId, p),
      () => this.fallback.upload(),
    );
  }

  async currentUrl(): Promise<R<"browser.currentUrl">> {
    const tabId = await this.agent.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return { url: tabUrl(tab) };
  }

  /**
   * Opens the URLs in new tabs (loading in parallel) and waits for all of
   * them, NAV_TIMEOUT_MS at most each; a tab still loading then is returned
   * with `error`. Reading them later does not need them to be active.
   */
  async openTabs({ urls, background }: P<"browser.openTabs">): Promise<R<"browser.openTabs">> {
    urls.forEach(assertOpenable);
    const created = await this.agent.open(urls, { current: background === false });
    const current = await this.agent.tabId();
    const tabs = await Promise.all(
      created.map(async (t, i): Promise<AgentTabInfo> => {
        const loaded = await this.waitForTab(t.tabId);
        const info: AgentTabInfo = { id: t.id, url: loaded.url || urls[i]!, title: loaded.title, current: t.tabId === current };
        if (loaded.error) info.error = loaded.error;
        return info;
      }),
    );
    return { tabs };
  }

  /** Makes a tab current and attaches to it. The browser's active tab does not change. */
  async switchTab({ tab }: P<"browser.switchTab">): Promise<R<"browser.switchTab">> {
    const tabId = await this.agent.setCurrent(tab);
    try {
      await this.ready();
    } catch (err) {
      if (!isRestrictedError(err)) throw err;
      throw new Error(restrictedToolError(await chrome.tabs.get(tabId).then((t) => t.url, () => undefined)));
    }
    const info = (await this.listTabs()).tabs.find((t) => t.current);
    if (!info) throw new Error(`tab ${tab} was closed`);
    return info;
  }

  async listTabs(): Promise<R<"browser.listTabs">> {
    const tabs = await this.agent.list();
    const infos = await Promise.all(
      tabs.map(async (t): Promise<AgentTabInfo | null> => {
        const tab = await chrome.tabs.get(t.tabId).catch(() => null);
        return tab ? { id: t.id, url: tabUrl(tab), title: tab.title ?? "", current: t.current } : null;
      }),
    );
    return { tabs: infos.filter((t): t is AgentTabInfo => t !== null) };
  }

  /** Closes tabs the agent opened (never the run's first tab). */
  async closeTabs({ tabs }: P<"browser.closeTabs">): Promise<R<"browser.closeTabs">> {
    const closed = await this.agent.close(tabs);
    await this.forgetStrays();
    return { closed, tabs: (await this.listTabs()).tabs };
  }

  /** Closes every tab the agent opened in this run (called when a run ends). Returns how many. */
  async closeOpenedTabs(): Promise<number> {
    const n = await this.agent.closeOpened();
    if (n) await this.forgetStrays();
    return n;
  }

  /**
   * Runs `viaCdp`, or `viaFallback` when the tab refuses the debugger
   * (switching on the first such error). Acts on the current tab, or on
   * `target` without making it current.
   */
  private async use<T extends object>(
    viaCdp: (tabId: number) => Promise<T>,
    viaFallback: (tabId: number) => Promise<T>,
    target?: number,
  ): Promise<WithNote<T>> {
    let tabId: number | undefined = target;
    try {
      if (tabId === undefined) {
        tabId = await this.ready();
      } else {
        await this.attachOrFallback(tabId, false);
      }
      if (!this.fallbackTabs.has(tabId)) {
        try {
          return await viaCdp(tabId);
        } catch (err) {
          if (!isDebuggerBlocked(err)) throw err;
          this.enterFallback(tabId);
        }
      }
      const result: WithNote<T> = await viaFallback(tabId);
      if (this.pendingNotes.delete(tabId)) result.note = FALLBACK_NOTE;
      return result;
    } catch (err) {
      // A page Chrome keeps extensions out of (Web Store, chrome://): one plain sentence, not Chrome's raw error.
      if (!isRestrictedError(err)) throw err;
      const id = tabId ?? (await this.agent.tabId());
      const url = id === null ? undefined : await chrome.tabs.get(id).then(tabUrl, () => undefined);
      throw new Error(restrictedToolError(url));
    }
  }

  /** Attaches the debugger to the tab (current: and makes it cdp's current tab), or marks the tab for fallback. */
  private async attachOrFallback(tabId: number, current: boolean): Promise<void> {
    if (this.fallbackTabs.has(tabId)) return;
    try {
      if (current) await this.cdp.attach(tabId);
      else await this.cdp.ensure(tabId);
    } catch (err) {
      if (!isDebuggerBlocked(err)) throw err;
      this.enterFallback(tabId);
    }
  }

  private enterFallback(tabId: number): void {
    this.fallbackTabs.add(tabId);
    // Chrome already dropped (or never gave) the session; forget it.
    void this.cdp.detach(tabId).catch(() => {});
    if (!this.noted.has(tabId)) {
      this.noted.add(tabId);
      this.pendingNotes.add(tabId);
    }
  }

  /** Detaches from tabs that are no longer part of the run (an earlier run's, or closed ones). */
  private async forgetStrays(): Promise<void> {
    const attached = this.cdp.attachedTabs;
    if (!attached.length && !this.fallbackTabs.size) return;
    const known = new Set(await this.knownTabs());
    for (const t of attached) if (!known.has(t)) await this.cdp.detach(t);
    for (const t of [...this.fallbackTabs]) if (!known.has(t)) this.fallbackTabs.delete(t);
  }

  /** A debugger screenshot; of a background tab with a time limit, since Chrome may not paint it. */
  private async cdpScreenshot(tabId: number): Promise<Screenshot> {
    const visible = await chrome.tabs.get(tabId).then((t) => t.active, () => true);
    const shot = this.viaCdp.screenshot(tabId);
    if (visible) return shot;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(BACKGROUND_SHOT_SKIPPED)), BACKGROUND_SHOT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([shot, timeout]);
    } finally {
      clearTimeout(timer);
      shot.catch(() => undefined);
    }
  }

  /** Waits until a new tab finished loading; `error` when it did not within NAV_TIMEOUT_MS. */
  private async waitForTab(tabId: number): Promise<{ url: string; title: string; error?: string }> {
    const read = () => chrome.tabs.get(tabId).catch(() => null);
    const loaded = await pollUntil(async () => {
      const tab = await read();
      return !tab || isTabLoaded(tab);
    }, this.sleep);
    const tab = await read();
    if (!tab) return { url: "", title: "", error: "the tab was closed while loading" };
    const r: { url: string; title: string; error?: string } = { url: tabUrl(tab), title: tab.title ?? "" };
    if (!loaded) r.error = `still loading after ${NAV_TIMEOUT_MS / 1000} s`;
    return r;
  }
}
