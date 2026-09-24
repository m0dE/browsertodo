/** Small helpers shared by the core modules. Browser- and Node-safe. */

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const X_HOSTS = ["x.com", "twitter.com"];

/** Hostname of a site given as a host or URL, lowercased, without www. */
export function siteHost(site: string): string {
  const s = site.trim().toLowerCase();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s;
  }
}

/** True for x.com, twitter.com and their subdomains (site given as host or URL). */
export function isXSite(site: string): boolean {
  const host = siteHost(site);
  return X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True when the URL is on x.com or twitter.com. */
export function isXUrl(url: string): boolean {
  try {
    return isXSite(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** An X post URL: https://x.com/<handle>/status/<id>. */
export function isXStatusUrl(url: string): boolean {
  return isXUrl(url) && /\/status\/\d+/.test(url);
}

/** Collapse whitespace and lowercase, for loose text comparison. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
