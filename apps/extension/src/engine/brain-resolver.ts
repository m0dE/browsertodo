/**
 * Which brain runs tasks right now:
 * - browsertodo: the hosted "browsertodo AI"; signed in with usage credit left
 *   or an active paid plan.
 * - claude-code: helper connected, Claude Code found, self-test passed.
 * - claude-api: an Anthropic API key is set.
 * - auto: browsertodo when usable, else claude-code, else claude-api, else nothing.
 */
import type { BrainKind, ExtensionSettings, HelperInfo } from "@browsertodo/shared";
import type { BrainStatus } from "../ui-protocol.js";

export interface BrainInputs {
  settings: Pick<ExtensionSettings, "brain" | "anthropicApiKey" | "jevApiKey" | "jevEnabled">;
  helper: HelperInfo | null;
  helperError?: string | null;
  /** The browsertodo account (null or absent: signed out). */
  account?: { signedIn: boolean; hostedUsable: boolean; outOfCredit?: boolean } | null;
}

export const HOSTED_SIGN_IN = "Sign in to use browsertodo AI";
export const HOSTED_NO_CREDIT = "Out of usage credit: subscribe or top up to use browsertodo AI";

/** Why the hosted AI cannot be used, or null when it can. */
function hostedProblem(account: BrainInputs["account"]): string | null {
  if (!account?.signedIn) return HOSTED_SIGN_IN;
  if (!account.hostedUsable) return HOSTED_NO_CREDIT;
  return null;
}

/** Why local Claude Code cannot be used, or null when it can. */
function claudeCodeProblem(helper: HelperInfo | null, helperError?: string | null): string | null {
  if (!helper) return `Helper not connected${helperError ? `: ${helperError}` : ""}`;
  if (!helper.claudePath) return "Claude Code was not found on this computer";
  if (helper.claudePath === "scripted") return null;
  if (!helper.selfTest) return "Claude Code self-test has not run yet";
  if (!helper.selfTest.ok) return `Claude Code self-test failed${helper.selfTest.error ? `: ${helper.selfTest.error}` : ""}`;
  return null;
}

function jevActiveFor(brain: BrainKind | null, inputs: BrainInputs): boolean {
  const s = inputs.settings;
  if (!s.jevEnabled || !brain) return false;
  // The hosted AI brings its own Jev (/v1/ai/jev).
  if (brain === "browsertodo") return true;
  if (s.jevApiKey) return true;
  // The helper can fall back to TYPESAFE_API_KEY from its own environment.
  return brain === "claude-code" && !!inputs.helper?.jevAvailable;
}

export function resolveBrain(inputs: BrainInputs): BrainStatus {
  const { settings, helper } = inputs;
  const hasApiKey = !!settings.anthropicApiKey;
  const ccProblem = claudeCodeProblem(helper, inputs.helperError);
  const hosted = hostedProblem(inputs.account);
  let effective: BrainKind | null = null;
  let note: string | undefined;
  switch (settings.brain) {
    case "browsertodo":
      if (!hosted) effective = "browsertodo";
      else note = hosted;
      break;
    case "claude-code":
      if (!ccProblem) effective = "claude-code";
      else note = ccProblem;
      break;
    case "claude-api":
      if (hasApiKey) effective = "claude-api";
      else note = "No Claude API key set. Add one in the options page.";
      break;
    default:
      if (!hosted) effective = "browsertodo";
      else if (!ccProblem) effective = "claude-code";
      else if (hasApiKey) {
        effective = "claude-api";
        note = `Using the Claude API key (${ccProblem})`;
      } else if (inputs.account?.signedIn) {
        note = `${HOSTED_NO_CREDIT}, or set a Claude API key, or install the helper and Claude Code (${ccProblem})`;
      } else {
        note = `No brain available: sign in for browsertodo AI, set a Claude API key, or install the helper and Claude Code (${ccProblem})`;
      }
  }
  const status: BrainStatus = {
    effective,
    helper,
    hasApiKey,
    jevActive: jevActiveFor(effective, inputs),
  };
  if (note) status.note = note;
  if (!helper && inputs.helperError) status.helperError = inputs.helperError;
  return status;
}
