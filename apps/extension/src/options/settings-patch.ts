/** Pure helpers for the options page: building settings.save patches and status text. */
import type { ExtensionSettings, HelperInfo } from "@browsertodo/shared";

export const SECRET_KEYS = ["anthropicApiKey", "jevApiKey", "runnerKey"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** What the user did with a masked key field. */
export type SecretEdit = { mode: "keep" } | { mode: "clear" } | { mode: "set"; value: string };

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

/**
 * Only the fields that differ from the saved settings. Secrets: omitted =
 * keep, "" = clear, a value = set. A "set" edit with blank text means keep.
 */
export function buildSettingsPatch(
  saved: ExtensionSettings,
  form: Partial<Omit<ExtensionSettings, SecretKey>>,
  secrets: Partial<Record<SecretKey, SecretEdit>>,
): Partial<ExtensionSettings> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || isSecretKey(key)) continue;
    if (value !== saved[key as keyof ExtensionSettings]) patch[key] = value;
  }
  for (const key of SECRET_KEYS) {
    const edit = secrets[key];
    if (!edit || edit.mode === "keep") continue;
    if (edit.mode === "clear") {
      if (saved[key]) patch[key] = "";
    } else if (edit.value.trim()) {
      patch[key] = edit.value.trim();
    }
  }
  return patch as Partial<ExtensionSettings>;
}

/** Number input value -> number, or undefined when blank or not a number. */
export function parseNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Non-secret fields whose saved value differs from what was sent (clamped or rejected). */
export function adjustedFields(patch: Partial<ExtensionSettings>, saved: ExtensionSettings): (keyof ExtensionSettings)[] {
  return (Object.keys(patch) as (keyof ExtensionSettings)[]).filter(
    (k) => !isSecretKey(k) && patch[k] !== saved[k],
  );
}

export interface HelperStatus {
  tone: "ok" | "warn" | "bad" | "muted";
  headline: string;
  details: string[];
}

export function helperStatus(helper: HelperInfo | null, helperError?: string): HelperStatus {
  if (!helper) {
    return {
      tone: helperError ? "bad" : "muted",
      headline: "Helper not connected",
      details: helperError ? [helperError] : ["Needed only for local Claude Code."],
    };
  }
  const details: string[] = [];
  details.push(helper.claudePath ? `Claude Code: ${helper.claudePath}` : "Claude Code not found on this computer");
  const st = helper.selfTest;
  if (st) details.push(st.ok ? `Self-test passed (${(st.ms / 1000).toFixed(1)} s)` : `Self-test failed: ${st.error ?? "unknown error"}`);
  else if (helper.claudePath) details.push("Self-test not run yet");
  const tone = !helper.claudePath || (st && !st.ok) ? "warn" : "ok";
  return { tone, headline: `Helper connected · v${helper.version}`, details };
}
