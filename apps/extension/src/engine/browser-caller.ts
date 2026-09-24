import type { BrowserMethod, BrowserMethods } from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import type { HelperPeer } from "../helper-link.js";

type Impl = { [M in BrowserMethod]: (params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]> };

export interface DriverLike {
  navigate(p: BrowserMethods["browser.navigate"]["params"]): Promise<BrowserMethods["browser.navigate"]["result"]>;
  readPage(): Promise<BrowserMethods["browser.readPage"]["result"]>;
  screenshot(): Promise<BrowserMethods["browser.screenshot"]["result"]>;
  click(p: BrowserMethods["browser.click"]["params"]): Promise<BrowserMethods["browser.click"]["result"]>;
  type(p: BrowserMethods["browser.type"]["params"]): Promise<BrowserMethods["browser.type"]["result"]>;
  paste(p: BrowserMethods["browser.paste"]["params"]): Promise<BrowserMethods["browser.paste"]["result"]>;
  pressKey(p: BrowserMethods["browser.pressKey"]["params"]): Promise<BrowserMethods["browser.pressKey"]["result"]>;
  scroll(p: BrowserMethods["browser.scroll"]["params"]): Promise<BrowserMethods["browser.scroll"]["result"]>;
  upload(p: BrowserMethods["browser.upload"]["params"]): Promise<BrowserMethods["browser.upload"]["result"]>;
  currentUrl(): Promise<BrowserMethods["browser.currentUrl"]["result"]>;
}

export interface VaultLike {
  getCredential(site: string): Promise<BrowserMethods["vault.getCredential"]["result"]>;
}

/** Every browser.* and vault.* method, performed directly by the driver and the vault. */
export function browserMethods(driver: DriverLike, vault: VaultLike): Impl {
  return {
    "browser.navigate": (p) => driver.navigate(p),
    "browser.readPage": () => driver.readPage(),
    "browser.screenshot": () => driver.screenshot(),
    "browser.click": (p) => driver.click(p),
    "browser.type": (p) => driver.type(p),
    "browser.paste": (p) => driver.paste(p),
    "browser.pressKey": (p) => driver.pressKey(p),
    "browser.scroll": (p) => driver.scroll(p),
    "browser.upload": (p) => driver.upload(p),
    "browser.currentUrl": () => driver.currentUrl(),
    "vault.getCredential": (p) => vault.getCredential(p.site),
  };
}

/** BrowserCaller for the in-extension (Claude API) brain and the post verifier. */
export function createBrowserCaller(driver: DriverLike, vault: VaultLike): BrowserCaller {
  const impl = browserMethods(driver, vault);
  return {
    call: (method, params) => (impl[method] as (p: unknown) => Promise<never>)(params),
  };
}

/** Serves the same methods to the helper (Claude Code brain via MCP). */
export function registerBrowserHandlers(peer: HelperPeer, driver: DriverLike, vault: VaultLike): void {
  const impl = browserMethods(driver, vault);
  for (const method of Object.keys(impl) as BrowserMethod[]) {
    peer.handle(method, impl[method] as never);
  }
}
