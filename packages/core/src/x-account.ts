/**
 * switch_x_account: use X's own account switcher to change to another
 * signed-in account. The testIds come from X's markup at the time of writing
 * and must be re-checked against the live site.
 */
import { isXUrl, type ElementInfo, type PageSnapshot, type ToolResult } from "@browsertodo/shared";
import type { BrowserCaller } from "./types.js";

export const SWITCHER_TEST_ID = "SideNav_AccountSwitcher_Button";
const MENU_ROLES = new Set(["menuitem", "button", "link"]);
const FALLBACK = "Do it yourself with read_page and act (give the element index), then verify with a screenshot. If the account is not signed in, call task_pause.";

export function normalizeHandle(handle: string): string {
  return `@${handle.trim().replace(/^@+/, "").trim()}`;
}

/** True when `text` mentions exactly this handle (so @bob does not match @bobby). */
export function mentionsHandle(text: string, handle: string): boolean {
  const name = normalizeHandle(handle).slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${name}(?![A-Za-z0-9_])`, "i").test(text);
}

const findSwitcher = (s: PageSnapshot) => s.elements.find((e) => e.testId === SWITCHER_TEST_ID);

/** Accessible name plus visible text; X's switcher button has aria-label "Account menu". */
function labelOf(e: ElementInfo): string {
  return e.text ? `${e.name} ${e.text}` : e.name;
}

export interface SwitchDeps {
  sleep: (ms: number) => Promise<void>;
  /** How many 1 s polls to wait for the switcher to show the new account. Default 10. */
  confirmPolls?: number;
}

export async function switchXAccount(browser: BrowserCaller, rawHandle: string, deps: SwitchDeps): Promise<ToolResult> {
  const handle = normalizeHandle(rawHandle);
  if (handle === "@") return { text: "switch_x_account needs a handle like @name.", isError: true };
  const fail = (step: string): ToolResult => ({ text: `switch_x_account ${step}. ${FALLBACK}`, isError: true });

  let page = await browser.call("browser.readPage", {});
  let switcher = findSwitcher(page);
  if (!switcher && !isXUrl(page.url)) {
    await browser.call("browser.navigate", { url: "https://x.com/home" });
    page = await browser.call("browser.readPage", {});
    switcher = findSwitcher(page);
  }
  if (!switcher) return fail(`step 1 failed: the account switcher button (testid=${SWITCHER_TEST_ID}) was not found on ${page.url}`);
  if (mentionsHandle(labelOf(switcher), handle)) return { text: `Already on ${handle}.` };

  await browser.call("browser.click", { index: switcher.index });
  await deps.sleep(800);
  page = await browser.call("browser.readPage", {});
  const entry = page.elements.find(
    (e) => e.testId !== SWITCHER_TEST_ID && MENU_ROLES.has(e.role) && mentionsHandle(labelOf(e), handle),
  );
  if (!entry) return fail(`step 2 failed: the account menu has no entry for ${handle}; it may not be signed in in this browser`);
  await browser.call("browser.click", { index: entry.index });

  const polls = deps.confirmPolls ?? 10;
  for (let i = 0; i < polls; i++) {
    await deps.sleep(1000);
    page = await browser.call("browser.readPage", {});
    const now = findSwitcher(page);
    if (now && mentionsHandle(labelOf(now), handle)) return { text: `Switched to ${handle}. Current URL: ${page.url}` };
  }
  return fail(`step 3 failed: clicked the ${handle} entry but the switcher does not show ${handle} yet`);
}
