import { z } from "zod";
import catalog from "./billing-catalog.json";
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
  /** Voice input in the side panel (POST /v1/ai/transcribe). */
  voice: z.boolean(),
  /** The TODO list kept in the account and run on schedule (task writes, runner claims, media uploads). */
  todo: z.boolean(),
});
export type PlanCatalogEntry = z.infer<typeof PlanCatalogEntry>;

/** What a plan unlocks: the boolean capability flags of the catalog, in the order plan descriptions list them. */
export const PlanFeature = z.enum(["todo", "voice", "apiKeys"]);
export type PlanFeature = z.infer<typeof PlanFeature>;

/** How a feature reads in plan descriptions: `name` inside a sentence, `has` / `lacks` as a plan card's line. */
const FeatureText = z.object({ name: z.string(), has: z.string() });
export const PLAN_FEATURE_TEXT: Readonly<Record<PlanFeature, z.infer<typeof FeatureText>>> = z
  .object({ todo: FeatureText, voice: FeatureText, apiKeys: FeatureText })
  .parse(catalog.features);

/** "a", "a and b", "a, b and c". */
function listOf(items: string[], last: "and" | "or"): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

/** A plan's included features in one line, e.g. "Includes TODO list, voice input and API access"; "" when it includes none. */
export function planIncludesText(plan: Pick<PlanCatalogEntry, PlanFeature>): string {
  const included = PlanFeature.options.filter((f) => plan[f]).map((f) => PLAN_FEATURE_TEXT[f].name);
  return included.length ? `Includes ${listOf(included, "and")}` : "";
}

/** The 503 answer of a feature this server has not been configured for (its key or binding is missing). */
export const NOT_SET_UP = {
  billing: "Billing is not set up on this server yet",
  hostedAi: "Hosted AI is not set up on this server yet",
  jev: "Hosted Jev is not set up on this server yet",
  voice: "Voice input is not set up on this server yet",
} as const;

/** The plans (decided by the owner; docs/BILLING-CONTRACT.md). The one plan table: API, dashboard, extension and the Stripe setup script read it. */
export const PLAN_CATALOG: Readonly<Record<PlanId, PlanCatalogEntry>> = z.record(PlanId, PlanCatalogEntry).parse(catalog.plans);

/** Which plans include a feature, from the catalog: "a paid plan" when every paid plan has it, else e.g. "the Plus or Pro plan". */
export function plansWithText(feature: PlanFeature): string {
  const paid = Object.values(PLAN_CATALOG).filter((p) => p.priceCents > 0);
  const having = paid.filter((p) => p[feature]);
  return having.length === paid.length ? "a paid plan" : `the ${listOf(having.map((p) => p.name), "or")} plan`;
}

const REQUIRED_SUBJECT: Readonly<Record<PlanFeature, string>> = {
  apiKeys: "API keys need",
  voice: "Voice input needs",
  todo: "The TODO list needs",
};

/** The `message` of a 403 plan_required, per feature, e.g. "Voice input needs the Plus or Pro plan." */
export const PLAN_REQUIRED_MESSAGES: Readonly<Record<PlanFeature, string>> = Object.fromEntries(
  PlanFeature.options.map((f) => [f, `${REQUIRED_SUBJECT[f]} ${plansWithText(f)}.`]),
) as Record<PlanFeature, string>;

/** The Stripe API version the server calls with and pins its webhook endpoint to. */
export const STRIPE_API_VERSION: string = catalog.stripe.apiVersion;
/** The Stripe events the webhook handles (and the setup script subscribes to). */
export const STRIPE_WEBHOOK_EVENTS: readonly string[] = catalog.stripe.webhookEvents;

/** Statuses in which a plan's features work (past_due: Stripe is still retrying the payment). */
export const GOOD_STANDING: readonly PlanStatus[] = ["active", "past_due"];

/** True when `plan` is in good standing and its catalog entry has `feature`. */
export function planAllows(plan: { id: string; status: string } | null | undefined, feature: PlanFeature): boolean {
  if (!plan || !Object.hasOwn(PLAN_CATALOG, plan.id)) return false;
  return PLAN_CATALOG[plan.id as PlanId][feature] && (GOOD_STANDING as readonly string[]).includes(plan.status);
}

/** Fair-use limits on API-key traffic (docs/BILLING-CONTRACT.md): the API enforces them, the dashboard and extension state them. */
export const API_KEY_LIMITS = { requestsPerMinute: 60, taskCreationsPerDay: 10_000 } as const;

/** Top-up amounts that can be bought, in cents. */
/** The one-time top-up amounts, from the catalog. */
export const TOPUP_AMOUNTS_CENTS: readonly number[] = z.array(z.number().int().positive()).min(1).parse(catalog.topupAmountsCents);
export const MARKUP_PERCENT = 30;

/** GET /v1/billing/plans (public). */
export const BillingPlansResponse = z.object({
  plans: z.array(PlanCatalogEntry),
  topups: z.array(z.number().int()),
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
  amountCents: z.literal(TOPUP_AMOUNTS_CENTS),
  returnUrl: z.string().min(1).max(2000),
});
export type TopupInput = z.infer<typeof TopupInput>;

/** POST /v1/billing/portal. */
export const PortalInput = z.object({ returnUrl: z.string().min(1).max(2000) });
export type PortalInput = z.infer<typeof PortalInput>;

/** 200 of checkout, topup and portal: the Stripe page to open. */
export const RedirectUrlResponse = z.object({ url: z.string() });
export type RedirectUrlResponse = z.infer<typeof RedirectUrlResponse>;

/** The `error` code of a 402 from /v1/ai/* (no usage credit left). */
export const OUT_OF_CREDIT_CODE = "out_of_credit";
/** What the user reads when the hosted AI has no usage credit left (a paused run's reason starts with it). */
export const OUT_OF_CREDIT = "Out of usage credit";

/** 402 of /v1/ai/* when the user has no credit left. */
export const OutOfCreditError = z.object({
  error: z.literal(OUT_OF_CREDIT_CODE),
  message: z.string(),
  topupUrl: z.string(),
});
export type OutOfCreditError = z.infer<typeof OutOfCreditError>;

/** 403 of a feature the user's plan does not include (e.g. voice input or the TODO list on Free). */
export const PLAN_REQUIRED = "plan_required";
export const PlanRequiredError = z.object({
  error: z.literal(PLAN_REQUIRED),
  /** The catalog flag the plan lacks. */
  feature: PlanFeature,
  message: z.string(),
  /** Where to pick a plan (the dashboard's billing page). */
  upgradeUrl: z.string(),
});
export type PlanRequiredError = z.infer<typeof PlanRequiredError>;

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

/** "transcribe" = voice input (Workers AI speech-to-text), billed by audio length. */
export const UsageKind = z.enum(["ai_messages", "jev", "transcribe"]);
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
  /** transcribe only: seconds of audio billed. */
  audioSeconds: z.number().optional(),
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
    /** Seconds of voice input transcribed (optional: older servers do not send it). */
    audioSeconds: z.number().optional(),
  }),
  byModel: z.array(
    z.object({
      model: z.string(),
      requests: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      chargedCents: z.number(),
      /** Seconds of audio, for speech-to-text models (optional: older servers do not send it). */
      audioSeconds: z.number().optional(),
    }),
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
