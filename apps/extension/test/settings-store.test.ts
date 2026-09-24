import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@browsertodo/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import {
  ALARM_NAME,
  ensureAlarm,
  getRunnerId,
  handleStorageChange,
  loadSettings,
  saveSettings,
} from "../src/settings-store.js";

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

describe("settings store", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("parses stored values and repairs invalid ones", async () => {
    chrome.storage.local.data.settings = { apiBase: "https://api.example.com///", intervalMinutes: -3, delayMinSec: 5, delayMaxSec: 1 };
    const s = await loadSettings();
    expect(s.apiBase).toBe("https://api.example.com");
    expect(s.intervalMinutes).toBe(15);
    expect(s.delayMinSec).toBe(5);
    expect(s.delayMaxSec).toBe(5);
  });

  it("saveSettings merges a partial update and stores parsed values", async () => {
    await saveSettings({ runnerKey: "bt_x" });
    await saveSettings({ intervalMinutes: 30 });
    const stored = chrome.storage.local.data.settings as Record<string, unknown>;
    expect(stored.runnerKey).toBe("bt_x");
    expect(stored.intervalMinutes).toBe(30);
    expect(stored.delayMinSec).toBe(60);
  });

  it("persists one random runnerId", async () => {
    const a = await getRunnerId();
    const b = await getRunnerId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
  });
});

describe("alarm scheduling", () => {
  it("ensureAlarm creates the alarm with the configured interval", async () => {
    await chrome.storage.local.set({ settings: { intervalMinutes: 20 } });
    await ensureAlarm();
    expect(chrome.alarms.all.get(ALARM_NAME)?.periodInMinutes).toBe(20);
  });

  it("ensureAlarm keeps an alarm that already matches", async () => {
    await ensureAlarm();
    const before = chrome.alarms.all.get(ALARM_NAME);
    await ensureAlarm();
    expect(chrome.alarms.all.get(ALARM_NAME)).toBe(before);
  });

  it("reschedules when intervalMinutes changes", async () => {
    await ensureAlarm();
    await saveSettings({ intervalMinutes: 45 });
    // saveSettings fires storage.onChanged; the background forwards it here.
    await handleStorageChange({ settings: { oldValue: { intervalMinutes: 15 }, newValue: { intervalMinutes: 45 } } }, "local");
    expect(chrome.alarms.all.get(ALARM_NAME)?.periodInMinutes).toBe(45);
  });

  it("ignores unrelated changes", async () => {
    await ensureAlarm();
    const before = chrome.alarms.all.get(ALARM_NAME);
    await handleStorageChange({ settings: { oldValue: { intervalMinutes: 15 }, newValue: { intervalMinutes: 15, runnerKey: "k" } } }, "local");
    await handleStorageChange({ other: { newValue: 1 } }, "local");
    await handleStorageChange({ settings: { newValue: { intervalMinutes: 99 } } }, "session");
    expect(chrome.alarms.all.get(ALARM_NAME)).toBe(before);
  });
});
