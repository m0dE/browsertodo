import type { BrowserMethods, PageSnapshot, Screenshot } from "@browsertodo/shared";
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

/**
 * Implements the browser.* methods on the agent tab through the debugger.
 *
 * Chrome refuses chrome.debugger for a whole tab once it contains a frame of
 * another extension (e.g. Streak inside Gmail): attach and every command fail
 * with "Cannot access a chrome-extension:// URL of different extension", and a
 * live session is detached ("target_closed") when such a frame appears. That
 * tab then switches to FallbackDriver (chrome.scripting + captureVisibleTab,
 * simulated input). The first result in fallback mode for a tab carries
 * `note: FALLBACK_NOTE`. After a navigation the debugger is tried again.
 */
export class Driver {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fallback: FallbackDriver;
  /** The tab currently driven without the debugger, if any. */
  private fallbackTab: number | null = null;
  /** Tabs whose fallback note was already handed out. */
  private readonly noted = new Set<number>();
  private pendingNote = false;

  constructor(
    private readonly cdp: Cdp,
    private readonly agent: AgentTab,
    opts: { sleep?: (ms: number) => Promise<void>; fallback?: FallbackDriver } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fallback = opts.fallback ?? new FallbackDriver({ sleep: this.sleep });
  }

  /** True when the agent tab is currently driven without the debugger. */
  get inFallback(): boolean {
    return this.fallbackTab !== null;
  }

  /**
   * Ensure the agent tab exists and the debugger is attached to it, or that
   * the tab is in fallback mode because Chrome refuses the debugger there.
   */
  async ready(): Promise<number> {
    const tabId = await this.agent.ensureTab();
    if (this.fallbackTab === tabId) return tabId;
    this.fallbackTab = null;
    try {
      await this.cdp.attach(tabId);
    } catch (err) {
      if (!isDebuggerBlocked(err)) throw err;
      this.enterFallback(tabId);
    }
    return tabId;
  }

  navigate({ url }: P<"browser.navigate">): Promise<WithNote<R<"browser.navigate">>> {
    if (!/^(https?:\/\/|about:blank$)/i.test(url)) return Promise.reject(new Error(`Only http(s) URLs can be opened, got "${url}"`));
    let started = false;
    return this.use(
      () => this.cdpNavigate(url, () => (started = true)),
      async (tabId) => {
        // If Page.navigate went through before the debugger was refused, only wait for the load.
        const r = started ? await this.fallback.waitForLoad(tabId, url) : await this.fallback.navigate(tabId, { url });
        // The new page may not contain the other extension's frame: try the debugger again next call.
        if (this.fallbackTab === tabId) this.fallbackTab = null;
        return r;
      },
    );
  }

  readPage(): Promise<WithNote<PageSnapshot>> {
    return this.use(
      () => this.evaluate<PageSnapshot>(snapshotExpression()),
      (tabId) => this.fallback.readPage(tabId),
    );
  }

  screenshot(): Promise<WithNote<Screenshot>> {
    return this.use(
      async () => {
        const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
        return { base64: shot.data, mimeType: "image/jpeg" as const };
      },
      (tabId) => this.fallback.screenshot(tabId),
    );
  }

  click(p: P<"browser.click">): Promise<WithNote<R<"browser.click">>> {
    return this.use(
      () => this.cdpClick(p.index),
      (tabId) => this.fallback.click(tabId, p),
    );
  }

  type(p: P<"browser.type">): Promise<WithNote<R<"browser.type">>> {
    return this.use(
      () => this.cdpType(p),
      (tabId) => this.fallback.type(tabId, p),
    );
  }

