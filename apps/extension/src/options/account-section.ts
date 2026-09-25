/**
 * Options page: the Account section (sign-in, plan, credit, billing buttons,
 * dashboard link, sign out) and the API keys section. Billing buttons ask
 * the background for a Stripe page (returnUrl = the dashboard billing page) and open it in a
 * new tab. When the server has no billing, a plain note replaces them.
 */
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { TOPUP_AMOUNTS, type PlanId } from "../account/types.js";
import { $, busy, errorText, flash, h } from "../sidepanel/dom.js";
import { centsLabel } from "../sidepanel/format.js";
import { uiRequest, type AccountView, type ApiKeyInfo, type UiState } from "../ui-protocol.js";
import { accountSummary, billingReturnUrl, dateLabel, planChoices } from "./account-view.js";

export const BILLING_NOT_SET_UP_NOTE = "Billing isn't set up on this server yet, so plans and top-ups can't be bought here.";

function openTab(url: string): void {
  if (typeof chrome !== "undefined" && typeof chrome.tabs?.create === "function") void chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener");
}

export interface AccountSection {
  render(state: UiState): void;
  /** Google sign-in from any button; progress and errors go to `note`. */
  signIn(button: HTMLButtonElement, note: HTMLElement): void;
}

export function initAccountSection(opts: { onState(state: UiState): void; showBilling(): void }): AccountSection {
  let account: AccountView | null = null;
  const msg = $("acct-msg");
  const keysMsg = $("keys-msg");

  /** A Stripe page for this account, opened in a new tab. */
  const billing = (button: HTMLButtonElement, req: { action: "checkout" | "topup" | "portal"; plan?: PlanId; amountCents?: number }) =>
    void busy(button, async () => {
      flash(msg, "Opening the billing page…");
      try {
        const { url } = await uiRequest({ type: "account.billing", ...req, returnUrl: billingReturnUrl(account?.dashboardUrl ?? "") });
        openTab(url);
        flash(msg, "Opened in a new tab. Come back here when you are done; the credit updates by itself.", "ok", 8000);
      } catch (err) {
        flash(msg, errorText(err), "bad");
        // The server may have just told us billing is not set up.
        await refresh(true);
      }
    });

  async function refresh(force = false): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "account.refresh", force }));
    } catch (err) {
      flash(msg, errorText(err), "bad");
    }
  }

  // Sign in / out (also from the AI tab's "Log in to use browsertodo AI").
  const signInWith = (button: HTMLButtonElement, note: HTMLElement): void => {
    if (account && !account.signInConfigured) return flash(note, SIGN_IN_NOT_SET_UP, "bad");
    void busy(button, async () => {
      flash(note, "Continue in the Google window…");
      try {
        opts.onState(await uiRequest({ type: "account.signIn" }));
        flash(note, "");
      } catch (err) {
        flash(note, errorText(err), "bad");
      }
    });
  };
  const signIn = $<HTMLButtonElement>("acct-signin");
  const signInMsg = $("acct-signin-msg");
  signIn.addEventListener("click", () => signInWith(signIn, signInMsg));
  const signOut = $<HTMLButtonElement>("acct-signout");
  signOut.addEventListener("click", () =>
    void busy(signOut, async () => {
      try {
        opts.onState(await uiRequest({ type: "account.signOut" }));
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    }),
  );
  const reload = $<HTMLButtonElement>("acct-reload");
  reload.addEventListener("click", () => void busy(reload, () => refresh(true)));
  const change = $<HTMLButtonElement>("acct-change");
  change.addEventListener("click", () => billing(change, { action: "portal" }));
  const portal = $<HTMLButtonElement>("acct-portal");
  portal.addEventListener("click", () => billing(portal, { action: "portal" }));
  $("keys-subscribe").addEventListener("click", () => opts.showBilling());
  // Coming back from Stripe: the plan and credit changed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && account?.signedIn) void refresh(true);
  });

  function renderAccount(a: AccountView): void {
    $("acct-out").hidden = a.signedIn;
    $("acct-in").hidden = !a.signedIn;
    signOut.hidden = !a.signedIn;
    signIn.title = a.signInConfigured ? "" : SIGN_IN_NOT_SET_UP;
    if (!a.signedIn || !a.user) return;
    const u = a.user;
    $("acct-name").textContent = u.name || u.email;
    $("acct-mail").textContent = u.name ? u.email : "";
    const pic = $<HTMLImageElement>("acct-pic");
    const letter = $("acct-letter");
    if (u.pictureUrl) {
      if (pic.getAttribute("src") !== u.pictureUrl) pic.src = u.pictureUrl;
      pic.hidden = false;
      letter.textContent = "";
      pic.onerror = () => {
        pic.hidden = true;
        letter.textContent = (u.name || u.email).charAt(0).toUpperCase();
      };
    } else {
      pic.hidden = true;
      letter.textContent = (u.name || u.email).charAt(0).toUpperCase();
    }

    const sum = accountSummary(a);
    $("acct-plan").textContent = sum.planName;
    $("acct-plan-status").textContent = sum.planStatus;
    $("acct-credit").textContent = sum.outOfCredit ? "Out of AI credit" : sum.credit || "—";
    $("acct-credit-detail").textContent = sum.outOfCredit ? (sum.credit ? `${sum.credit} left` : "") : sum.creditDetail;
    $("acct-credit").parentElement!.dataset.tone = sum.outOfCredit ? "warn" : "";

    const note = $("acct-note");
    const noteText =
      a.error ??
      (sum.billing === "not-set-up"
        ? BILLING_NOT_SET_UP_NOTE
        : sum.outOfCredit
          ? "Tasks on browsertodo AI are paused until you top up or subscribe."
          : "");
    note.hidden = !noteText;
    note.textContent = noteText;
    note.dataset.tone = a.error || sum.outOfCredit ? "warn" : "";

    // Billing buttons only when the server can take payments (unknown: shown; a 503 turns them into the note).
    const canBill = sum.billing !== "not-set-up";
    $("acct-billing").hidden = !canBill;
    const plans = $("acct-plans");
    plans.hidden = sum.paid;
    plans.replaceChildren(
      ...planChoices().map((p) => {
        const b = h(
          "button.plan",
          { type: "button", title: `Subscribe to ${p.label}` },
          h("b", null, `Subscribe · ${p.label}`),
          h("small", null, p.detail),
        );
        b.addEventListener("click", () => billing(b, { action: "checkout", plan: p.id }));
        return b;
      }),
    );
    $("acct-manage").hidden = !sum.paid;
    const topup = $("acct-topup");
    topup.replaceChildren(
      h("span", null, "Top up"),
      ...TOPUP_AMOUNTS.map((cents) => {
        const b = h("button.small", { type: "button", title: `Buy ${centsLabel(cents)} of AI credit (never expires)` }, centsLabel(cents));
        b.addEventListener("click", () => billing(b, { action: "topup", amountCents: cents }));
        return b;
      }),
    );
    const dash = $<HTMLAnchorElement>("acct-dashboard");
    dash.href = a.dashboardUrl || "#";
    dash.hidden = !a.dashboardUrl;
    if (a.fetchedAt) reload.title = `Loaded ${dateLabel(a.fetchedAt)}; load plan and credit again`;
  }

  // API keys
  const keysCard = $("keys-card");
  const keysList = $("keys-list");
  const keyName = $<HTMLInputElement>("key-name");
  const keyRole = $<HTMLSelectElement>("key-role");
  const create = $<HTMLButtonElement>("key-create");
  let keysLoadedFor = "";

  async function loadKeys(): Promise<void> {
    try {
      const { keys } = await uiRequest({ type: "account.keys.list" });
      renderKeys(keys);
    } catch (err) {
      flash(keysMsg, errorText(err), "bad");
    }
  }

  function renderKeys(keys: ApiKeyInfo[]): void {
    const live = keys.filter((k) => !k.revokedAt);
    keysList.replaceChildren(
      ...(live.length
        ? live.map((k) => {
            const revoke = h("button.small.danger", { type: "button" }, "Revoke");
            revoke.addEventListener("click", () =>
              void busy(revoke, async () => {
                try {
                  await uiRequest({ type: "account.keys.revoke", id: k.id });
                  flash(keysMsg, `Revoked ${k.name}.`, "ok");
                  await loadKeys();
                } catch (err) {
                  flash(keysMsg, errorText(err), "bad");
                }
              }),
            );
            return h("li", null, h("span.key-name", { title: k.name }, k.name), h("span.chip", null, k.role), h("span.muted", null, dateLabel(k.createdAt)), revoke);
          })
        : [h("li.empty", null, "No keys yet.")]),
    );
  }

  create.addEventListener("click", () =>
    void busy(create, async () => {
      const name = keyName.value.trim();
      if (!name) return flash(keysMsg, "Give the key a name.", "bad");
      try {
        const k = await uiRequest({ type: "account.keys.create", name, role: keyRole.value as "creator" | "runner" });
        keyName.value = "";
        $("key-value").textContent = k.key;
        $("key-new").hidden = false;
        flash(keysMsg, "");
        await loadKeys();
      } catch (err) {
        flash(keysMsg, errorText(err), "bad");
      }
    }),
  );
  const copy = $<HTMLButtonElement>("key-copy");
  copy.addEventListener("click", () =>
    void navigator.clipboard.writeText($("key-value").textContent ?? "").then(
      () => flash(keysMsg, "Copied.", "ok"),
      () => flash(keysMsg, "Could not copy; select the key and copy it by hand.", "bad"),
    ),
  );

  function renderKeysCard(a: AccountView): void {
    keysCard.hidden = !a.signedIn;
    if (!a.signedIn) {
      keysLoadedFor = "";
      $("key-new").hidden = true;
      return;
    }
    const allowed = accountSummary(a).keysAllowed;
    $("keys-locked").hidden = allowed;
    $("keys-body").hidden = !allowed;
    const who = `${a.user?.email}:${allowed}`;
    if (allowed && keysLoadedFor !== who) {
      keysLoadedFor = who;
      void loadKeys();
    }
  }

  return {
    signIn: signInWith,
    render(state) {
      account = state.account ?? { signedIn: false, signInConfigured: false, apiBase: "", dashboardUrl: "" };
      renderAccount(account);
      renderKeysCard(account);
    },
  };
}
