/**
 * The account side of docs/BILLING-CONTRACT.md as the extension sees it.
 * Plan and credit may be missing while a server has no billing yet.
 */
import type { User } from "@browsertodo/shared";

export type PlanId = "free" | "starter" | "plus" | "pro";

export interface PlanInfo {
  id: PlanId;
  status: "active" | "past_due" | "canceled" | "none";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface CreditInfo {
  subscriptionCents: number;
  topupCents: number;
  totalCents: number;
  periodGrantCents: number;
  periodEnd: string | null;
}

/** GET /v1/me: the user plus plan and credit (older servers: the user only). */
export type Me = User & { plan?: PlanInfo; credit?: CreditInfo };

export interface BillingInfo {
  plan: PlanInfo;
  credit: CreditInfo;
  stripeConfigured: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  revokedAt: string | null;
}

/** The plans of the contract (the server's GET /v1/billing/plans says the same). */
export const PLANS: readonly { id: PlanId; name: string; priceCents: number; creditCents: number; apiKeys: boolean }[] = [
  { id: "free", name: "Free", priceCents: 0, creditCents: 0, apiKeys: false },
  { id: "starter", name: "Starter", priceCents: 999, creditCents: 500, apiKeys: true },
  { id: "plus", name: "Plus", priceCents: 2999, creditCents: 2000, apiKeys: true },
  { id: "pro", name: "Pro", priceCents: 19999, creditCents: 19999, apiKeys: true },
];

export const TOPUP_AMOUNTS: readonly number[] = [1000, 2500, 5000];

/** The models the hosted AI prices (the contract's price table). */
export const HOSTED_MODELS: readonly string[] = ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"];
export const DEFAULT_HOSTED_MODEL = "claude-sonnet-5";

/** The model the hosted AI runs for this setting: unknown ids fall back to the default. */
export function hostedModel(model: string): string {
  return HOSTED_MODELS.includes(model) ? model : DEFAULT_HOSTED_MODEL;
}

/** A paid plan that is currently active (includes API keys and monthly credit). */
export function isPaidActive(plan: PlanInfo | undefined | null): boolean {
  return !!plan && plan.id !== "free" && (plan.status === "active" || plan.status === "past_due");
}

