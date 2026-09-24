/**
 * Which brain runs tasks right now (spec "Two brains"):
 * - claude-code: helper connected, Claude Code found, self-test passed.
 * - claude-api: an Anthropic API key is set.
 * - auto: claude-code when usable, otherwise claude-api, otherwise nothing.
 */
import type { BrainKind, ExtensionSettings, HelperInfo } from "@browsertodo/shared";
import type { BrainStatus } from "../ui-protocol.js";

export interface BrainInputs {
  settings: Pick<ExtensionSettings, "brain" | "anthropicApiKey" | "jevApiKey" | "jevEnabled">;
  helper: HelperInfo | null;
  helperError?: string | null;
}

/** Why local Claude Code cannot be used, or null when it can. */
export function claudeCodeProblem(helper: HelperInfo | null, helperError?: string | null): string | null {
  if (!helper) return `Helper not connected${helperError ? `: ${helperError}` : ""}`;
  if (!helper.claudePath) return "Claude Code was not found on this computer";
  if (helper.claudePath === "scripted") return null;
  if (!helper.selfTest) return "Claude Code self-test has not run yet";
  if (!helper.selfTest.ok) return `Claude Code self-test failed${helper.selfTest.error ? `: ${helper.selfTest.error}` : ""}`;
  return null;
}

export function jevActiveFor(brain: BrainKind | null, inputs: BrainInputs): boolean {
  const s = inputs.settings;
  if (!s.jevEnabled || !brain) return false;
  if (s.jevApiKey) return true;
  // The helper can fall back to TYPESAFE_API_KEY from its own environment.
  return brain === "claude-code" && !!inputs.helper?.jevAvailable;
}

export function resolveBrain(inputs: BrainInputs): BrainStatus {
  const { settings, helper } = inputs;
  const hasApiKey = !!settings.anthropicApiKey;
  const ccProblem = claudeCodeProblem(helper, inputs.helperError);
  let effective: BrainKind | null = null;
  let note: string | undefined;
  switch (settings.brain) {
    case "claude-code":
      if (!ccProblem) effective = "claude-code";
      else note = ccProblem;
      break;
    case "claude-api":
      if (hasApiKey) effective = "claude-api";
      else note = "No Claude API key set. Add one in the options page.";
      break;
    default:
      if (!ccProblem) effective = "claude-code";
      else if (hasApiKey) {
        effective = "claude-api";
        note = `Using the Claude API key (${ccProblem})`;
      } else {
        note = `No brain available: set a Claude API key, or install the helper and Claude Code (${ccProblem})`;
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
