/**
 * Browser primitives the extension performs on the agent tab, and the page
 * snapshot format. The helper calls these over native messaging as
 * `browser.<name>` RPC methods.
 */

/** One interactive element found on the page, addressed by `index`. */
export interface ElementInfo {
  index: number;
  tag: string;
  /** ARIA role or implicit role, e.g. "button", "link", "textbox". */
  role: string;
  /** Accessible name: aria-label, label text, alt, title, placeholder or text. */
  name: string;
  /**
   * Visible text inside the element, truncated to 120 chars, when it differs
   * from `name` (e.g. a button with aria-label "Account menu" that shows
   * "Alpha @alpha").
   */
  text?: string;
  /** input type, when tag is input. */
  type?: string;
  /** Current value for inputs, truncated to 200 chars. */
  value?: string;
  href?: string;
  /** data-testid attribute, when present. Useful to Claude as a stable hint. */
  testId?: string;
  disabled?: boolean;
  /** True when at least part of the element is inside the viewport. */
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text of the page, truncated to MAX_SNAPSHOT_TEXT characters. */
  text: string;
  elements: ElementInfo[];
  /** True when elements were cut at MAX_SNAPSHOT_ELEMENTS. */
  truncated: boolean;
}

export const MAX_SNAPSHOT_TEXT = 8000;
export const MAX_SNAPSHOT_ELEMENTS = 300;

export interface Screenshot {
  /** Base64 without the data: prefix. */
  base64: string;
  mimeType: "image/png" | "image/jpeg";
}

export type ScrollDirection = "up" | "down" | "left" | "right";

/** Params and results of every browser RPC method. */
export type BrowserMethods = {
  "browser.navigate": { params: { url: string }; result: { url: string; title: string } };
  "browser.readPage": { params: Record<string, never>; result: PageSnapshot };
  "browser.screenshot": { params: Record<string, never>; result: Screenshot };
  "browser.click": { params: { index: number }; result: { ok: true } };
  "browser.type": { params: { index: number; text: string }; result: { ok: true } };
  "browser.paste": { params: { text: string }; result: { ok: true } };
  /** key is a KeyboardEvent.key value, optionally with modifiers: "Control+Enter". */
  "browser.pressKey": { params: { key: string }; result: { ok: true } };
  "browser.scroll": {
    params: { direction: ScrollDirection; amount?: number; index?: number };
    result: { ok: true };
  };
  "browser.upload": { params: { index: number; paths: string[] }; result: { ok: true } };
  "browser.currentUrl": { params: Record<string, never>; result: { url: string } };
  "vault.getCredential": {
    params: { site: string };
    result: { found: false; locked?: boolean } | { found: true; username: string; password: string };
  };
}
export type BrowserMethod = keyof BrowserMethods;
