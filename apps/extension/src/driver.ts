import type { AgentTabInfo, BrowserMethods, PageSnapshot, Screenshot } from "@browsertodo/shared";
import type { AgentTab } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { FALLBACK_NOTE, FallbackDriver, isDebuggerBlocked } from "./fallback-driver.js";
import { keyEvents } from "./keys.js";
import { indexSelector, snapshotExpression } from "./page-snapshot.js";

type P<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
type R<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

/** A result that may carry FALLBACK_NOTE, once, for the caller to show. */
export type WithNote<T> = T & { note?: string };

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const NAV_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
/** Time for a tab that was just brought to the front to paint before a screenshot. */
const SHOW_SETTLE_MS = 300;
const HTTP_URL = /^(https?:\/\/|about:blank$)/i;

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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fallback: FallbackDriver;
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
    opts: { sleep?: (ms: number) => Promise<void>; fallback?: FallbackDriver } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fallback = opts.fallback ?? new FallbackDriver({ sleep: this.sleep });
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

  navigate({ url }: P<"browser.navigate">): Promise<WithNote<R<"browser.navigate">>> {
    if (!HTTP_URL.test(url)) return Promise.reject(new Error(`Only http(s) URLs can be opened, got "${url}"`));
    let started = false;
    return this.use(
      (tabId) => this.cdpNavigate(tabId, url, () => (started = true)),
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
      (tabId) => this.evaluate<PageSnapshot>(tabId, snapshotExpression()),
      (tabId) => this.fallback.readPage(tabId),
      target,
    );
    // Several tabs may be read in one tool call: say which tab the note is about.
    if (r?.note && target !== undefined) r.note = `Tab ${(await this.agent.shortId(target)) ?? p.tab}: ${r.note}`;
    return r;
  }

  /** Screenshot of the current tab, which is brought to the front first when it is in the background. */
  async screenshot(): Promise<WithNote<Screenshot>> {
    await this.bringToFront(await this.agent.ensureTab());
    return this.use(
      async (tabId) => {
        const shot = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
        return { base64: shot.data, mimeType: "image/jpeg" as const };
      },
      (tabId) => this.fallback.screenshot(tabId),
    );
  }

  click(p: P<"browser.click">): Promise<WithNote<R<"browser.click">>> {
    return this.use(
      (tabId) => this.cdpClick(tabId, p.index),
      (tabId) => this.fallback.click(tabId, p),
    );
  }

  type(p: P<"browser.type">): Promise<WithNote<R<"browser.type">>> {
    return this.use(
      (tabId) => this.cdpType(tabId, p),
      (tabId) => this.fallback.type(tabId, p),
    );
  }

  paste(p: P<"browser.paste">): Promise<WithNote<R<"browser.paste">>> {
    return this.use(
      async (tabId) => {
        await this.send(tabId, "Input.insertText", { text: p.text });
        return { ok: true as const };
      },
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
    const [down, up] = events;
    return this.use(
      async (tabId) => {
        await this.send(tabId, "Input.dispatchKeyEvent", down);
        await this.send(tabId, "Input.dispatchKeyEvent", up);
        return { ok: true as const };
      },
      (tabId) => this.fallback.pressKey(tabId, p),
    );
  }

  scroll(p: P<"browser.scroll">): Promise<WithNote<R<"browser.scroll">>> {
    return this.use(
      (tabId) => this.cdpScroll(tabId, p),
      (tabId) => this.fallback.scroll(tabId, p),
    );
  }

  upload(p: P<"browser.upload">): Promise<WithNote<R<"browser.upload">>> {
    return this.use(
      (tabId) => this.cdpUpload(tabId, p),
      () => this.fallback.upload(),
    );
  }

  async currentUrl(): Promise<R<"browser.currentUrl">> {
    const tabId = await this.agent.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? tab.pendingUrl ?? "" };
  }

  /**
   * Opens the URLs in new tabs (loading in parallel) and waits for all of
   * them, NAV_TIMEOUT_MS at most each; a tab still loading then is returned
   * with `error`. Reading them later does not need them to be active.
   */
  async openTabs({ urls, background }: P<"browser.openTabs">): Promise<R<"browser.openTabs">> {
    const bad = urls.find((u) => !HTTP_URL.test(u));
    if (bad !== undefined) throw new Error(`Only http(s) URLs can be opened, got "${bad}"`);
    const created = await this.agent.open(urls, { active: background === false });
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

  /**
   * Makes a tab current and attaches to it. When the agent was visible (its
   * current tab was the active tab of its window) the new tab is shown too, so
   * a watching user follows along; otherwise it stays in the background.
   */
  async switchTab({ tab }: P<"browser.switchTab">): Promise<R<"browser.switchTab">> {
    const before = await this.agent.tabId();
    const wasShown = before === null ? false : await chrome.tabs.get(before).then((t) => t.active, () => false);
    const tabId = await this.agent.setCurrent(tab);
    if (wasShown && tabId !== before) await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    await this.ready();
    const info = (await this.listTabs()).tabs.find((t) => t.current);
    if (!info) throw new Error(`tab ${tab} was closed`);
    return info;
  }

  async listTabs(): Promise<R<"browser.listTabs">> {
    const tabs = await this.agent.list();
    const infos = await Promise.all(
      tabs.map(async (t): Promise<AgentTabInfo | null> => {
        const tab = await chrome.tabs.get(t.tabId).catch(() => null);
        return tab ? { id: t.id, url: tab.url || tab.pendingUrl || "", title: tab.title ?? "", current: t.current } : null;
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
    let tabId: number;
    if (target === undefined) {
      tabId = await this.ready();
    } else {
      tabId = target;
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
    const known = new Set(await this.agent.tabIds());
    for (const t of attached) if (!known.has(t)) await this.cdp.detach(t);
    for (const t of [...this.fallbackTabs]) if (!known.has(t)) this.fallbackTabs.delete(t);
  }

  /** Brings a background tab to the front of its window (screenshots of hidden tabs can be blank). */
  private async bringToFront(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return;
    await chrome.tabs.update(tabId, { active: true });
    await this.sleep(SHOW_SETTLE_MS);
  }

  /** Waits until a new tab finished loading; `error` when it did not within NAV_TIMEOUT_MS. */
  private async waitForTab(tabId: number): Promise<{ url: string; title: string; error?: string }> {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { url: "", title: "", error: "the tab was closed while loading" };
      const done = tab.status === "complete" && !tab.pendingUrl;
      if (done || Date.now() >= deadline) {
        const r: { url: string; title: string; error?: string } = { url: tab.url || tab.pendingUrl || "", title: tab.title ?? "" };
        if (!done) r.error = `still loading after ${NAV_TIMEOUT_MS / 1000} s`;
        return r;
      }
      await this.sleep(POLL_MS);
    }
  }

  private send<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.cdp.sendTo<T>(tabId, method, params);
  }

  private async cdpNavigate(tabId: number, url: string, onStarted: () => void): Promise<R<"browser.navigate">> {
    const nav = await this.send<{ errorText?: string }>(tabId, "Page.navigate", { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    onStarted();
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      const state = await this.evaluate<string>(tabId, "document.readyState").catch((err: unknown) => {
        if (isDebuggerBlocked(err)) throw err;
        return "loading";
      });
      if (state === "complete" || Date.now() >= deadline) break;
      await this.sleep(POLL_MS);
    }
    await this.sleep(500);
    return this.evaluate<{ url: string; title: string }>(tabId, "({ url: location.href, title: document.title })");
  }

  private async cdpClick(tabId: number, index: number): Promise<R<"browser.click">> {
    const { x, y } = await this.centerOf(tabId, index);
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { ok: true };
  }

  private async cdpType(tabId: number, { index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    await this.cdpClick(tabId, index);
    // Put the caret at the end so text is appended rather than inserted mid-way.
    await this.evaluate(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(indexSelector(index))}); if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus(); try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {} return true; }
        if (el.isContentEditable && el.contains(document.activeElement)) {
          const sel = getSelection(); if (sel && !(sel.anchorNode && el.contains(sel.anchorNode) && !sel.isCollapsed)) {
            const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); } }
        return true; })()`,
    ).catch((err: unknown) => {
      if (isDebuggerBlocked(err)) throw err;
      return undefined;
    });
    await this.send(tabId, "Input.insertText", { text });
    return { ok: true };
  }

  private async cdpScroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    const view = await this.evaluate<{ w: number; h: number }>(tabId, "({ w: window.innerWidth, h: window.innerHeight })");
    const at = index === undefined ? { x: view.w / 2, y: view.h / 2 } : await this.centerOf(tabId, index);
    const dy = Math.round(amount * 0.8 * view.h);
    const dx = Math.round(amount * 0.8 * view.w);
    const deltaY = direction === "down" ? dy : direction === "up" ? -dy : 0;
    const deltaX = direction === "right" ? dx : direction === "left" ? -dx : 0;
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
    await this.sleep(300);
    return { ok: true };
  }

  private async cdpUpload(tabId: number, { index, paths }: P<"browser.upload">): Promise<R<"browser.upload">> {
    const selector = indexSelector(index);
    const kind = await this.evaluate<string>(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing";
        return el instanceof HTMLInputElement && el.type === "file" ? "file" : "notfile"; })()`,
    );
    if (kind === "missing") throw notFound(index);
    if (kind !== "file") throw new Error(`element ${index} is not a file input`);
    const doc = await this.send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", { depth: 0 });
    const found = await this.send<{ nodeId: number }>(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!found.nodeId) throw notFound(index);
    await this.send(tabId, "DOM.setFileInputFiles", { files: paths, nodeId: found.nodeId });
    return { ok: true };
  }

  private async centerOf(tabId: number, index: number): Promise<{ x: number; y: number }> {
    const pos = await this.evaluate<{ x: number; y: number } | null>(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(indexSelector(index))}); if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!pos) throw notFound(index);
    return pos;
  }

  private async evaluate<T>(tabId: number, expression: string): Promise<T> {
    const res = await this.send<EvaluateResult<T>>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`Page script failed: ${d.exception?.description ?? d.text ?? "unknown error"}`);
    }
    return res.result?.value as T;
  }
}

function notFound(index: number): Error {
  return new Error(`element ${index} not found; call read_page again`);
}
