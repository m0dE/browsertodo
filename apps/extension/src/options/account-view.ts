/** Pure helpers for the options page's Account and API keys sections. */
import { PLANS, isPaidActive, type PlanId } from "../account/types.js";
import { centsLabel } from "../sidepanel/format.js";
import type { AccountView } from "../ui-protocol.js";

export interface AccountSummary {
  /** "Plus" / "Free". */
  planName: string;
  /** "active", "past due", "cancels on Oct 24"… or "" */
  planStatus: string;
  /** "$12.40" (empty when not known). */
  credit: string;
  /** "$4.40 subscription (expires Oct 24) + $8.00 top-up" */
  creditDetail: string;
  paid: boolean;
  /** API keys come with a paid plan. */
  keysAllowed: boolean;
  /** Stripe is set up on the server; false: billing buttons are replaced by a plain note. undefined: not known yet. */
  billing: "ready" | "not-set-up" | "unknown";
  outOfCredit: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 24, 2026" (UTC date: billing periods are UTC). */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function planName(id: PlanId | undefined): string {
  return PLANS.find((p) => p.id === id)?.name ?? "Free";
}

export function accountSummary(a: AccountView): AccountSummary {
  const plan = a.plan;
  const paid = isPaidActive(plan);
  let planStatus = "";
  // A canceled subscription comes back as { id: "free", status: "canceled" }.
  if (plan?.status === "canceled") planStatus = "subscription canceled";
  else if (plan && plan.id !== "free") {
    if (plan.status === "past_due") planStatus = "payment past due";
    else if (plan.cancelAtPeriodEnd && plan.currentPeriodEnd) planStatus = `ends ${dateLabel(plan.currentPeriodEnd)}`;
    else if (plan.currentPeriodEnd) planStatus = `renews ${dateLabel(plan.currentPeriodEnd)}`;
  }
  const c = a.credit;
  const parts: string[] = [];
  if (c) {
    if (c.subscriptionCents > 0 || c.periodGrantCents > 0) {
      const ends = dateLabel(c.periodEnd);
      parts.push(`${centsLabel(c.subscriptionCents)} subscription${ends ? ` (expires ${ends})` : ""}`);
    }
    if (c.topupCents > 0 || parts.length === 0) parts.push(`${centsLabel(c.topupCents)} top-up`);
  }
  return {
    planName: planName(plan?.id),
    planStatus,
    credit: c ? centsLabel(c.totalCents) : "",
    creditDetail: parts.join(" + "),
    paid,
    keysAllowed: paid,
    billing: a.stripeConfigured === true ? "ready" : a.stripeConfigured === false ? "not-set-up" : "unknown",
    outOfCredit: !!a.outOfCredit,
  };
}

/** The paid plans as the Subscribe choices show them: "Starter · $9.99/mo · $5.00 usage credit". */
export function planChoices(): { id: PlanId; label: string; detail: string }[] {
  return PLANS.filter((p) => p.id !== "free").map((p) => ({
    id: p.id,
    label: p.name,
    detail: `${centsLabel(p.priceCents)}/mo · ${centsLabel(p.creditCents)} usage credit`,
  }));
}

/**
 * Where Stripe sends the user back: the dashboard's billing page (same
 * origin as the API). Stripe may refuse chrome-extension:// URLs.
 */
export function billingReturnUrl(dashboardUrl: string): string {
  try {
    return new URL("billing", dashboardUrl).toString();
  } catch {
    return "";
  }
}
