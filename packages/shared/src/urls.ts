/** Site and X (Twitter) URL helpers. */

const X_HOSTS = ["x.com", "twitter.com"];

/** X's home timeline (where the composer and the account switcher are). */
export const X_HOME_URL = "https://x.com/home";

/** "@name" from "name", "@name" or " @@name ". */
export function normalizeHandle(handle: string): string {
  return `@${handle.trim().replace(/^@+/, "").trim()}`;
}

/** The profile page of an X account (handle with or without @). */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${normalizeHandle(handle).slice(1)}`;
}

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

/** An X post URL: https://x.com/<handle>/status/<id>. Only the path counts, not the query. */
export function isXStatusUrl(url: string): boolean {
  if (!isXUrl(url)) return false;
  try {
    return /\/status\/\d+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
