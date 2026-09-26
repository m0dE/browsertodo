import { z } from "zod";
import { DEFAULT_MODEL } from "./models.js";

/** The browsertodo account server. */
export const ACCOUNT_API_BASE = "https://app.browsertodo.com";
/** Earlier defaults of accountApiBase; a saved one is moved to ACCOUNT_API_BASE. (The old address still answers.) */
export const PREVIOUS_ACCOUNT_API_BASES: readonly string[] = ["https://browsertodo-api.jaeyun.workers.dev"];

/**
 * An account server address as it is kept: trimmed, without a trailing
 * slash, and an earlier default (PREVIOUS_ACCOUNT_API_BASES) moved to
 * ACCOUNT_API_BASE. Stored settings and the session issued by that server
 * both go through it, so they keep naming the same server.
 */
export function currentAccountApiBase(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return PREVIOUS_ACCOUNT_API_BASES.includes(u) ? ACCOUNT_API_BASE : u;
}

export const BrainMode = z.enum(["auto", "claude-code", "claude-api", "browsertodo"]);
export type BrainMode = z.infer<typeof BrainMode>;

/** Extension settings stored in chrome.storage.local under "settings". */
export const ExtensionSettings = z.object({
  /**
   * Which agent runs tasks. auto: browsertodo AI when signed in with usage
   * credit or an active paid plan, else local Claude Code when the helper is
   * connected and Claude Code was found, otherwise the Claude API key.
   */
  brain: BrainMode.default("auto"),
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default(DEFAULT_MODEL),
  /** Jev speeds up single steps. Used only when a key is set and jevEnabled. */
  jevApiKey: z.string().default(""),
  /**
   * The browsertodo account server (Google sign-in, the account's TODO list,
   * billing and the hosted AI). Self-hosters point it at their own API.
   */
  accountApiBase: z.string().default(ACCOUNT_API_BASE),
  /** Cloud task queue with a runner key (self-hosters). Off by default; local tasks always work. */
  cloudEnabled: z.boolean().default(false),
  apiBase: z.string().default(""),
  runnerKey: z.string().default(""),
  /** Pause scheduled runs after this many failed tasks in a row. 0 disables. */
  maxConsecutiveFailures: z.number().int().min(0).max(100).default(3),
  /** Minutes before a task that hit a temporary problem is retried. */
  retryAfterMinutes: z.number().int().min(1).max(24 * 60).default(10),
  intervalMinutes: z.number().min(1).max(24 * 60).default(15),
  delayMinSec: z.number().min(0).max(3600).default(60),
  delayMaxSec: z.number().min(0).max(3600).default(180),
  maxToolCalls: z.number().int().min(5).max(500).default(60),
  maxTaskMinutes: z.number().min(1).max(120).default(10),
  /**
   * Due tasks that may run at the same time, each in its own tab (tasks that
   * act as an X account still run one at a time). One-off runs from the side
   * panel run beside them.
   */
  maxParallelTasks: z.number().int().min(1).max(4).default(2),
  jevEnabled: z.boolean().default(true),
  jevThreshold: z.number().min(0).max(1).default(0.8),
  /** When true, scheduled runs are skipped. */
  paused: z.boolean().default(false),
  /** Minutes before a paused task can be claimed again. */
  pauseRetryMinutes: z.number().int().min(1).max(24 * 60).default(15),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettings>;

export const DEFAULT_SETTINGS: ExtensionSettings = ExtensionSettings.parse({});

/** Parse stored settings, filling defaults for missing or invalid fields. */
export function parseSettings(raw: unknown): ExtensionSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ExtensionSettings)[]) {
    const field = ExtensionSettings.shape[key];
    const parsed = field.safeParse(obj[key]);
    if (parsed.success && obj[key] !== undefined) out[key] = parsed.data;
  }
  const s = out as ExtensionSettings;
  if (s.delayMaxSec < s.delayMinSec) s.delayMaxSec = s.delayMinSec;
  s.apiBase = s.apiBase.replace(/\/+$/, "");
  // Installs saved with an earlier default follow the default to its new address.
  s.accountApiBase = currentAccountApiBase(s.accountApiBase);
  return s;
}

/** Random delay in ms between tasks, uniform in [min, max] seconds. */
export function pickDelayMs(s: Pick<ExtensionSettings, "delayMinSec" | "delayMaxSec">, rand = Math.random): number {
  const min = Math.min(s.delayMinSec, s.delayMaxSec);
  const max = Math.max(s.delayMinSec, s.delayMaxSec);
  return Math.round((min + rand() * (max - min)) * 1000);
}

/** Settings that hold secrets: never shown or logged, only marked as set (redactSettings). */
export const SECRET_SETTING_KEYS = ["anthropicApiKey", "jevApiKey", "runnerKey"] as const satisfies readonly (keyof ExtensionSettings)[];
/** What a secret that is set reads as in redacted settings ("" when it is not set). */
export const REDACTED = "set";

/** Settings with secrets replaced by REDACTED/"" markers, safe to show or log. */
export function redactSettings(s: ExtensionSettings): ExtensionSettings {
  const out = { ...s };
  for (const key of SECRET_SETTING_KEYS) out[key] = s[key] ? REDACTED : "";
  return out;
}