  paste(p: P<"browser.paste">): Promise<WithNote<R<"browser.paste">>> {
    return this.use(
      async () => {
        await this.cdp.send("Input.insertText", { text: p.text });
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
      async () => {
        await this.cdp.send("Input.dispatchKeyEvent", down);
        await this.cdp.send("Input.dispatchKeyEvent", up);
        return { ok: true as const };
      },
      (tabId) => this.fallback.pressKey(tabId, p),
    );
  }

  scroll(p: P<"browser.scroll">): Promise<WithNote<R<"browser.scroll">>> {
    return this.use(
      () => this.cdpScroll(p),
      (tabId) => this.fallback.scroll(tabId, p),
    );
  }

  upload(p: P<"browser.upload">): Promise<WithNote<R<"browser.upload">>> {
    return this.use(
      () => this.cdpUpload(p),
      () => this.fallback.upload(),
    );
  }

  async currentUrl(): Promise<R<"browser.currentUrl">> {
    const tabId = await this.agent.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? tab.pendingUrl ?? "" };
  }

  /** Runs `viaCdp`, or `viaFallback` when the tab refuses the debugger (switching on the first such error). */
  private async use<T extends object>(viaCdp: () => Promise<T>, viaFallback: (tabId: number) => Promise<T>): Promise<WithNote<T>> {
    const tabId = await this.ready();
    if (this.fallbackTab !== tabId) {
      try {
        return await viaCdp();
      } catch (err) {
        if (!isDebuggerBlocked(err)) throw err;
        this.enterFallback(tabId);
      }
    }
    const result: WithNote<T> = await viaFallback(tabId);
    if (this.pendingNote) {
      this.pendingNote = false;
      result.note = FALLBACK_NOTE;
    }
    return result;
  }

  private enterFallback(tabId: number): void {
    this.fallbackTab = tabId;
    // Chrome already dropped (or never gave) the session; forget it.
    void this.cdp.detach().catch(() => {});
    if (!this.noted.has(tabId)) {
      this.noted.add(tabId);
      this.pendingNote = true;
    }
  }

  private async cdpNavigate(url: string, onStarted: () => void): Promise<R<"browser.navigate">> {
    const nav = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    onStarted();
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      const state = await this.evaluate<string>("document.readyState").catch((err: unknown) => {
        if (isDebuggerBlocked(err)) throw err;
        return "loading";
      });
      if (state === "complete" || Date.now() >= deadline) break;
      await this.sleep(POLL_MS);
    }
    await this.sleep(500);
    return this.evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })");
  }

  private async cdpClick(index: number): Promise<R<"browser.click">> {
    const { x, y } = await this.centerOf(index);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { ok: true };
  }

  private async cdpType({ index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    await this.cdpClick(index);
    // Put the caret at the end so text is appended rather than inserted mid-way.
    await this.evaluate(
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
    await this.cdp.send("Input.insertText", { text });
    return { ok: true };
  }

  private async cdpScroll({ direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    const view = await this.evaluate<{ w: number; h: number }>("({ w: window.innerWidth, h: window.innerHeight })");
    const at = index === undefined ? { x: view.w / 2, y: view.h / 2 } : await this.centerOf(index);
    const dy = Math.round(amount * 0.8 * view.h);
    const dx = Math.round(amount * 0.8 * view.w);
    const deltaY = direction === "down" ? dy : direction === "up" ? -dy : 0;
    const deltaX = direction === "right" ? dx : direction === "left" ? -dx : 0;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
    await this.sleep(300);
    return { ok: true };
  }

  private async cdpUpload({ index, paths }: P<"browser.upload">): Promise<R<"browser.upload">> {
    const selector = indexSelector(index);
    const kind = await this.evaluate<string>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing";
        return el instanceof HTMLInputElement && el.type === "file" ? "file" : "notfile"; })()`,
    );
    if (kind === "missing") throw notFound(index);
    if (kind !== "file") throw new Error(`element ${index} is not a file input`);
    const doc = await this.cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const found = await this.cdp.send<{ nodeId: number }>("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!found.nodeId) throw notFound(index);
    await this.cdp.send("DOM.setFileInputFiles", { files: paths, nodeId: found.nodeId });
    return { ok: true };
  }

  private async centerOf(index: number): Promise<{ x: number; y: number }> {
    const pos = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(indexSelector(index))}); if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!pos) throw notFound(index);
    return pos;
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const res = await this.cdp.send<EvaluateResult<T>>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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
