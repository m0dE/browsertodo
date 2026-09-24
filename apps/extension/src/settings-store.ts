import { parseSettings, type ExtensionSettings } from "@browsertodo/shared";

export const ALARM_NAME = "browsertodo-run";
const SETTINGS_KEY = "settings";
const RUNNER_ID_KEY = "runnerId";

export async function loadSettings(): Promise<ExtensionSettings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next = parseSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Stable random runner ID, created on first use. */
export async function getRunnerId(): Promise<string> {
  const got = await chrome.storage.local.get(RUNNER_ID_KEY);
  const existing = got[RUNNER_ID_KEY];
  if (typeof existing === "string" && existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [RUNNER_ID_KEY]: id });
  return id;
}

export async function scheduleAlarm(intervalMinutes: number): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes, delayInMinutes: intervalMinutes });
}

/** On install and startup: create the alarm unless one with the right period exists. */
export async function ensureAlarm(): Promise<void> {
  const settings = await loadSettings();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (alarm && alarm.periodInMinutes === settings.intervalMinutes) return;
  await scheduleAlarm(settings.intervalMinutes);
}

/** chrome.storage.onChanged handler: reschedule when the interval changes. */
export async function handleStorageChange(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
): Promise<void> {
  const change = changes[SETTINGS_KEY];
  if (areaName !== "local" || !change) return;
  const before = parseSettings(change.oldValue).intervalMinutes;
  const after = parseSettings(change.newValue).intervalMinutes;
  if (before !== after || change.oldValue === undefined) await scheduleAlarm(after);
}
