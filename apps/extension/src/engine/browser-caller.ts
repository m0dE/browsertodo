import type { BrowserCallContext, BrowserMethod, BrowserMethods } from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import type { HelperPeer } from "../helper-link.js";

/** The driver method behind each browser.* method: "browser.readPage" -> readPage. */
type DriverMethodOf<M> = M extends `browser.${infer Name}` ? Name : never;

/** What performs the browser.* methods (Driver): one method per browser.* method, named after it. */
export type DriverLike = {
  [M in BrowserMethod as DriverMethodOf<M>]: (params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
};

export interface VaultLike {
  getCredential(site: string): Promise<BrowserMethods["vault.getCredential"]["result"]>;
}

interface Targets {
  driver: DriverLike;
  vault: VaultLike;
}

/** Every browser.* and vault.* method, performed by the driver and the vault. */
const METHODS: { [M in BrowserMethod]: (t: Targets, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]> } = {
  "browser.navigate": ({ driver }, p) => driver.navigate(p),
  "browser.readPage": ({ driver }, p) => driver.readPage(p ?? {}),
  "browser.screenshot": ({ driver }, p) => driver.screenshot(p),
  "browser.click": ({ driver }, p) => driver.click(p),
  "browser.type": ({ driver }, p) => driver.type(p),
  "browser.paste": ({ driver }, p) => driver.paste(p),
  "browser.pressKey": ({ driver }, p) => driver.pressKey(p),
  "browser.scroll": ({ driver }, p) => driver.scroll(p),
  "browser.upload": ({ driver }, p) => driver.upload(p),
  "browser.currentUrl": ({ driver }, p) => driver.currentUrl(p),
  "browser.openTabs": ({ driver }, p) => driver.openTabs(p),
  "browser.switchTab": ({ driver }, p) => driver.switchTab(p),
  "browser.listTabs": ({ driver }, p) => driver.listTabs(p),
  "browser.closeTabs": ({ driver }, p) => driver.closeTabs(p),
  "vault.getCredential": ({ vault }, p) => vault.getCredential(p.site),
};

const BROWSER_METHODS = Object.keys(METHODS) as BrowserMethod[];

/** One method on these targets. TypeScript cannot call a table entry through a generic key, hence the one widening. */
function perform<M extends BrowserMethod>(t: Targets, method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
  const fn = METHODS[method] as (t: Targets, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  return fn(t, params);
}

/** BrowserCaller for the in-extension (Claude API) brain and the post verifier. */
export function createBrowserCaller(driver: DriverLike, vault: VaultLike): BrowserCaller {
  return { call: (method, params) => perform({ driver, vault }, method, params) };
}

/**
 * Serves the browser methods to the helper (Claude Code brain via MCP). Each
 * call is served by the caller's session (BrowserCallContext.sessionId): the
 * tab of that session's slot. The session id is not passed on to the driver.
 */
export function registerBrowserHandlers(peer: HelperPeer, browserFor: (sessionId: string | undefined) => BrowserCaller): void {
  for (const method of BROWSER_METHODS) serve(peer, method, browserFor);
}

function serve<M extends BrowserMethod>(peer: HelperPeer, method: M, browserFor: (sessionId: string | undefined) => BrowserCaller): void {
  peer.handle(method, (params) => {
    const { sessionId, ...rest } = (params ?? {}) as BrowserMethods[M]["params"] & BrowserCallContext;
    return browserFor(typeof sessionId === "string" && sessionId ? sessionId : undefined).call(method, rest as BrowserMethods[M]["params"]);
  });
}
