import { z } from "zod";

/** Extension settings stored in chrome.storage.local under "settings". */
export const ExtensionSettings = z.object({
  apiBase: z.string().default(""),
  runnerKey: z.string().default(""),
  intervalMinutes: z.number().min(1).max(24 * 60).default(15),
  delayMinSec: z.number().min(0).max(3600).default(60),
  delayMaxSec: z.number().min(0).max(3600).default(180),
  maxToolCalls: z.number().int().min(5).max(500).default(60),
  maxTaskMinutes: z.number().min(1).max(120).default(10),
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
  return s;
}

/** Random delay in ms between tasks, uniform in [min, max] seconds. */
export function pickDelayMs(s: Pick<ExtensionSettings, "delayMinSec" | "delayMaxSec">, rand = Math.random): number {
  const min = Math.min(s.delayMinSec, s.delayMaxSec);
  const max = Math.max(s.delayMinSec, s.delayMaxSec);
  return Math.round((min + rand() * (max - min)) * 1000);
}
