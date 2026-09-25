/**
 * Input page functions, for both drivers: they run in the page (through
 * chrome.scripting.executeScript, or Runtime.evaluate), serialized with
 * Function.prototype.toString. Keep them self-contained (no imports at run
 * time, no module scope), plain ES2020; what they need comes as arguments
 * (PageMarks).
 */
import type { PageMarks } from "./driver-common.js";
import type { PageResult } from "./scroll-probe.js";

export function clickInPage(marks: PageMarks, index: number): PageResult<true> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
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
 * Before typing into element `index`: focuses it and puts the caret at the
 * end, so text is appended rather than inserted mid-way. A selection the
 * agent made inside an editor is kept. Other elements (e.g. a wrapper whose
 * inner editor the click focused) are left as they are.
 */
export function caretToEndInPage(marks: PageMarks, index: number): PageResult<true> {
  var el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
  if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    try {
      var n = el.value.length;
      el.setSelectionRange(n, n);
    } catch (e) {
      /* some input types have no selection */
    }
  } else if (el.isContentEditable) {
    if (!el.contains(document.activeElement)) el.focus();
    var sel = getSelection();
    if (sel && !(sel.anchorNode && el.contains(sel.anchorNode) && !sel.isCollapsed)) {
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  return { ok: true, value: true };
}

/**
 * Inserts text into element `index` (caretToEndInPage ran first), or at the
 * focus when index is null. execCommand("insertText") fires beforeinput/input
 * like typing and works in inputs, textareas and rich editors; else the value
 * is set directly.
 */
export function insertTextInPage(marks: PageMarks, index: number | null, text: string): PageResult<true> {
  var el: HTMLElement | null;
  if (index == null) {
    el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, error: "nothing is focused to paste into; click a field first" };
  } else {
    el = document.querySelector("[" + marks.attr + '="' + Math.trunc(index) + '"]') as HTMLElement | null;
    if (!el) return { ok: false, error: marks.notFound.replace("#", String(index)) };
  }
  var isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (index != null && !isField && !el.isContentEditable) el.focus();
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

export function viewportInPage(): PageResult<{ w: number; h: number }> {
  return { ok: true, value: { w: window.innerWidth, h: window.innerHeight } };
}
