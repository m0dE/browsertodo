/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import * as core from "@browsertodo/core";
import type { ExtensionSettings } from "@browsertodo/shared";
import { AgentWindow } from "./agent-window.js";
import { ApiClient } from "./api-client.js";
import { Cdp } from "./cdp.js";
import { Driver } from "./driver.js";
import { resolveBrain } from "./engine/brain-resolver.js";
import { ApiBrain, ClaudeCodeBrain } from "./engine/brains.js";
import { createBrowserCaller, registerBrowserHandlers } from "./engine/browser-caller.js";
import { IdbKvDb } from "./engine/kv.js";
import { LocalStore } from "./engine/local-store.js";
import { MediaFiles } from "./engine/media-files.js";
import { Runner, type ResolvedBrain } from "./engine/runner.js";
import { SessionStore } from "./engine/sessions.js";
import { testClaude, testCloud, testJev } from "./engine/settings-tests.js";
import { TerminalRelay } from "./engine/terminal.js";
import { UiHub, UiRouter, type ExtraRequest } from "./engine/ui-router.js";
import { HelperLink } from "./helper-link.js";
import { notify } from "./notify.js";
import { ALARM_NAME, ensureAlarm, getRunnerId, handleStorageChange, loadSettings, saveSettings, saveSettingsPatch } from "./settings-store.js";
import type { UiRequest } from "./ui-protocol.js";
import { Vault } from "./vault.js";

// MV3 forbids eval; stop zod from probing for it.
z.config({ jitless: true });

/** One-shot alarm for the next local task that becomes due (notBefore / retryAfter). */
const DUE_ALARM = "browsertodo-due";
/** Do not re-spawn the helper for every side panel open. */
const HELPER_AUTOCONNECT_MS = 60_000;

const cdp = new Cdp();
const agentWindow = new AgentWindow();
const driver = new Driver(cdp, agentWindow);
const vault = new Vault();
const db = new IdbKvDb();
const localStore = new LocalStore({ db });
const sessions = new SessionStore(db);
const browser = createBrowserCaller(driver, vault);
const helper = new HelperLink({ registerHandlers: (peer) => registerBrowserHandlers(peer, driver, vault) });
const mediaFiles = new MediaFiles();
const claudeCodeBrain = new ClaudeCodeBrain(helper);
const apiBrain = new ApiBrain({ core, browser });

function brainStatus(settings: ExtensionSettings) {
  return resolveBrain({ settings, helper: helper.info, helperError: helper.lastError });
}

async function resolveForRun(settings: ExtensionSettings): Promise<ResolvedBrain> {
  if (settings.brain !== "claude-api" && !helper.connected) await helper.connect().catch(() => undefined);
  const status = brainStatus(settings);
  const brain = status.effective === "claude-code" ? claudeCodeBrain : status.effective === "claude-api" ? apiBrain : null;
  return { brain, status };
}

const createApi = (s: ExtensionSettings) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey });

let hub: UiHub;

const runner = new Runner({
  loadSettings,
  saveSettings,
  getRunnerId,
  createApi,
  localStore,
  sessions,
  media: mediaFiles,
  resolveBrain: resolveForRun,
  core,
  browser,
  prepareTab: async () => {
    cdp.reset();
    await driver.ready();
  },
  isAgentTab: (tabId) => agentWindow.isAgentTab(tabId),
  screenshot: () => driver.screenshot(),
  notify,
  keepAlive: () => chrome.runtime.getPlatformInfo(),
  onStateChange: () => hub?.pushState(),
  log: (m) => console.log("[browsertodo]", m),
});
cdp.onUserCancel = () => runner.onDebuggerCanceled();

const terminal = new TerminalRelay(helper, {
  data: (terminalId, data) => hub.push({ type: "terminal.data", terminalId, data }),
  exit: (terminalId, exitCode) => hub.push({ type: "terminal.exit", terminalId, exitCode }),
  changed: () => hub.pushState(),
});

async function nextRunAt(): Promise<string | undefined> {
  const settings = await loadSettings();
  if (settings.paused) return undefined;
  const times = (await Promise.all([chrome.alarms.get(ALARM_NAME), chrome.alarms.get(DUE_ALARM)]))
    .map((a) => a?.scheduledTime)
    .filter((t): t is number => typeof t === "number");
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

async function scheduleDueAlarm(): Promise<void> {
  const next = await localStore.nextWakeAt();
  if (!next) {
    await chrome.alarms.clear(DUE_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(DUE_ALARM);
  if (existing && Math.abs(existing.scheduledTime - next.getTime()) < 1000) return;
  await chrome.alarms.create(DUE_ALARM, { when: Math.max(next.getTime(), Date.now() + 1000) });
}

const router = new UiRouter({
  loadSettings,
  saveSettingsPatch,
  runner,
  localStore,
  sessions,
  terminal,
  helper,
  brainStatus,
  nextRunAt,
  testClaude: (s) => testClaude(s),
  testJev: (s) => testJev(s, core),
  testCloud: (s) => testCloud(s, (x) => createApi(x).check()),
  vault,
});
hub = new UiHub(() => router.getState());

sessions.subscribe({ onEvent: (e) => hub.event(e), onSession: (s) => hub.session(s) });
localStore.onChange(() => {
  hub.push({ type: "tasks.changed" });
  hub.pushState();
  void scheduleDueAlarm().catch(() => {});
});
helper.onInfo(() => hub.pushState());

let lastAutoConnect = 0;
function maybeConnectHelper(): void {
  if (helper.connected || Date.now() - lastAutoConnect < HELPER_AUTOCONNECT_MS) return;
  lastAutoConnect = Date.now();
  void helper
    .connect()
    .catch(() => undefined)
    .finally(() => hub.pushState());
}

function onStart(): void {
  void ensureAlarm();
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void runner.recover().catch(() => {});
  void scheduleDueAlarm().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => onStart());
chrome.runtime.onStartup.addListener(() => onStart());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === DUE_ALARM) void runner.runDue("alarm");
});
chrome.storage.onChanged.addListener((changes, area) => {
  void handleStorageChange(changes, area);
  if (area === "local" && changes.settings) hub.pushState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => void runner.onTabUpdated(tabId, changeInfo));
chrome.debugger.onDetach.addListener((source, reason) => cdp.handleDetach(source, String(reason)));
chrome.runtime.onMessage.addListener((msg: UiRequest | ExtraRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof (msg as { type?: unknown }).type !== "string") return false;
  void router.handle(msg).then(sendResponse);
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id && port.sender.id !== chrome.runtime.id) return;
  if (hub.attach(port)) maybeConnectHelper();
});

// Every worker start (not only install/startup): alarms, side panel behavior, crash recovery.
onStart();

// Test hook for the Playwright smoke and e2e suites (service worker scope only).
(globalThis as unknown as { __browsertodo: unknown }).__browsertodo = {
  driver,
  runner,
  localStore,
  sessions,
  helper,
  settings: { load: loadSettings, save: saveSettingsPatch },
  router,
  terminal,
  media: mediaFiles,
  vault,
  cdp,
  agentWindow,
  scheduleDueAlarm,
};
