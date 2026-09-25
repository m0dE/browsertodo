/** Independent check that an X post exists and shows the expected text. */
import { errorMessage, isXStatusUrl, normalizeText } from "@browsertodo/shared";
import type { BrowserCaller } from "./types.js";

export const VERIFY_SNIPPET_CHARS = 40;
/** What X shows instead of a post that does not exist (or was deleted). */
export const X_POST_MISSING = /this (post|page) (doesn.t|does not) exist|this post was deleted|hmm\.\.\.this page/i;

/** The distinctive part of a post text that must appear on its page. */
export function verifySnippet(expectedText: string): string {
  return normalizeText(expectedText).slice(0, VERIFY_SNIPPET_CHARS).trim();
}

export async function verifyXPost(browser: BrowserCaller, url: string, expectedText: string): Promise<{ ok: boolean; detail: string }> {
  if (!isXStatusUrl(url)) return { ok: false, detail: `not an X post URL: ${url}` };
  const snippet = verifySnippet(expectedText);
  try {
    await browser.call("browser.navigate", { url });
    const page = await browser.call("browser.readPage", {});
    if (X_POST_MISSING.test(`${page.title} ${page.text}`)) return { ok: false, detail: `X says the post does not exist at ${page.url}` };
    if (!snippet) return { ok: true, detail: `opened ${page.url} (no text to compare)` };
    const haystack = normalizeText(`${page.text}\n${page.title}\n${page.elements.map((e) => `${e.name} ${e.text ?? ""}`).join("\n")}`);
    if (haystack.includes(snippet)) return { ok: true, detail: `found "${snippet}" on ${page.url}` };
    return { ok: false, detail: `"${snippet}" not found on ${page.url}` };
  } catch (e) {
    return { ok: false, detail: `could not open ${url}: ${errorMessage(e)}` };
  }
}
