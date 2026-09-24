import type { BrowserMethods, PageSnapshot, Screenshot } from "@browsertodo/shared";
import type { AgentTab } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { keyEvents } from "./keys.js";
import { indexSelector, snapshotExpression } from "./page-snapshot.js";

type P<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
type R<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const NAV_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

/** Implements the browser.* methods on the agent tab through the debugger. */
export class Driver {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cdp: Cdp,
    private readonly agent: AgentTab,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Ensure the agent tab exists and the debugger is attached to it. */
  async ready(): Promise<number> {
    const tabId = await this.agent.ensureTab();
    await this.cdp.attach(tabId);
    return tabId;
  }

  async navigate({ url }: P<"browser.navigate">): Promise<R<"browser.navigate">> {
    if (!/^(https?:\/\/|about:blank$)/i.test(url)) throw new Error(`Only http(s) URLs can be opened, got "${url}"`);
    await this.ready();
    const nav = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText) throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    for (;;) {
      const state = await this.evaluate<string>("document.readyState").catch(() => "loading");
      if (state === "complete" || Date.now() >= deadline) break;
      await this.sleep(POLL_MS);
    }
    await this.sleep(500);
    return this.evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })");
  }

  async readPage(): Promise<PageSnapshot> {
    await this.ready();
    return this.evaluate<PageSnapshot>(snapshotExpression());
  }

  async screenshot(): Promise<Screenshot> {
    await this.ready();
    const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    return { base64: shot.data, mimeType: "image/jpeg" };
  }

  async click({ index }: P<"browser.click">): Promise<R<"browser.click">> {
    await this.ready();
    const { x, y } = await this.centerOf(index);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { ok: true };
  }

  async type({ index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    await this.click({ index });
    // Put the caret at the end so text is appended rather than inserted mid-way.
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(indexSelector(index))}); if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus(); try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {} return true; }
        if (el.isContentEditable && el.contains(document.activeElement)) {
          const sel = getSelection(); if (sel && !(sel.anchorNode && el.contains(sel.anchorNode) && !sel.isCollapsed)) {
            const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); } }
        return true; })()`,
    ).catch(() => undefined);
    await this.cdp.send("Input.insertText", { text });
    return { ok: true };
  }

  async paste({ text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.ready();
    await this.cdp.send("Input.insertText", { text });
    return { ok: true };
  }

  async pressKey({ key }: P<"browser.pressKey">): Promise<R<"browser.pressKey">> {
    const [down, up] = keyEvents(key);
    await this.ready();
    await this.cdp.send("Input.dispatchKeyEvent", down);
    await this.cdp.send("Input.dispatchKeyEvent", up);
    return { ok: true };
  }

  async scroll({ direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    await this.ready();
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

  async upload({ index, paths }: P<"browser.upload">): Promise<R<"browser.upload">> {
    await this.ready();
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

  async currentUrl(): Promise<R<"browser.currentUrl">> {
    const tabId = await this.agent.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? tab.pendingUrl ?? "" };
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
