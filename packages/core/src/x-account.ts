/**
 * X accounts: switch_x_account, which changes X to another signed-in account
 * through X's own account switcher, and the check that nothing is published
 * on X as another account than the task's.
 *
 * switch_x_account only ever clicks the switcher button and, inside the menu
 * it opens, an account entry whose handle is the target or the menu's
 * "Personal accounts" section: never a Follow button or a link on the page
 * that happens to name the handle. The testIds come from X's HTML at the time
 * of writing and must be re-checked against the live site.
 */
import {
  activeXAccount,
  errorMessage,
  isXUrl,
  normalizeHandle,
  pauseReasonForUrl,
  pollUntil,
  sameHandle,
  X_HOME_URL,
  X_SWITCHER_TEST_ID,
  type ElementInfo,
  type PageSnapshot,
  type Sleep,
  type ToolResult,
} from "@browsertodo/shared";
import type { BrowserCaller } from "./types.js";

/** How long to look for the handle's entry once the account menu (or its Personal accounts section) was opened. */
export const MENU_POLL = { intervalMs: 250, timeoutMs: 3000 };
/** How long X may take to show the new account in its switcher (a real switch took 10.7 s). */
export const SWITCH_POLL = { intervalMs: 1000, timeoutMs: 30_000 };
/** How often an entry is looked up again and clicked when X re-renders the menu under the click. */
const CLICK_TRIES = 3;

/** X's account cells: in the menu a button ("Switch to @name", "Act as"); "Who to follow" cells on pages are list items. */
const ENTRY_TEST_ID = "UserCell";
const ENTRY_ROLES = new Set(["button", "menuitem"]);
/** The menu section that keeps personal accounts folded away beside delegate accounts. */
const PERSONAL_SECTION = /^personal accounts\b/i;
/** The menu's own links (Manage accounts, Log out @name): the menu is open. */
const MENU_TEST_ID_PREFIX = "AccountSwitcher_";

/** Buttons that publish on X as the signed-in account: Post (compose box, inline; Reply in a reply box) and Repost's confirm. */
const PUBLISH_TEST_IDS = new Set(["tweetButton", "tweetButtonInline", "retweetConfirm"]);
const PUBLISH_LABEL = /^(post|post all|reply|repost|quote)$/i;
/** X's keyboard shortcut for Post in a composer. */
const POST_SHORTCUT = /^(control|ctrl|meta|cmd|command)\+enter$/i;

