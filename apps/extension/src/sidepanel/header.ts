/**
 * The side panel's header: "BrowserTODO" and the account menu (Log in, Settings, pausing scheduled runs, Plan &
 * billing, Sign out) over the jobs list, and under either view a one-line problem strip that shows only while
 * something is wrong (no AI set up, out of usage credit, runs paused) with the button that fixes it. The brain in
 * use is the brand's tooltip.
 */
import { uiRequest, type UiState } from "../ui-protocol.js";
import { createAccountMenu } from "../ui/account-menu.js";
import { $, busy } from "../ui/dom.js";
import type { ErrorFixKind } from "./error-help.js";
import { runErrorFix } from "./error-view.js";
import { statusLine } from "./format.js";
import { openSettings } from "./open-settings.js";

export interface HeaderDeps {
  onState(state: UiState): void;
  /** Top up, and Plan & billing in the menu: the dashboard's Billing page. */
  onBilling(): void;
  /** Log in: the Google sign-in. */
  onSignIn(): void;
}

export interface Header {
  render(state: UiState): void;
  /** The background could not be reached at all. */
  unreachable(message: string): void;
}

export function initHeader(deps: HeaderDeps): Header {
  const statusEl = $("status");
  const statusText = $("status-text");
  const statusAction = $<HTMLButtonElement>("status-action");
  const brand = $("brand");
  /** A failed header action says why in the problem strip. */
  const say = (message: string) => {
    statusText.textContent = message;
    statusEl.dataset.tone = "bad";
    statusEl.hidden = false;
  };
  const request = async (type: "schedule.pause" | "schedule.resume" | "account.signOut") => deps.onState(await uiRequest({ type }));
  // Always shown: signed out it offers Log in and Settings, signed in the account too.
  const menu = createAccountMenu({
    id: "acct",
    signedOutTitle: "Log in or open settings",
    items: [
      { id: "acct-login", label: "Log in with Google", show: "signed-out", run: () => deps.onSignIn() },
      {
        id: "acct-pause",
        label: "Pause scheduled runs",
        show: "always",
        run: (b) => void busy(b, () => request(b.dataset.paused ? "schedule.resume" : "schedule.pause"), say),
      },
      { id: "acct-open-settings", label: "Settings", show: "always", run: () => void openSettings() },
      { id: "acct-billing", label: "Plan & billing", show: "signed-in", run: () => deps.onBilling() },
      { id: "acct-signout", label: "Sign out", show: "signed-in", tone: "bad", run: (b) => void busy(b, () => request("account.signOut"), say) },
    ],
  });
  $("acct-slot").replaceWith(menu.el);
  const pauseItem = menu.item("acct-pause");

  function renderStatus(s: UiState): void {
    const line = statusLine(s);
    brand.title = line.tone === "ok" ? `Working with ${line.text}` : "";
    // All is well: nothing to say.
    statusEl.hidden = line.tone === "ok";
    statusEl.dataset.tone = line.tone;
    statusText.textContent = line.text;
    statusText.title = line.title ?? line.text;
    // Pausing lives in the account menu; the strip only offers actions that fix something.
    const action = line.action;
    statusAction.hidden = !action;
    statusAction.textContent = action === "resume" ? "Resume" : (action?.label ?? "");
    statusAction.dataset.action = action === "resume" ? "resume" : (action?.kind ?? "");
    statusAction.title = action === "resume" ? "Run scheduled tasks again" : (action?.title ?? "");
    const paused = action === "resume";
    pauseItem.textContent = paused ? "Resume scheduled runs" : "Pause scheduled runs";
    pauseItem.dataset.paused = paused ? "1" : "";
  }

  statusAction.addEventListener("click", () => {
    const action = statusAction.dataset.action;
    if (action === "resume") return void busy(statusAction, () => request("schedule.resume"), say);
    // A fix: the same action as the chat's error cards (settings as the fallback).
    if (action && !runErrorFix(action as ErrorFixKind)) void openSettings("ai");
  });

  return {
    render(s) {
      renderStatus(s);
      menu.render(s.account);
    },
    unreachable(message) {
      say(`Background not reachable: ${message}`);
      statusAction.hidden = true;
    },
  };
}
