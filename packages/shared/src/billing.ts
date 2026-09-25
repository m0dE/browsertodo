import { z } from "zod";
import { User } from "./task.js";

/**
 * Billing, credits, hosted AI and usage: the shapes of docs/BILLING-CONTRACT.md.
 * Money is in cents (USD). Times are ISO 8601 UTC strings.
 */

export const PlanId = z.enum(["free", "starter", "plus", "pro"]);
export type PlanId = z.infer<typeof PlanId>;

export const PaidPlanId = z.enum(["starter", "plus", "pro"]);
export type PaidPlanId = z.infer<typeof PaidPlanId>;

export const PlanStatus = z.enum(["active", "past_due", "canceled", "none"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PlanInfo = z.object({
  id: PlanId,
  /** "none" for free. */
  status: PlanStatus,
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});
export type PlanInfo = z.infer<typeof PlanInfo>;

export const CreditInfo = z.object({
  /** Remaining subscription credit this period (whole cents, rounded down). */
  subscriptionCents: z.number(),
  /** Remaining top-up credit; never expires (whole cents, rounded down). */
  topupCents: z.number(),
  totalCents: z.number(),
  /** This plan's monthly grant. */
  periodGrantCents: z.number(),
  periodEnd: z.string().nullable(),
});
export type CreditInfo = z.infer<typeof CreditInfo>;

/** GET /v1/me. */
export const MeResponse = User.extend({ plan: PlanInfo, credit: CreditInfo });
export type MeResponse = z.infer<typeof MeResponse>;

export const PlanCatalogEntry = z.object({
  id: PlanId,
  name: z.string(),
  priceCents: z.number().int(),
  creditCents: z.number().int(),
  apiKeys: z.boolean(),
});
export type PlanCatalogEntry = z.infer<typeof PlanCatalogEntry>;

/** Top-up amounts that can be bought, in cents. */
export const TOPUP_AMOUNTS_CENTS = [1000, 2500, 5000] as const;
export const MARKUP_PERCENT = 30;

/** GET /v1/billing/plans (public). */
export const BillingPlansResponse = z.object({
  plans: z.array(PlanCatalogEntry),
  topups: z.array(z.number().int()),
  markupPercent: z.number(),
});
export type BillingPlansResponse = z.infer<typeof BillingPlansResponse>;

/** GET /v1/me/billing. */
export const MeBillingResponse = z.object({ plan: PlanInfo, credit: CreditInfo, stripeConfigured: z.boolean() });
export type MeBillingResponse = z.infer<typeof MeBillingResponse>;

/** POST /v1/billing/checkout. */
export const CheckoutInput = z.object({ plan: PaidPlanId, returnUrl: z.string().min(1).max(2000) });
export type CheckoutInput = z.infer<typeof CheckoutInput>;

/** POST /v1/billing/topup. */
export const TopupInput = z.object({
  amountCents: z.union([z.literal(1000), z.literal(2500), z.literal(5000)]),
  returnUrl: z.string().min(1).max(2000),
});
export type TopupInput = z.infer<typeof TopupInput>;

/** POST /v1/billing/portal. */
export const PortalInput = z.object({ returnUrl: z.string().min(1).max(2000) });
export type PortalInput = z.infer<typeof PortalInput>;

/** 200 of checkout, topup and portal: the Stripe page to open. */
export const RedirectUrlResponse = z.object({ url: z.string() });
export type RedirectUrlResponse = z.infer<typeof RedirectUrlResponse>;

/** 402 of /v1/ai/* when the user has no credit left. */
export const OutOfCreditError = z.object({
  error: z.literal("out_of_credit"),
  message: z.string(),
  topupUrl: z.string(),
});
export type OutOfCreditError = z.infer<typeof OutOfCreditError>;

/** Body of POST /v1/ai/jev: a TypeSafe systemOne request without `model`. */
export const JevProxyInput = z.object({
  state: z.unknown(),
  questions: z.record(z.string(), z.unknown()),
});
export type JevProxyInput = z.infer<typeof JevProxyInput>;

/** Header the extension sends so usage ties to a task run. */
export const SESSION_HEADER = "X-Browsertodo-Session";
/** Response header of /v1/ai/*: cents charged for the request. */
export const CHARGED_CENTS_HEADER = "X-Browsertodo-Charged-Cents";
/** Header dashboard (cookie) requests must send on POST/PATCH/DELETE. */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_HEADER_VALUE = "browsertodo";
export const SESSION_COOKIE = "bt_session";

export const UsageKind = z.enum(["ai_messages", "jev"]);
export type UsageKind = z.infer<typeof UsageKind>;

export const UsageEvent = z.object({
  at: z.string(),
  kind: UsageKind,
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  costMicroCents: z.number().int(),
  chargedCents: z.number(),
  sessionId: z.string().nullable().optional(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

/** GET /v1/me/usage?month=YYYY-MM. */
export const UsageReport = z.object({
  month: z.string(),
  months: z.array(z.string()),
  totals: z.object({
    tasksRun: z.number().int(),
    tasksDone: z.number().int(),
    tasksFailed: z.number().int(),
    tasksPaused: z.number().int(),
    aiRequests: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    chargedCents: z.number(),
    creditGrantedCents: z.number(),
    topupsCents: z.number(),
  }),
  byModel: z.array(
    z.object({ model: z.string(), requests: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), chargedCents: z.number() }),
  ),
  byDay: z.array(z.object({ date: z.string(), tasksRun: z.number().int(), chargedCents: z.number() })),
});
export type UsageReport = z.infer<typeof UsageReport>;

export const DeviceSession = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** GET /v1/me/sessions. */
export const SessionList = z.object({ sessions: z.array(DeviceSession) });
export type SessionList = z.infer<typeof SessionList>;

/** Body of DELETE /v1/me. */
export const DeleteAccountInput = z.object({ confirm: z.string().min(1) });
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;

/** GET/PATCH /v1/me/settings (server addition: the monthly email report flag). */
export const AccountSettings = z.object({ reportEmailEnabled: z.boolean() });
export type AccountSettings = z.infer<typeof AccountSettings>;
