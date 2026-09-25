/**
 * Pure logic for the options page: its tabs, what each brain option shows
 * and allows, which fields are visible, and inline validation. The page
 * (options.ts) only renders what these functions return.
 */
import type { BrainMode, ExtensionSettings } from "@browsertodo/shared";
import { HOSTED_MODELS, isPaidActive } from "../account/types.js";
import { resolveBrain } from "../engine/brain-resolver.js";
import { brainLabel, centsLabel, KNOWN_MODELS } from "../sidepanel/format.js";
import type { AccountView, BrainStatus } from "../ui-protocol.js";
import { planName } from "./account-view.js";

// ---------------------------------------------------------------- tabs

export const TABS = [
  { id: "account", label: "Account" },
  { id: "ai", label: "AI" },
  { id: "speed", label: "Speed" },
  { id: "tasks", label: "Tasks" },
  { id: "logins", label: "Site logins" },
  { id: "advanced", label: "Advanced" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

/** Other names a link may use for a tab (options.html#jev opens Speed). */
const TAB_ALIASES: Record<string, TabId> = {
  brain: "ai",
  model: "ai",
  helper: "ai",
  jev: "speed",
  keys: "account",
  billing: "account",
  schedule: "tasks",
  vault: "logins",
  cloud: "advanced",
  "self-hosting": "advanced",
};

/** "#ai" / "ai" / "#jev" -> the tab; null for anything unknown. */
export function tabFromHash(hash: string | null | undefined): TabId | null {
  const id = (hash ?? "").replace(/^#/, "").trim().toLowerCase();
  if (!id) return null;
  if (TABS.some((t) => t.id === id)) return id as TabId;
  return TAB_ALIASES[id] ?? null;
}

/** The tab an arrow key moves to (wraps around); Home / End go to the ends. */
export function nextTab(current: TabId, key: string): TabId | null {
  const i = TABS.findIndex((t) => t.id === current);
  const n = TABS.length;
  if (key === "ArrowRight" || key === "ArrowDown") return TABS[(i + 1) % n]!.id;
  if (key === "ArrowLeft" || key === "ArrowUp") return TABS[(i - 1 + n) % n]!.id;
  if (key === "Home") return TABS[0].id;
  if (key === "End") return TABS[n - 1]!.id;
  return null;
}

// ---------------------------------------------------------------- brain options

/** What the page has on screen right now (may differ from the saved settings until saved). */
export interface Draft {
  brain: BrainMode;
  jevEnabled: boolean;
  cloudEnabled: boolean;
  anthropicModel: string;
}

export interface ViewInput {
  /** Saved settings, secrets redacted to "set" / "". */
  settings: ExtensionSettings;
  draft: Draft;
  brain: BrainStatus;
  account?: AccountView | null;
}

export type Tone = "ok" | "warn" | "bad" | "";

export interface HostedAccount {
  /** "Free plan" / "Plus plan". */
  plan: string;
  /** "$4.21 AI credit left" or "No AI credit left". */
  credit: string;
  tone: Tone;
  /** get-plan: on the free plan; top-up: a paid plan with no credit left. null: nothing to buy (or billing is off). */
  action: { kind: "get-plan" | "top-up"; label: string } | null;
}

export interface BrainOption {
  value: BrainMode;
  label: string;
  /** One line under the label. */
  detail: string;
  /** false: shown but cannot be picked (browsertodo AI while signed out). */
  enabled: boolean;
}

export interface SettingsView {
  signedIn: boolean;
  options: BrainOption[];
  /** Under Auto: which brain it would pick right now. */
  autoPick: { text: string; tone: Tone };
  /** Under browsertodo AI when signed in: plan, credit, what to buy. */
  hosted: HostedAccount | null;
  /** Signed out: the "Log in to use browsertodo AI" action under browsertodo AI. */
  showHostedSignIn: boolean;
  /** The chosen brain cannot run right now: why, and what happens instead. */
  brainProblem: string | null;
  showApiKey: boolean;
  /** Claude API selected without a key. */
  apiKeyMissing: boolean;
  showHelper: boolean;
  showModel: boolean;
  model: ModelChoice;
  showJevFields: boolean;
  /** Where Jev's key comes from, when that is not obvious. */
  jevNote: string | null;
  showCloudFields: boolean;
}

export interface ModelChoice {
  /** The select's value: a known model id, or "custom". */
  selected: string;
  /** The custom model id field is shown. */
  custom: boolean;
  /** One line under the model select. */
  hint: string;
}

export const CUSTOM_MODEL = "custom";

/** The account as the brain resolver sees it (mirrors AccountService.brainAccount). */
export function brainAccount(a: AccountView | null | undefined): { signedIn: boolean; hostedUsable: boolean; outOfCredit: boolean } {
  if (!a?.signedIn) return { signedIn: false, hostedUsable: false, outOfCredit: false };
  const credit = a.credit?.totalCents ?? 0;
  const hostedUsable = (credit > 0 && !a.outOfCredit) || isPaidActive(a.plan);
  return { signedIn: true, hostedUsable, outOfCredit: !!a.outOfCredit || (!!a.credit && credit <= 0) };
}

function hostedAccount(a: AccountView): HostedAccount {
  const paid = isPaidActive(a.plan);
  const cents = a.credit?.totalCents;
  const noCredit = !!a.outOfCredit || cents === 0;
  const credit = cents === undefined ? (a.outOfCredit ? "No AI credit left" : "Credit not loaded") : noCredit ? "No AI credit left" : `${centsLabel(cents)} AI credit left`;
  const canBuy = a.stripeConfigured !== false;
  let action: HostedAccount["action"] = null;
  if (canBuy && !paid) action = { kind: "get-plan", label: "Get a plan" };
  else if (canBuy && noCredit) action = { kind: "top-up", label: "Top up" };
  return { plan: `${planName(a.plan?.id)} plan`, credit, tone: noCredit ? "warn" : "", action };
}

function modelChoice(draft: Draft): ModelChoice {
  const id = draft.anthropicModel.trim();
  const known = KNOWN_MODELS.some((m) => m.id === id);
  const selected = known ? id : CUSTOM_MODEL;
  let hint = "Used by every brain. You can also switch it from the side panel.";
  if (draft.brain === "browsertodo") {
    hint = known || !id ? "browsertodo AI runs this model." : "browsertodo AI does not offer this model, so it runs Sonnet 5.";
  } else if (draft.brain === "auto" && !known && id) {
    hint = "If Auto picks browsertodo AI, it runs Sonnet 5 instead: it does not offer this model.";
  }
  return { selected, custom: selected === CUSTOM_MODEL, hint };
}

export function settingsView(input: ViewInput): SettingsView {
  const { settings, draft, brain } = input;
  const account = input.account ?? null;
  const acct = brainAccount(account);
  const signedIn = acct.signedIn;

  // What Auto would pick right now: the runner's own resolver, with brain = auto.
  const auto = resolveBrain({
    settings: { ...settings, brain: "auto" },
    helper: brain.helper,
    helperError: brain.helperError ?? null,
    account: acct,
  });
  const autoPick = auto.effective
    ? { text: `Right now this picks ${auto.effective === "claude-code" ? "Local Claude Code" : brainLabel(auto.effective)}.`, tone: "ok" as Tone }
    : { text: "Right now nothing is set up: log in, add a Claude API key or connect the helper.", tone: "bad" as Tone };

  // The chosen brain as the runner resolves it (same function, the draft's choice).
  const chosen = resolveBrain({
    settings: { ...settings, brain: draft.brain },
    helper: brain.helper,
    helperError: brain.helperError ?? null,
    account: acct,
  });
  let brainProblem: string | null = null;
  if (draft.brain === "browsertodo" && !signedIn) {
    brainProblem = "browsertodo AI is selected but you are logged out, so no tasks run. Log in, or pick another brain.";
  } else if (draft.brain === "browsertodo" && !chosen.effective) {
    brainProblem = "Out of AI credit, so no tasks run on browsertodo AI. Top up, get a plan, or pick another brain.";
  }
  // Local Claude Code and the Claude API say what is missing in their own inline sections.

  const options: BrainOption[] = [
    { value: "auto", label: "Auto", detail: "Picks the best brain that works right now.", enabled: true },
    {
      value: "browsertodo",
      label: "browsertodo AI",
      detail: signedIn ? "Hosted by browsertodo, paid from your AI credit. Nothing to set up." : "Hosted by browsertodo. Needs an account.",
      enabled: signedIn,
    },
    { value: "claude-code", label: "Local Claude Code", detail: "Your Claude subscription, through the helper app.", enabled: true },
    { value: "claude-api", label: "Claude API", detail: "Your Anthropic API key, straight from Chrome.", enabled: true },
  ];

  // Jev: the hosted AI brings its own; else a key here, else the helper's own key.
  let jevNote: string | null = null;
  const hostedRuns = brain.effective === "browsertodo";
  if (hostedRuns) jevNote = "browsertodo AI includes Jev, so it needs no key.";
  else if (!settings.jevApiKey && brain.helper?.jevAvailable) {
    jevNote = "With local Claude Code the helper uses its own Jev key (TYPESAFE_API_KEY in its .env file). A key entered here takes priority and also works with the Claude API.";
  }

  return {
    signedIn,
    options,
    autoPick,
    hosted: signedIn && account ? hostedAccount(account) : null,
    showHostedSignIn: !signedIn,
    brainProblem,
    showApiKey: draft.brain === "claude-api",
    apiKeyMissing: draft.brain === "claude-api" && !settings.anthropicApiKey,
    showHelper: draft.brain === "claude-code",
    // Every brain runs the chosen model (the hosted AI only its own list).
    showModel: true,
    model: modelChoice(draft),
    showJevFields: draft.jevEnabled,
    jevNote: draft.jevEnabled ? jevNote : null,
    showCloudFields: draft.cloudEnabled,
  };
}

/** Models the select offers: the side panel's list, marking the ones browsertodo AI does not run. */
export function modelOptions(): { id: string; label: string }[] {
  return KNOWN_MODELS.map((m) => ({ id: m.id, label: HOSTED_MODELS.includes(m.id) ? m.label : `${m.label} (not on browsertodo AI)` }));
}

// ---------------------------------------------------------------- form values and validation

export const NUMBER_FIELDS = [
  "jevThreshold",
  "intervalMinutes",
  "delayMinSec",
  "delayMaxSec",
  "maxToolCalls",
  "maxTaskMinutes",
  "maxParallelTasks",
  "retryAfterMinutes",
  "pauseRetryMinutes",
  "maxConsecutiveFailures",
] as const satisfies readonly (keyof ExtensionSettings)[];
export const TEXT_FIELDS = ["anthropicModel", "apiBase", "accountApiBase"] as const satisfies readonly (keyof ExtensionSettings)[];
export const BOOL_FIELDS = ["jevEnabled", "cloudEnabled"] as const satisfies readonly (keyof ExtensionSettings)[];
export type NumberField = (typeof NUMBER_FIELDS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];
export type BoolField = (typeof BOOL_FIELDS)[number];

/** The allowed range of each number (the settings schema's bounds). */
export const NUMBER_RULES: Record<NumberField, { min: number; max: number; int: boolean }> = {
  jevThreshold: { min: 0, max: 1, int: false },
  intervalMinutes: { min: 1, max: 1440, int: false },
  delayMinSec: { min: 0, max: 3600, int: false },
  delayMaxSec: { min: 0, max: 3600, int: false },
  maxToolCalls: { min: 5, max: 500, int: true },
  maxTaskMinutes: { min: 1, max: 120, int: false },
  maxParallelTasks: { min: 1, max: 4, int: true },
  retryAfterMinutes: { min: 1, max: 1440, int: true },
  pauseRetryMinutes: { min: 1, max: 1440, int: true },
  maxConsecutiveFailures: { min: 0, max: 100, int: true },
};

/** Raw values as the form holds them. */
export type FormValues = { brain: BrainMode } & Record<NumberField | TextField, string> & Record<BoolField, boolean>;

/** Settings -> what the form shows. */
export function formValues(s: ExtensionSettings): FormValues {
  const out: Record<string, unknown> = { brain: s.brain };
  for (const k of NUMBER_FIELDS) out[k] = String(s[k]);
  for (const k of TEXT_FIELDS) out[k] = s[k];
  for (const k of BOOL_FIELDS) out[k] = s[k];
  return out as FormValues;
}

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/** Plain-language problems, by field. Fields with a problem are not saved. */
export function validateForm(v: FormValues): Partial<Record<NumberField | TextField, string>> {
  const errors: Partial<Record<NumberField | TextField, string>> = {};
  for (const k of NUMBER_FIELDS) {
    const raw = v[k].trim();
    const r = NUMBER_RULES[k];
    const range = `${r.min} to ${r.max}`;
    if (raw === "") errors[k] = `Enter a number from ${range}.`;
    else if (!Number.isFinite(Number(raw))) errors[k] = `Enter a number from ${range}.`;
    else if (r.int && !Number.isInteger(Number(raw))) errors[k] = `Enter a whole number from ${range}.`;
    else if (Number(raw) < r.min || Number(raw) > r.max) errors[k] = `Enter a number from ${range}.`;
  }
  if (!errors.delayMinSec && !errors.delayMaxSec && Number(v.delayMaxSec) < Number(v.delayMinSec)) {
    errors.delayMaxSec = "Make this at least the shortest pause.";
  }
  if (!v.anthropicModel.trim()) errors.anthropicModel = "Enter a model id, for example claude-sonnet-5.";
  else if (/\s/.test(v.anthropicModel.trim())) errors.anthropicModel = "A model id has no spaces.";
  if (!v.accountApiBase.trim()) errors.accountApiBase = "Enter the account server's address.";
  else if (!isHttpUrl(v.accountApiBase.trim())) errors.accountApiBase = "Enter a full address starting with https://";
  if (v.apiBase.trim() && !isHttpUrl(v.apiBase.trim())) errors.apiBase = "Enter a full address starting with https://";
  return errors;
}

/** Form values -> settings, leaving out fields with a problem (they keep their saved value). */
export function parseForm(v: FormValues): Partial<Omit<ExtensionSettings, "anthropicApiKey" | "jevApiKey" | "runnerKey">> {
  const errors = validateForm(v);
  const out: Record<string, unknown> = { brain: v.brain };
  for (const k of NUMBER_FIELDS) if (!errors[k]) out[k] = Number(v[k].trim());
  for (const k of TEXT_FIELDS) {
    if (errors[k]) continue;
    const t = v[k].trim();
    out[k] = k === "apiBase" || k === "accountApiBase" ? t.replace(/\/+$/, "") : t;
  }
  for (const k of BOOL_FIELDS) out[k] = v[k];
  return out;
}
