import { MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_TEXT, type BrowserMethods, type PageSnapshot, type Screenshot } from "@browsertodo/shared";
import { parseKeyCombo } from "./keys.js";
import { snapshotPage } from "./page-snapshot.js";

type P<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
type R<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

/**
 * Shown once per tab when the driver switches to this fallback. The runner
 * or executor should put it in front of the tool result text.
 */
export const FALLBACK_NOTE =
  "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger. Clicks and typing are simulated.)";

export const FALLBACK_UPLOAD_ERROR =
  "upload is not possible on this page because another extension's frame blocks Chrome's debugger, " +
  "and an extension cannot attach local files without it. Ask the human to attach the file (task_pause), " +
  "or disable the other extension on this site and try again.";

/**
 * True for the error Chrome gives when a tab contains a frame of another
 * extension (Streak in Gmail, password managers, ...). chrome.debugger then
 * refuses the whole tab: attach and every command fail, and an existing
 * session is detached ("target_closed") as soon as such a frame appears.
 */
export function isDebuggerBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot access a chrome-extension:\/\/ URL of different extension|debugger_access_denied/i.test(msg);
}

const NAV_TIMEOUT_MS = 30_000;
const POLL_MS = 200;

/** Result of a page function: its value, or an error message to throw. */
type PageResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The browser.* methods without chrome.debugger, for tabs where Chrome refuses
 * it: chrome.scripting in the top frame and chrome.tabs.captureVisibleTab.
 * Events are untrusted (isTrusted false), so some sites may ignore them, and
 * files cannot be uploaded.
 */
export class FallbackDriver {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async navigate(tabId: number, { url }: P<"browser.navigate">): Promise<R<"browser.navigate">> {
    await chrome.tabs.update(tabId, { url });
    return this.waitForLoad(tabId, url);
  }

