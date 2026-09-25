/**
 * The side panel's header: the status line (the brain in use, or what is
 * wrong and the button that fixes it) and the account menu (Log in,
 * Settings, pausing scheduled runs, Account & billing, Sign out).
 */
import { formatCents, OUT_OF_CREDIT, PLAN_FEATURE_TEXT, planName } from "@browsertodo/shared";
import { todoAllowed } from "../account/types.js";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { showAvatar } from "../ui/avatar.js";
import { $, busy } from "../ui/dom.js";
import { clip } from "../text.js";
import { clockLabel, statusLine } from "./format.js";
import { openSettings } from "./open-settings.js";

/** A running task's title in the status line is clipped to this many characters. */
const RUNNING_TITLE_MAX = 60;

type StatusAction = NonNullable<ReturnType<typeof statusLine>["action"]> | "pause";

const ACTION_LABELS: Record<StatusAction, string> = { settings: "Set up", resume: "Resume", topup: "Top up", pause: "Pause" };
const ACTION_TITLES: Record<StatusAction, string> = {
  settings: "Open the settings",
  resume: "Run scheduled tasks again",
  topup: "Buy usage credit (opens the billing page)",
  pause: "Pause scheduled runs",
};

export interface HeaderDeps {
  onState(state: UiState): void;
  /** Top up: the account's top-up page. */
  onTopup(): void;
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
  const acct = $<HTMLDetailsElement>("acct");
  const pauseItem = $<HTMLButtonElement>("acct-pause");
  const signOutBtn = $<HTMLButtonElement>("acct-signout");
  /** A failed header action says why in the status line. */
  const say = (message: string) => (statusText.textContent = message);
  const request = async (type: "schedule.pause" | "schedule.resume" | "account.signOut") => deps.onState(await uiRequest({ type }));

  function renderStatus(s: UiState): void {
    const line = statusLine(s);
    statusEl.dataset.tone = line.tone;
    statusText.textContent = line.text;
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
    const action: StatusAction = line.action ?? "pause";
    statusAction.hidden = action === "pause";
    statusAction.textContent = ACTION_LABELS[action];
    statusAction.dataset.action = action;
    statusAction.title = ACTION_TITLES[action];
    const paused = action === "resume";
    pauseItem.textContent = paused ? "Resume scheduled runs" : "Pause scheduled runs";
    pauseItem.dataset.paused = paused ? "1" : "";
    $("live-dot").hidden = !s.running;
  }

  function renderAccount(s: UiState): void {
    const a = s.account;
    // Always shown: signed out it offers Log in and Settings, signed in the account too.
    const user = a?.signedIn ? a.user : undefined;
    acct.toggleAttribute("data-signed-in", !!user);
    showAvatar($<HTMLImageElement>("acct-avatar"), $("acct-initial"), user ?? null);
    if (!a || !user) {
      $("acct-btn").title = "Log in or open settings";
      return;
    }
    const who = user.name ? `${user.name} (${user.email})` : user.email;
    $("acct-btn").title = `Signed in as ${who}`;
    $("acct-email").textContent = user.email;
    $("acct-email").title = who;
    // A plan without the TODO list says so: the TODO tab then only offers a plan.
    const plan = a.plan ? `${planName(a.plan.id)} plan${todoAllowed(a.plan) ? "" : `, no ${PLAN_FEATURE_TEXT.todo.name}`}` : "";
    const credit = a.credit ? `${formatCents(a.credit.totalCents)} usage credit` : "";
    const line = $("acct-plan");
    line.textContent = [plan, a.outOfCredit ? OUT_OF_CREDIT : credit].filter(Boolean).join(" · ");
    line.dataset.tone = a.outOfCredit ? "warn" : "";
  }

  statusAction.addEventListener("click", () => {
    const action = statusAction.dataset.action as StatusAction;
    if (action === "settings") return void openSettings("ai");
    if (action === "topup") return deps.onTopup();
    void busy(statusAction, () => request(action === "resume" ? "schedule.resume" : "schedule.pause"), say);
  });

  // Any item closes the menu (a failure then shows in the status line).
  $("acct-menu").addEventListener("click", (e) => {
    if ((e.target as Element).closest("button")) acct.open = false;
  });
  pauseItem.addEventListener("click", () =>
    void busy(pauseItem, () => request(pauseItem.dataset.paused ? "schedule.resume" : "schedule.pause"), say),
  );
  signOutBtn.addEventListener("click", () => void busy(signOutBtn, () => request("account.signOut"), say));
  $("acct-open-settings").addEventListener("click", () => void openSettings());
  $("acct-settings").addEventListener("click", () => void openSettings("account"));
  $("acct-login").addEventListener("click", () => deps.onSignIn());

  return {
    render(s) {
      renderStatus(s);
      renderAccount(s);
    },
    unreachable(message) {
      statusEl.dataset.tone = "bad";
      statusText.textContent = `Background not reachable: ${message}`;
      statusAction.hidden = true;
    },
  };
}
