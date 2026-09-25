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

/**
 * One tab the agent works in during a run. `id` is a short per-run id ("t1" is
 * the tab the run started on, tabs opened by open_tabs are "t2", "t3", ...).
 */
export interface AgentTabInfo {
  id: string;
  url: string;
  title: string;
  /** The tab the single-tab tools (read_page, act, navigate, ...) act on. */
  current: boolean;
  /** Set when the tab did not finish loading (e.g. the 30 s cap was hit). */
  error?: string;
}

/** Most URLs one open_tabs / read_page call handles. */
export const MAX_TABS_PER_CALL = 8;
/** Most tabs the agent may have open at once in one run (including the first). */
export const MAX_AGENT_TABS = 20;

/**
 * Every browser.* call the helper makes for a task carries that task session's
 * id as an extra `sessionId` param, so tasks running at the same time act in
 * their own tabs. Calls without one (mcp-server --attach) use the first agent tab.
 */
export interface BrowserCallContext {
  sessionId?: string;
}

/** Params and results of every browser RPC method. */
export type BrowserMethods = {
  "browser.navigate": { params: { url: string }; result: { url: string; title: string } };
  /** tab: short tab id ("t2"); default the current tab. Reading never activates the tab. */
  "browser.readPage": { params: { tab?: string }; result: PageSnapshot };
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
  /**
   * Opens each URL in a new tab of the agent's window, loading in parallel, and
   * waits for all of them (30 s cap each). background false shows the first new
   * tab and makes it the current tab; otherwise the current tab is unchanged.
   */
  "browser.openTabs": { params: { urls: string[]; background?: boolean }; result: { tabs: AgentTabInfo[] } };
  /** Makes a tab the current tab (the one the single-tab methods act on). */
  "browser.switchTab": { params: { tab: string }; result: AgentTabInfo };
  "browser.listTabs": { params: Record<string, never>; result: { tabs: AgentTabInfo[] } };
  /** Closes tabs the agent opened. The run's first tab is never closed. */
  "browser.closeTabs": { params: { tabs: string[] }; result: { closed: string[]; tabs: AgentTabInfo[] } };
  "vault.getCredential": {
    params: { site: string };
    result: { found: false; locked?: boolean } | { found: true; username: string; password: string };
  };
}
export type BrowserMethod = keyof BrowserMethods;