  /** Waits until the tab finished loading, then returns its url and title. */
  async waitForLoad(tabId: number, url: string): Promise<R<"browser.navigate">> {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    // tabs.update resolves before the old page starts unloading; give it a moment.
    await this.sleep(POLL_MS);
    for (;;) {
      const tab = await chrome.tabs.get(tabId);
      if ((tab.status === "complete" && !tab.pendingUrl) || Date.now() >= deadline) break;
      await this.sleep(POLL_MS);
    }
    await this.sleep(500);
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? url, title: tab.title ?? "" };
  }

  async readPage(tabId: number): Promise<PageSnapshot> {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [MAX_SNAPSHOT_TEXT, MAX_SNAPSHOT_ELEMENTS] });
    const snap = res?.result as PageSnapshot | undefined;
    if (!snap) throw new Error("Page script failed: no page snapshot (the page may be navigating); try again");
    return snap;
  }

  async screenshot(tabId: number): Promise<Screenshot> {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      throw new Error("screenshot needs the agent tab to be the visible tab of its window on this page (fallback mode); use read_page instead");
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    return { base64: dataUrl.replace(/^data:[^,]*,/, ""), mimeType: "image/jpeg" };
  }

  async click(tabId: number, { index }: P<"browser.click">): Promise<R<"browser.click">> {
    await this.exec(tabId, clickInPage, [index]);
    return { ok: true };
  }

  async type(tabId: number, { index, text }: P<"browser.type">): Promise<R<"browser.type">> {
    await this.exec(tabId, clickInPage, [index]);
    await this.exec(tabId, insertTextInPage, [index, text]);
    return { ok: true };
  }

  async paste(tabId: number, { text }: P<"browser.paste">): Promise<R<"browser.paste">> {
    await this.exec(tabId, insertTextInPage, [null, text]);
    return { ok: true };
  }

  async pressKey(tabId: number, { key }: P<"browser.pressKey">): Promise<R<"browser.pressKey">> {
    const s = parseKeyCombo(key);
    const mods = { alt: (s.modifiers & 1) !== 0, ctrl: (s.modifiers & 2) !== 0, meta: (s.modifiers & 4) !== 0, shift: (s.modifiers & 8) !== 0 };
    await this.exec(tabId, pressKeyInPage, [{ key: s.key, code: s.code, keyCode: s.windowsVirtualKeyCode, text: s.text ?? null, ...mods }]);
    return { ok: true };
  }

  async scroll(tabId: number, { direction, amount = 1, index }: P<"browser.scroll">): Promise<R<"browser.scroll">> {
    await this.exec(tabId, scrollInPage, [direction, amount, index ?? null]);
    await this.sleep(300);
    return { ok: true };
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

// ---------------------------------------------------------------------------
// Page functions. They run in the page through chrome.scripting.executeScript,
// which serializes them with Function.prototype.toString: keep them
// self-contained (no imports, no module scope), plain ES2020.
// ---------------------------------------------------------------------------

export function clickInPage(index: number): PageResult<true> {
  var el = document.querySelector('[data-browsertodo-index="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: "element " + index + " not found; call read_page again" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  // Like a real click, hit the topmost element at that point when it is part of the target.
  var hit = document.elementFromPoint(x, y) as HTMLElement | null;
  var target: HTMLElement = hit && (hit === el || el.contains(hit)) ? hit : el;
  var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
  var pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerover", Object.assign({}, common, pointer)));
  target.dispatchEvent(new MouseEvent("mouseover", common));
  target.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ buttons: 1 }, common, pointer)));
  var downOk = target.dispatchEvent(new MouseEvent("mousedown", Object.assign({ buttons: 1 }, common)));
  // Untrusted mousedown does not move focus; do it like the browser would.
  if (downOk) {
    var focusable = target.closest('a[href],button,input,textarea,select,[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') as HTMLElement | null;
    (focusable || el).focus({ preventScroll: true });
  }
  target.dispatchEvent(new PointerEvent("pointerup", Object.assign({ buttons: 0 }, common, pointer)));
  target.dispatchEvent(new MouseEvent("mouseup", Object.assign({ buttons: 0 }, common)));
  // A dispatched click runs activation behavior: links navigate, buttons submit, checkboxes toggle.
  target.dispatchEvent(new MouseEvent("click", Object.assign({ buttons: 0, detail: 1 }, common)));
  return { ok: true, value: true };
}

/**
 * Inserts text at the end of element `index`, or at the focus when index is
 * null. execCommand("insertText") fires beforeinput/input like typing and works
 * in inputs, textareas and rich editors; else the value is set directly.
 */
export function insertTextInPage(index: number | null, text: string): PageResult<true> {
  var el: HTMLElement | null;
  if (index == null) {
    el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, error: "nothing is focused to paste into; click a field first" };
  } else {
    el = document.querySelector('[data-browsertodo-index="' + Math.trunc(index) + '"]') as HTMLElement | null;
    if (!el) return { ok: false, error: "element " + index + " not found; call read_page again" };
  }
  var isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (index != null) {
    if (isField) {
      el.focus();
      try {
        var n = (el as HTMLInputElement).value.length;
        (el as HTMLInputElement).setSelectionRange(n, n);
      } catch (e) {
        /* some input types have no selection */
      }
    } else if (el.isContentEditable) {
      if (!el.contains(document.activeElement)) el.focus();
      var sel = getSelection();
      // Keep a selection the agent made inside the editor; otherwise append at the end.
      if (sel && !(sel.anchorNode && el.contains(sel.anchorNode) && !sel.isCollapsed)) {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      el.focus();
    }
  }
  var target = (index == null ? el : el.isContentEditable || isField ? el : (document.activeElement as HTMLElement | null)) || el;
  var before = isField ? (target as HTMLInputElement).value : target.textContent;
  var done = false;
  try {
    done = document.execCommand("insertText", false, text);
  } catch (e) {
    done = false;
  }
  var after = isField ? (target as HTMLInputElement).value : target.textContent;
  if (done && after !== before) return { ok: true, value: true };
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    // Use the prototype setter so frameworks that track the value (React) see the change.
    var proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    var next = target.value + text;
    if (setter && setter.set) setter.set.call(target, next);
    else target.value = next;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: true };
  }
  if (target.isContentEditable) {
    target.appendChild(document.createTextNode(text));
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return { ok: true, value: true };
  }
  return { ok: false, error: "the element does not accept text" };
}

