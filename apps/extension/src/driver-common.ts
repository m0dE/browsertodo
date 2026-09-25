/** What Driver, its debugger actions and FallbackDriver share. */
import type { BrowserMethods } from "@browsertodo/shared";

/** Params and result of a browser.* method. */
export type Params<M extends keyof BrowserMethods> = BrowserMethods[M]["params"];
export type Result<M extends keyof BrowserMethods> = BrowserMethods[M]["result"];

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a navigation or a new tab may take to load. */
export const NAV_TIMEOUT_MS = 30_000;
/** How often a loading tab is checked. */
export const POLL_MS = 200;
/** Extra wait after a load, for late scripts to render. */
export const SETTLE_MS = 500;
/** Wait after a scroll, for lazy content. */
export const SCROLL_SETTLE_MS = 300;

/** The screenshot tool's answer when a background tab cannot be captured (it is never brought to the front). */
export const BACKGROUND_SHOT_SKIPPED =
  "Screenshot skipped: the tab is in the background (the user is using another tab). Use read_page to see the page.";

/** http(s) pages and about:blank: what navigate and open_tabs accept. */
export const OPENABLE_URL = /^(https?:\/\/|about:blank$)/i;

export function notFound(index: number): Error {
  return new Error(`element ${index} not found; call read_page again`);
}
