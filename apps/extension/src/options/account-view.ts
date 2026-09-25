/** Pure helpers for the options page's Account and API keys sections. */
import { formatCents, formatDate, PLAN_CATALOG, planIncludesText, planName, planStatusText } from "@browsertodo/shared";
import { PLANS, isPaidActive, type PlanId, type PlanInfo } from "../account/types.js";
import type { AccountView } from "../ui-protocol.js";

export interface AccountSummary {
  /** "Plus" / "Free". */
  planName: string;
  /** "Renews Oct 24, 2026", "Ends Oct 24, 2026", "Payment overdue"… or "" */
  planStatus: string;
  /** What the plan comes with, from the catalog: "Includes TODO list, voice input and API keys" ("" when the plan is not known). */
  planIncludes: string;
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

/** "Oct 24, 2026" (UTC date: billing periods are UTC). */
export function dateLabel(iso: string | null | undefined): string {
  return formatDate(iso, "UTC");
}

/** The line under the plan: a payment problem, else when a paid plan renews or ends. */
function planStatus(plan: PlanInfo | undefined): string {
  if (!plan) return "";
  // A canceled subscription comes back as { id: "free", status: "canceled" }.
  if (plan.status === "canceled") return planStatusText(plan) ?? "";
  if (plan.id === "free") return "";
  if (plan.status === "past_due") return planStatusText(plan) ?? "";
  if (!plan.currentPeriodEnd) return "";
  return `${plan.cancelAtPeriodEnd ? "Ends" : "Renews"} ${dateLabel(plan.currentPeriodEnd)}`;
}

export function accountSummary(a: AccountView): AccountSummary {
  const plan = a.plan;
  const paid = isPaidActive(plan);
  const c = a.credit;
  const parts: string[] = [];
  if (c) {
    if (c.subscriptionCents > 0 || c.periodGrantCents > 0) {
      const ends = dateLabel(c.periodEnd);
      parts.push(`${formatCents(c.subscriptionCents)} subscription${ends ? ` (expires ${ends})` : ""}`);
    }
    if (c.topupCents > 0 || parts.length === 0) parts.push(`${formatCents(c.topupCents)} top-up`);
  }
  return {
    planName: planName(plan?.id),
    planStatus: planStatus(plan),
    planIncludes: plan ? planIncludesText(PLAN_CATALOG[plan.id]) : "",
    credit: c ? formatCents(c.totalCents) : "",
    creditDetail: parts.join(" + "),
    paid,
    keysAllowed: paid,
    billing: a.stripeConfigured === true ? "ready" : a.stripeConfigured === false ? "not-set-up" : "unknown",
    outOfCredit: !!a.outOfCredit,
  };
}

/** The paid plans as the Subscribe choices show them: "Starter", "$9.99/mo · $5.00 usage credit", "Includes TODO list, …". */
export function planChoices(): { id: PlanId; label: string; detail: string; includes: string }[] {
  return PLANS.filter((p) => p.id !== "free").map((p) => ({
    id: p.id,
    label: p.name,
    detail: `${formatCents(p.priceCents)}/mo · ${formatCents(p.creditCents)} usage credit`,
    includes: planIncludesText(p),
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
