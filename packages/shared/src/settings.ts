import { z } from "zod";

export const BrainMode = z.enum(["auto", "claude-code", "claude-api"]);
export type BrainMode = z.infer<typeof BrainMode>;

/** Extension settings stored in chrome.storage.local under "settings". */
export const ExtensionSettings = z.object({
  /**
   * Which agent runs tasks. auto: local Claude Code when the helper is
   * connected and Claude Code was found, otherwise the Claude API key.
   */
  brain: BrainMode.default("auto"),
  anthropicApiKey: z.string().default(""),
  anthropicModel: z.string().default("claude-sonnet-5"),
  /** Jev speeds up single steps. Used only when a key is set and jevEnabled. */
  jevApiKey: z.string().default(""),
  /** Cloud task queue. Off by default; local tasks always work. */
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
  return s;
}

/** Random delay in ms between tasks, uniform in [min, max] seconds. */
export function pickDelayMs(s: Pick<ExtensionSettings, "delayMinSec" | "delayMaxSec">, rand = Math.random): number {
  const min = Math.min(s.delayMinSec, s.delayMaxSec);
  const max = Math.max(s.delayMinSec, s.delayMaxSec);
  return Math.round((min + rand() * (max - min)) * 1000);
}

/** Settings with secrets replaced by "set"/"" markers, safe to show or log. */
export function redactSettings(s: ExtensionSettings): ExtensionSettings {
  const mark = (v: string) => (v ? "set" : "");
  return { ...s, anthropicApiKey: mark(s.anthropicApiKey), jevApiKey: mark(s.jevApiKey), runnerKey: mark(s.runnerKey) };
}
