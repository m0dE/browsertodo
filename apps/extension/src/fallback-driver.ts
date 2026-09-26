import { delay, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS, MAX_SNAPSHOT_TEXT, type PageSnapshot, type Screenshot, type Sleep } from "@browsertodo/shared";
import { isTabLoaded } from "./chrome-tabs.js";
import {
  BACKGROUND_SHOT_SKIPPED,
  clickElement,
  PAGE_MARKS,
  POLL_MS,
  pollUntil,
  SCREENSHOT_JPEG_QUALITY,
  SCROLL_SETTLE_MS,
  scrollDelta,
  SETTLE_MS,
  typeIntoElement,
  type Params as P,
  type Result as R,
} from "./driver-common.js";
import { parseKeyCombo } from "./keys.js";
import {
  checkStateInPage,
  clickInPage,
  insertTextInPage,
  prepareTypingInPage,
  pressKeyInPage,
  selectOptionInPage,
  setCheckedInPage,
  typeTargetInPage,
  viewportInPage,
} from "./page-input.js";
import { snapshotPage } from "./page-snapshot.js";
import { scrollProbeInPage, scrollReport, type PageResult, type ScrollProbe } from "./scroll-probe.js";

/**
 * Shown once per tab when the driver switches to this fallback. The runner
 * or executor should put it in front of the tool result text.
 */
export const FALLBACK_NOTE =
  "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger. Clicks and typing are simulated.)";

const FALLBACK_UPLOAD_ERROR =
  "upload is not possible on this page because another extension's frame blocks Chrome's debugger, " +
  "and an extension cannot attach local files without it. Ask the human to attach the file (task_pause), " +
  "or disable the other extension on this site and try again.";

/**
 * The browser.* methods without chrome.debugger, for tabs where Chrome refuses
 * it: chrome.scripting in the top frame and chrome.tabs.captureVisibleTab.
 * Events are untrusted (isTrusted false), so some sites may ignore them, and
 * files cannot be uploaded.
 */
export class FallbackDriver {
  private readonly sleep: Sleep;

  constructor(opts: { sleep?: Sleep } = {}) {
    this.sleep = opts.sleep ?? delay;
  }

  async navigate(tabId: number, { url }: P<"browser.navigate">): Promise<R<"browser.navigate">> {
    await chrome.tabs.update(tabId, { url });
    return this.waitForLoad(tabId, url);
  }

  /** Waits until the tab finished loading, then returns its url and title. */
  async waitForLoad(tabId: number, url: string): Promise<R<"browser.navigate">> {
    // tabs.update resolves before the old page starts unloading; give it a moment.
    await this.sleep(POLL_MS);
    await pollUntil(async () => isTabLoaded(await chrome.tabs.get(tabId)), this.sleep);
    await this.sleep(SETTLE_MS);
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? url, title: tab.title ?? "" };
  }

  async readPage(tabId: number): Promise<PageSnapshot> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [PAGE_MARKS, MAX_SNAPSHOT_TEXT, MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_OPTIONS] });
    const snap = res?.result as PageSnapshot | undefined;
    if (!snap) throw new Error("Page script failed: no page snapshot (the page may be navigating); try again");
    return snap;
  }

  async screenshot(tabId: number): Promise<Screenshot> {
    const tab = await chrome.tabs.get(tabId);
    // captureVisibleTab only sees the visible tab; the tab is never brought to the front.
    const minimized = await chrome.windows.get(tab.windowId).then((w) => w.state === "minimized", () => false);
    if (!tab.active || minimized) throw new Error(BACKGROUND_SHOT_SKIPPED);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY });
    return { base64: dataUrl.replace(/^data:[^,]*,/, ""), mimeType: "image/jpeg" };
  }

  click(tabId: number, p: P<"browser.click">): Promise<R<"browser.click">> {
    const { index } = p;
    return clickElement(p, {
      state: () => this.exec(tabId, checkStateInPage, [PAGE_MARKS, index]),
      click: () => this.exec(tabId, clickInPage, [PAGE_MARKS, index]).then(() => undefined),
      force: (checked) => this.exec(tabId, setCheckedInPage, [PAGE_MARKS, index, checked]),
    });
  }

  type(tabId: number, { index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    return typeIntoElement({
      target: () => this.exec(tabId, typeTargetInPage, [PAGE_MARKS, index]),
      select: () => this.exec(tabId, selectOptionInPage, [PAGE_MARKS, index, text]),
      click: () => this.exec(tabId, clickInPage, [PAGE_MARKS, index]).then(() => undefined),
      prepare: () => this.exec(tabId, prepareTypingInPage, [PAGE_MARKS, index]).then(() => undefined),
      insert: () => this.exec(tabId, insertTextInPage, [PAGE_MARKS, index, text]).then(() => undefined),
    });
  }

  async paste(tabId: number, { text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.exec(tabId, insertTextInPage, [PAGE_MARKS, null, text]);
    return { ok: true };
  }

  async pressKey(tabId: number, { key }: P<"browser.pressKey">): Promise<R<"browser.pressKey">> {
    const s = parseKeyCombo(key);
    const mods = { alt: (s.modifiers & 1) !== 0, ctrl: (s.modifiers & 2) !== 0, meta: (s.modifiers & 4) !== 0, shift: (s.modifiers & 8) !== 0 };
    await this.exec(tabId, pressKeyInPage, [{ key: s.key, code: s.code, keyCode: s.windowsVirtualKeyCode, text: s.text ?? null, ...mods }]);
    return { ok: true };
  }

  /** Scrolls like a wheel at the viewport center (or over element `index`) and reports what moved. */
  async scroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    const view = await this.exec(tabId, viewportInPage, []);
    const { dx, dy } = scrollDelta(direction, amount, view);
    const r = (await this.exec(tabId, scrollProbeInPage, [PAGE_MARKS, "scroll", view.w / 2, view.h / 2, index ?? null, dx, dy])) as {
      before: ScrollProbe;
      after: ScrollProbe;
    };
    await this.sleep(SCROLL_SETTLE_MS);
    if (!r || !Array.isArray(r.before?.entries) || !Array.isArray(r.after?.entries)) return { ok: true };
    return { ok: true, ...scrollReport(direction, r.before, r.after, index !== undefined) };
  }

  async upload(): Promise<R<"browser.upload">> {
    throw new Error(FALLBACK_UPLOAD_ERROR);
  }

  /** Runs a self-contained page function in the tab's top frame only (never in other extensions' frames). */
  private async exec<A extends unknown[], T>(tabId: number, func: (...args: A) => PageResult<T>, args: A): Promise<T> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    const out = res?.result as PageResult<T> | undefined;
    // Chrome returns null when the page function threw or the page navigated away meanwhile.
    if (!out) throw new Error("Page script failed (or the page was navigating); call read_page and try again");
    if (!out.ok) throw new Error(out.error);
    return out.value;
  }
}