/** True when `text` mentions exactly this handle (so @bob does not match @bobby). */
export function mentionsHandle(text: string, handle: string): boolean {
  const name = normalizeHandle(handle).slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${name}(?![A-Za-z0-9_])`, "i").test(text);
}

/** Accessible name plus visible text; X's switcher button has aria-label "Account menu". */
function labelOf(e: ElementInfo): string {
  return e.text ? `${e.name} ${e.text}` : e.name;
}

const findSwitcher = (s: PageSnapshot) => s.elements.find((e) => e.testId === X_SWITCHER_TEST_ID);
const isAccountEntry = (e: ElementInfo) => e.testId === ENTRY_TEST_ID && ENTRY_ROLES.has(e.role) && !/\bfollow/i.test(labelOf(e));
const entryFor = (s: PageSnapshot, handle: string) => s.elements.find((e) => isAccountEntry(e) && mentionsHandle(labelOf(e), handle));
const personalSection = (s: PageSnapshot) =>
  s.elements.find((e) => e.role !== "group" && (PERSONAL_SECTION.test(e.name.trim()) || PERSONAL_SECTION.test((e.text ?? "").trim())));
const menuOpen = (s: PageSnapshot) => s.elements.some((e) => isAccountEntry(e) || e.testId?.startsWith(MENU_TEST_ID_PREFIX)) || !!personalSection(s);
const shows = (s: PageSnapshot, handle: string) => {
  const active = activeXAccount(s);
  return !!active && sameHandle(active, handle);
};

export interface SwitchDeps {
  sleep: Sleep;
}

export async function switchXAccount(browser: BrowserCaller, rawHandle: string, deps: SwitchDeps): Promise<ToolResult> {
  const handle = normalizeHandle(rawHandle);
  if (handle === "@") return { text: "switch_x_account needs a handle like @name.", isError: true };
  const fail = (step: string): ToolResult => ({
    text: `switch_x_account ${step}. X is not on ${handle}: do nothing on X as another account. Call switch_x_account once more; if it fails again, call task_pause so the user switches to ${handle} by hand.`,
    isError: true,
  });
  const needsUser = (s: PageSnapshot, reason: string): ToolResult => ({
    text: `switch_x_account stopped: ${reason} (${s.url}). The user must do this: call task_pause with that reason.`,
    isError: true,
  });
  const readPage = () => browser.call("browser.readPage", {});

  let page = await readPage();
  let switcher = findSwitcher(page);
  if (!switcher && !pauseReasonForUrl(page.url)) {
    // Off X, or an X page without the side nav: X's home has the switcher.
    await browser.call("browser.navigate", { url: X_HOME_URL });
    page = await readPage();
    switcher = findSwitcher(page);
  }
  const blocked = pauseReasonForUrl(page.url);
  if (blocked) return needsUser(page, blocked);
  if (!switcher) return fail(`step 1 failed: the account switcher button (testid=${X_SWITCHER_TEST_ID}) was not found on ${page.url}`);
  if (shows(page, handle)) return { text: `Already on ${handle}.` };

  if (!menuOpen(page)) await browser.call("browser.click", { index: switcher.index });
  let menu = await pollUntil(readPage, (s) => !!entryFor(s, handle), { ...MENU_POLL, sleep: deps.sleep });
  const section = personalSection(menu.value);
  if (!menu.ok && section) {
    // Personal accounts may be folded away in their own section of the menu.
    await browser.call("browser.click", { index: section.index });
    menu = await pollUntil(readPage, (s) => !!entryFor(s, handle), { ...MENU_POLL, sleep: deps.sleep });
  }
  if (!menu.ok) {
    const folded = /personal accounts/i.test(menu.value.text) && !section;
    return fail(
      `step 2 failed: X's account menu lists no ${handle}; ${folded ? `it may be in the menu's collapsed "Personal accounts" section, which has no button to open it` : "it may not be signed in in this browser"}`,
    );
  }

  // X may re-render the menu under the click: the entry is looked up in the latest read, and again when it is gone.
  let latest = menu.value;
  for (let tries = 1; ; tries++) {
    const entry = entryFor(latest, handle);
    if (!entry) return fail(`step 2 failed: ${handle} left X's account menu before it could be chosen`);
    try {
      await browser.call("browser.click", { index: entry.index });
      break;
    } catch (e) {
      if (tries >= CLICK_TRIES || !/not found/i.test(errorMessage(e))) throw e;
      latest = await readPage();
    }
  }

  const switched = await pollUntil(readPage, (s) => shows(s, handle) || !!pauseReasonForUrl(s.url), { ...SWITCH_POLL, sleep: deps.sleep });
  const stop = pauseReasonForUrl(switched.value.url);
  if (stop) return needsUser(switched.value, stop);
  if (shows(switched.value, handle)) return { text: `Switched to ${handle}. Current URL: ${switched.value.url}` };
  const now = activeXAccount(switched.value);
  return fail(`step 3 failed: chose ${handle} in X's account menu, but after ${SWITCH_POLL.timeoutMs / 1000} s the switcher still shows ${now ?? "no account"}`);
}

/** Whether an element is one of X's buttons that publish (Post, Reply, Repost). */
function publishes(el: ElementInfo | undefined): boolean {
  if (!el) return false;
  if (el.testId && PUBLISH_TEST_IDS.has(el.testId)) return true;
  return el.role === "button" && PUBLISH_LABEL.test(el.name.trim());
}

/**
 * The refusal of an action that would publish on X while X is signed in as another account than `account` (the
 * task's), read from the page the action happens on; null when the action does not publish on X or X is on the
 * task's account.
 */
export function wrongXAccountRefusal(
  page: PageSnapshot,
  action: { method: "browser.click"; index: number } | { method: "browser.pressKey"; key: string },
  account: string,
): string | null {
  if (!isXUrl(page.url)) return null;
  const publishing = action.method === "browser.click" ? publishes(page.elements.find((e) => e.index === action.index)) : POST_SHORTCUT.test(action.key.trim());
  if (!publishing) return null;
  const want = normalizeHandle(account);
  const active = activeXAccount(page);
  if (active && sameHandle(active, want)) return null;
  if (!active) {
    return `Not done: this page shows no X account switcher, so it can't be checked that X is signed in as ${want}. Open ${X_HOME_URL}, make sure the switcher shows ${want} (switch_x_account), then post from there.`;
  }
  return `Not done: X is signed in as ${active}, this job posts as ${want}. Switch accounts first (switch_x_account ${want}); nothing is ever published from another account.`;
}

/** Whether a key press may publish on X (the only keys whose page the X account check needs). */
export function mayPublishKey(key: string): boolean {
  return POST_SHORTCUT.test(key.trim());
}