interface PageKey {
  key: string;
  code: string;
  keyCode: number;
  text?: string | null;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Dispatches keydown/keypress/keyup at the focus. Untrusted key events have no
 * default action, so the common ones are performed here when the page does not
 * cancel keydown: typing a character, Backspace/Delete, Enter (new line in
 * editors, form.requestSubmit() in a single-line input), Control/Meta+A.
 * Other defaults (Tab focus moves, arrows, shortcuts of the browser) do not happen.
 */
export function pressKeyInPage(k: PageKey): PageResult<true> {
  var target = (document.activeElement as HTMLElement | null) || document.body;
  // Chrome may drop null arguments' fields; treat a missing text as no text.
  var text = typeof k.text === "string" ? k.text : null;
  var init = {
    key: k.key,
    code: k.code,
    keyCode: k.keyCode,
    which: k.keyCode,
    altKey: k.alt,
    ctrlKey: k.ctrl,
    metaKey: k.meta,
    shiftKey: k.shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  var down = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (down && text !== null) {
    var charCode = k.key === "Enter" ? 13 : text.charCodeAt(0);
    down = target.dispatchEvent(new KeyboardEvent("keypress", Object.assign({}, init, { keyCode: charCode, which: charCode, charCode: charCode })));
  }
  if (down) {
    var editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    var shortcut = k.ctrl || k.meta || k.alt;
    if (k.key === "Enter" && !shortcut) {
      if (target instanceof HTMLInputElement) {
        if (target.form) target.form.requestSubmit();
      } else if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
        document.execCommand(target.isContentEditable ? "insertParagraph" : "insertText", false, "\n");
      } else if (target instanceof HTMLAnchorElement || target instanceof HTMLButtonElement) {
        target.click();
      }
    } else if ((k.ctrl || k.meta) && k.key.toLowerCase() === "a") {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
      else document.execCommand("selectAll");
    } else if (editable && !shortcut && (k.key === "Backspace" || k.key === "Delete")) {
      document.execCommand(k.key === "Backspace" ? "delete" : "forwardDelete");
    } else if (editable && !shortcut && text !== null) {
      document.execCommand("insertText", false, text);
    }
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, value: true };
}

export function scrollInPage(direction: string, amount: number, index: number | null): PageResult<true> {
  var dy = Math.round(amount * 0.8 * window.innerHeight);
  var dx = Math.round(amount * 0.8 * window.innerWidth);
  var top = direction === "down" ? dy : direction === "up" ? -dy : 0;
  var left = direction === "right" ? dx : direction === "left" ? -dx : 0;
  if (index == null) {
    window.scrollBy({ top: top, left: left, behavior: "instant" as ScrollBehavior });
    return { ok: true, value: true };
  }
  var el = document.querySelector('[data-browsertodo-index="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: "element " + index + " not found; call read_page again" };
  // Like a wheel over the element: scroll the nearest ancestor that can scroll that way.
  for (var e: HTMLElement | null = el; e; e = e.parentElement) {
    var style = getComputedStyle(e);
    var canY = top !== 0 && /(auto|scroll|overlay)/.test(style.overflowY) && e.scrollHeight > e.clientHeight;
    var canX = left !== 0 && /(auto|scroll|overlay)/.test(style.overflowX) && e.scrollWidth > e.clientWidth;
    if (canY || canX) {
      e.scrollBy({ top: top, left: left, behavior: "instant" as ScrollBehavior });
      return { ok: true, value: true };
    }
  }
  window.scrollBy({ top: top, left: left, behavior: "instant" as ScrollBehavior });
  return { ok: true, value: true };
}
