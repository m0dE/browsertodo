/** What Driver, its debugger actions and FallbackDriver share. */
import type { BrowserMethods, ScrollDirection, Sleep } from "@browsertodo/shared";

/** Params and result of a browser.* method. */
export type Params<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
export type Result<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

/** How long a navigation or a new tab may take to load. */
export const NAV_TIMEOUT_MS = 30_000;
/** How often a loading tab is checked. */
export const POLL_MS = 200;
/** Extra wait after a load, for late scripts to render. */
export const SETTLE_MS = 500;
/** Wait after a scroll, for lazy content. */
export const SCROLL_SETTLE_MS = 300;
/** JPEG quality of screenshots. */
export const SCREENSHOT_JPEG_QUALITY = 70;
/** One scroll `amount` moves this share of the viewport (a little overlap keeps context). */
const SCROLL_VIEWPORT_SHARE = 0.8;

/** The screenshot tool's answer when a background tab cannot be captured (it is never brought to the front). */
export const BACKGROUND_SHOT_SKIPPED =
  "Screenshot skipped: the tab is in the background (the user is using another tab). Use read_page to see the page.";

/** http(s) pages and about:blank: what navigate and open_tabs accept. */
const OPENABLE_URL = /^(https?:\/\/|about:blank$)/i;

/** Throws unless navigate and open_tabs may open the URL. */
export function assertOpenable(url: string): void {
  if (!OPENABLE_URL.test(url)) throw new Error(`Only http(s) URLs can be opened, got "${url}"`);
}

/**
 * What page functions need from here: they run in the page, serialized with
 * Function.prototype.toString, so they cannot import it and get it as an
 * argument instead. attr: read_page's element numbers; notFound: the error
 * for a number the page no longer has ("#" is the number).
 */
export interface PageMarks {
  attr: string;
  notFound: string;
}

export const PAGE_MARKS: PageMarks = {
  attr: "data-browsertodo-index",
  notFound: "element # not found; call read_page again",
};

export function notFound(index: number): Error {
  return new Error(PAGE_MARKS.notFound.replace("#", String(index)));
}

/** Selector for the element with this number from the last read_page. */
export function indexSelector(index: number): string {
  return `[${PAGE_MARKS.attr}="${Math.trunc(index)}"]`;
}

/** The wheel of a scroll: `amount` times a viewport share in its direction. */
export function scrollDelta(direction: ScrollDirection, amount: number, view: { w: number; h: number }): { dx: number; dy: number } {
  const dy = Math.round(amount * SCROLL_VIEWPORT_SHARE * view.h);
  const dx = Math.round(amount * SCROLL_VIEWPORT_SHARE * view.w);
  return {
    dx: direction === "right" ? dx : direction === "left" ? -dx : 0,
    dy: direction === "down" ? dy : direction === "up" ? -dy : 0,
  };
}

/** Checks every POLL_MS until done() says so or timeoutMs passed. Resolves whether it was done. */
export async function pollUntil(done: () => Promise<boolean>, sleep: Sleep, timeoutMs = NAV_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}
