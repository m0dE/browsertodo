/**
 * The browser.* actions through the debugger (Chrome DevTools Protocol) on
 * one tab. Driver decides which tab, and when a tab needs FallbackDriver
 * instead (errors that isDebuggerBlocked() recognizes pass through).
 */
import type { PageSnapshot, Screenshot } from "@browsertodo/shared";
import type { Cdp } from "./cdp.js";
import { NAV_TIMEOUT_MS, notFound, POLL_MS, SCROLL_SETTLE_MS, SETTLE_MS, type Params as P, type Result as R, type Sleep } from "./driver-common.js";
import { isDebuggerBlocked } from "./fallback-driver.js";
import type { keyEvents } from "./keys.js";
import { indexSelector, snapshotExpression } from "./page-snapshot.js";

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export class CdpActions {
  constructor(
    private readonly cdp: Cdp,
    private readonly sleep: Sleep,
  ) {}

  /** Page.navigate, then waits for the load. onStarted: the navigation went through. */
  async navigate(tabId: number, url: string, onStarted: () => void): Promise<R<"browser.navigate">> {
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
    await this.sleep(SETTLE_MS);
    return this.evaluate<{ url: string; title: string }>(tabId, "({ url: location.href, title: document.title })");
  }

  readPage(tabId: number): Promise<PageSnapshot> {
    return this.evaluate<PageSnapshot>(tabId, snapshotExpression());
  }

  async screenshot(tabId: number): Promise<Screenshot> {
    const shot = await this.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return { base64: shot.data, mimeType: "image/jpeg" };
  }

  async click(tabId: number, index: number): Promise<R<"browser.click">> {
    const { x, y } = await this.centerOf(tabId, index);
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { ok: true };
  }

  async type(tabId: number, { index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    await this.click(tabId, index);
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

  async paste(tabId: number, { text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.send(tabId, "Input.insertText", { text });
    return { ok: true };
  }

  async pressKey(tabId: number, [down, up]: ReturnType<typeof keyEvents>): Promise<R<"browser.pressKey">> {
    await this.send(tabId, "Input.dispatchKeyEvent", down);
    await this.send(tabId, "Input.dispatchKeyEvent", up);
    return { ok: true };
  }

  async scroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    const view = await this.evaluate<{ w: number; h: number }>(tabId, "({ w: window.innerWidth, h: window.innerHeight })");
    const at = index === undefined ? { x: view.w / 2, y: view.h / 2 } : await this.centerOf(tabId, index);
    const dy = Math.round(amount * 0.8 * view.h);
    const dx = Math.round(amount * 0.8 * view.w);
    const deltaY = direction === "down" ? dy : direction === "up" ? -dy : 0;
    const deltaX = direction === "right" ? dx : direction === "left" ? -dx : 0;
    await this.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY });
    await this.sleep(SCROLL_SETTLE_MS);
    return { ok: true };
  }

  async upload(tabId: number, { index, paths }: P<"browser.upload">): Promise<R<"browser.upload">> {
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

  private send<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.cdp.sendTo<T>(tabId, method, params);
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
