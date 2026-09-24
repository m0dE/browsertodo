import { MAX_SNAPSHOT_ELEMENTS, MAX_SNAPSHOT_TEXT, type PageSnapshot } from "@browsertodo/shared";

export const INDEX_ATTR = "data-browsertodo-index";

/** Selector for the element with this index from the last snapshot. */
export function indexSelector(index: number): string {
  return `[${INDEX_ATTR}="${Math.trunc(index)}"]`;
}

/** The Runtime.evaluate expression that runs snapshotPage in the page. */
export function snapshotExpression(): string {
  return `(${snapshotPage.toString()})(${MAX_SNAPSHOT_TEXT}, ${MAX_SNAPSHOT_ELEMENTS})`;
}

/**
 * Runs inside the page via Runtime.evaluate. It must stay self-contained:
 * no imports, no references to module scope, plain ES2020, because it is
 * serialized with Function.prototype.toString.
 */
export function snapshotPage(maxText: number, maxElements: number): PageSnapshot {
  var ATTR = "data-browsertodo-index";
  var old = document.querySelectorAll("[" + ATTR + "]");
  for (var i = 0; i < old.length; i++) old[i]!.removeAttribute(ATTR);

  var SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="option"]',
    '[role="switch"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  var vw = window.innerWidth;
  var vh = window.innerHeight;

  function clean(s: string | null | undefined, max: number): string {
    return (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function isVisible(el: Element): boolean {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (var e: Element | null = el; e; e = e.parentElement) {
      if (getComputedStyle(e).display === "none") return false;
    }
    return true;
  }

  function implicitRole(el: Element): string {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0]!;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "file") return "file";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return "generic";
  }

  function nameOf(el: Element): string {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria, 120);
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts: string[] = [];
      labelledBy.split(/\s+/).forEach(function (id) {
        var ref = document.getElementById(id);
        if (ref) parts.push(ref.textContent || "");
      });
      var joined = clean(parts.join(" "), 120);
      if (joined) return joined;
    }
    var labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      var lt = clean(labels[0]!.textContent, 120);
      if (lt) return lt;
    }
    var attrs = ["alt", "title", "placeholder"];
    for (var a = 0; a < attrs.length; a++) {
      var v = el.getAttribute(attrs[a]!);
      if (v && v.trim()) return clean(v, 120);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var type = ((el as HTMLInputElement).type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return clean((el as HTMLInputElement).value, 120);
      return "";
    }
    var text = (el as HTMLElement).innerText;
    if (text === undefined) text = el.textContent || "";
    if (clean(text, 120)) return clean(text, 120);
    // Icon buttons: fall back to an image's alt text inside.
    var img = el.querySelector("img[alt], svg[aria-label]");
    if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label"), 120);
    return "";
  }

  var elements: PageSnapshot["elements"] = [];
  var truncated = false;
  var nodes = document.querySelectorAll(SELECTOR);
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n]!;
    var tag = el.tagName.toLowerCase();
    var inputType = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : undefined;
    var isFile = inputType === "file";
    if (inputType === "hidden") continue;
    if (!isFile && !isVisible(el)) continue;
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    var index = elements.length;
    el.setAttribute(ATTR, String(index));
    var rect = el.getBoundingClientRect();
    var info: PageSnapshot["elements"][number] = {
      index: index,
      tag: tag,
      role: implicitRole(el),
      name: nameOf(el),
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw && rect.width > 0,
    };
    if (inputType) info.type = inputType;
    if (tag !== "input" && tag !== "textarea" && tag !== "select") {
      var inner = (el as HTMLElement).innerText;
      var innerClean = clean(inner === undefined ? el.textContent : inner, 120);
      if (innerClean && innerClean !== info.name) info.text = innerClean;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var value = (el as HTMLInputElement).value;
      if (value) info.value = inputType === "password" ? "********" : value.slice(0, 200);
    }
    var href = tag === "a" ? (el as HTMLAnchorElement).href : null;
    if (href) info.href = href.slice(0, 500);
    var testId = el.getAttribute("data-testid");
    if (testId) info.testId = testId;
    if ((el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true") info.disabled = true;
    elements.push(info);
  }

  var bodyText = document.body ? document.body.innerText || "" : "";
  var text = bodyText
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim()
    .slice(0, maxText);

  return { url: location.href, title: document.title, text: text, elements: elements, truncated: truncated };
}
