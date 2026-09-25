/**
 * The account side of docs/BILLING-CONTRACT.md as the extension sees it:
 * the shared shapes, tolerant of servers that have no billing yet (plan and
 * credit may be missing from GET /v1/me).
 */
import type { z } from "zod";
import { CreditInfo, GOOD_STANDING, PLAN_CATALOG, planAllows, PlanInfo, User, type IssuableKeyRole, type PlanId } from "@browsertodo/shared";

export type { CreditInfo, PlanId, PlanInfo };

/** GET /v1/me: the user, plus plan and credit when the server has billing (a plan or credit it cannot read counts as missing). */
export const Me = User.extend({ plan: PlanInfo.optional().catch(undefined), credit: CreditInfo.optional().catch(undefined) });
export type Me = z.infer<typeof Me>;

export interface ApiKeyInfo {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  revokedAt: string | null;
}

/** POST /v1/me/keys: the new key, shown once. */
export interface CreatedApiKey {
  id: string;
  name: string;
  role: string;
  key: string;
}

/** The roles a key made in the extension can have. */
export type KeyRole = IssuableKeyRole;

/** A Stripe page: subscribe or change plan (checkout), buy credit (topup), manage billing (portal). */
export type BillingAction = "checkout" | "topup" | "portal";
export const BILLING_ACTIONS: readonly BillingAction[] = ["checkout", "topup", "portal"];

export interface BillingLinkRequest {
  action: BillingAction;
  plan?: PlanId;
  amountCents?: number;
  /** Where Stripe sends the user back. */
  returnUrl: string;
}

/** The plans of the contract (the shared catalog the server serves too). */
export const PLANS = Object.values(PLAN_CATALOG);

/** The plan includes voice input and is in good standing. */
export function voiceAllowed(plan: PlanInfo | undefined | null): boolean {
  return planAllows(plan, "voice");
}

/** The plan includes the account's TODO list (tasks kept in the cloud, run on schedule) and is in good standing. */
export function todoAllowed(plan: PlanInfo | undefined | null): boolean {
  return planAllows(plan, "todo");
}

/** A paid plan in good standing (includes API keys and monthly credit). */
export function isPaidActive(plan: PlanInfo | undefined | null): boolean {
  return !!plan && plan.id !== "free" && GOOD_STANDING.includes(plan.status);
}
