/**
 * The side panel's header: the status line (the brain in use, or what is
 * wrong and the button that fixes it) and the account menu (Log in,
 * Settings, pausing scheduled runs, Plan & billing, Sign out).
 */
import { uiRequest, type UiState } from "../ui-protocol.js";
import { createAccountMenu } from "../ui/account-menu.js";
import { $, busy } from "../ui/dom.js";
import { clip } from "../text.js";
import type { ErrorFixKind } from "./error-help.js";
import { runErrorFix } from "./error-view.js";
import { clockLabel, statusLine } from "./format.js";
import { openSettings } from "./open-settings.js";

/** A running task's title in the status line is clipped to this many characters. */
const RUNNING_TITLE_MAX = 60;

export interface HeaderDeps {
  onState(state: UiState): void;
  /** Top up, and Plan & billing in the menu: the dashboard's Billing page. */
  onBilling(): void;
  /** Log in: the Google sign-in (shown on the TODO tab). */
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
  /** A failed header action says why in the status line. */
  const say = (message: string) => (statusText.textContent = message);
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
    statusEl.dataset.tone = line.tone;
    statusText.textContent = line.text;
    statusText.title = line.title ?? line.text;
    const meta = $("status-meta");
    const running = s.runningSessions;
    if (line.tone === "ok") {
      meta.textContent =
        running.length > 1
          ? `· ${running.length} running`
          : running[0]
            ? `· ${clip(running[0].title, RUNNING_TITLE_MAX)}`
            : s.nextRunAt
              ? `· next check ${clockLabel(s.nextRunAt).replace(/^today /, "")}`
              : "";
      meta.title = running.map((r) => r.title).join("\n");
    } else {
      meta.textContent = "";
    }
    // Pausing lives in the account menu; the status line only offers actions that fix something.
    const action = line.action;
    statusAction.hidden = !action;
    statusAction.textContent = action === "resume" ? "Resume" : (action?.label ?? "");
    statusAction.dataset.action = action === "resume" ? "resume" : (action?.kind ?? "");
    statusAction.title = action === "resume" ? "Run scheduled tasks again" : (action?.title ?? "");
    const paused = action === "resume";
    pauseItem.textContent = paused ? "Resume scheduled runs" : "Pause scheduled runs";
    pauseItem.dataset.paused = paused ? "1" : "";
    $("live-dot").hidden = !s.running;
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
      statusEl.dataset.tone = "bad";
      statusText.textContent = `Background not reachable: ${message}`;
      statusAction.hidden = true;
    },
  };
}
