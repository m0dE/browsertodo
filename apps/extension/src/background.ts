/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import * as core from "@browsertodo/core";
import type { ExtensionSettings } from "@browsertodo/shared";
import { AccountService, browserTimeZone } from "./account/account.js";
import { AccountTodo, LocalTodo, type TodoSource } from "./account/todo-source.js";
import { AgentSlots } from "./agent-slots.js";
import { ApiClient } from "./api-client.js";
import { Cdp } from "./cdp.js";
import { GOOGLE_CLIENT_ID } from "./build-config.js";
import { ApiBrain } from "./engine/api-brain.js";
import { hostedBackend } from "./engine/hosted-brain.js";
import { resolveBrain } from "./engine/brain-resolver.js";
import { registerBrowserHandlers } from "./engine/browser-caller.js";
import { ClaudeCodeBrain } from "./engine/claude-code-brain.js";
import { IdbKvDb } from "./engine/kv.js";
import { LocalStore } from "./engine/local-store.js";
import { MediaFiles } from "./engine/media-files.js";
import { Runner, type ResolvedBrain } from "./engine/runner.js";
import { SessionStore } from "./engine/sessions.js";
import { testClaude, testCloud, testJev } from "./engine/settings-tests.js";
import { UiHub } from "./engine/ui-hub.js";
import { UiRouter, type ExtraRequest } from "./engine/ui-router.js";
import { HelperLink } from "./helper-link.js";
import { notify } from "./notify.js";
import { ALARM_NAME, ensureAlarm, getRunnerId, handleStorageChange, loadSettings, saveSettings, saveSettingsPatch } from "./settings-store.js";
import type { UiRequest } from "./ui-protocol.js";
import { TabChats } from "./tab-chats.js";
import { Vault } from "./vault.js";

// MV3 forbids eval; stop zod from probing for it.
z.config({ jitless: true });

/** One-shot alarm for the next local task that becomes due (notBefore / retryAfter). */
const DUE_ALARM = "browsertodo-due";
/** Do not re-spawn the helper for every side panel open. */
const HELPER_AUTOCONNECT_MS = 60_000;

const cdp = new Cdp();
const vault = new Vault();
// Each browser tab has its own chat (tab -> conversation); the side panel follows the active tab.
const tabChats = new TabChats();
// Each running session acts in its own agent tab (slot); slot 0 is the first agent tab.
// Scheduled runs never take over a tab that has a chat.
const slots = new AgentSlots(cdp, vault, async (tabId) => (await tabChats.get(tabId)) !== null);
const { tab: agentTab, driver, browser } = slots.get(0);
const db = new IdbKvDb();
const localStore = new LocalStore({ db });
const sessions = new SessionStore(db);
// Claude Code's browser calls name their task session: they are served in that session's tab.
const helper = new HelperLink({ registerHandlers: (peer) => registerBrowserHandlers(peer, (sessionId) => slots.browserFor(sessionId)) });
const mediaFiles = new MediaFiles();
// Which conversations still have their agent session open shows in the side panel.
const claudeCodeBrain = new ClaudeCodeBrain(helper, { onSessionsChanged: () => hub?.pushState() });
const apiBrain = new ApiBrain({ core, browser, onSessionsChanged: () => hub?.pushState() });

// The browsertodo account: Google sign-in, the account's TODO list, billing and the hosted AI.
const account = new AccountService({
  loadSettings,
  clientId: GOOGLE_CLIENT_ID,
  identity: {
    redirectUri: () => chrome.identity.getRedirectURL(),
    launch: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  },
  localTasks: localStore,
  onChange: () => {
    hub?.pushState();
    hub?.push({ type: "tasks.changed" });
  },
  log: (m) => console.log("[browsertodo] account:", m),
});
void account.load().catch(() => {});
const hostedBrain = new ApiBrain({
  core,
  browser,
  onSessionsChanged: () => hub?.pushState(),
  backend: hostedBackend({
    core,
    session: () => account.session(),
    onOutOfCredit: (topupUrl) => void account.markOutOfCredit(topupUrl).catch(() => {}),
    afterTurn: () => void account.refresh(true).catch(() => {}),
  }),
});

function brainStatus(settings: ExtensionSettings) {
  return resolveBrain({ settings, helper: helper.info, helperError: helper.lastError, account: account.brainAccount() });
}

async function resolveForRun(settings: ExtensionSettings): Promise<ResolvedBrain> {
  await account.load().catch(() => undefined);
  const hostedFirst = account.brainAccount().hostedUsable && settings.brain === "auto";
  if (settings.brain !== "claude-api" && settings.brain !== "browsertodo" && !hostedFirst && !helper.connected) {
    await helper.connect().catch(() => undefined);
  }
  const status = brainStatus(settings);
  const brains = { "claude-code": claudeCodeBrain, "claude-api": apiBrain, browsertodo: hostedBrain } as const;
  const brain = status.effective && status.effective !== "scripted" ? brains[status.effective] : null;
  return { brain, status };
}

/** Next due time among the signed-in account's pending tasks (from the last list), for the due alarm. */
let accountNextDue: number | null = null;
function noteAccountTasks(tasks?: { status: string; notBefore: string | null; retryAfter: string | null }[]): void {
  if (tasks) {
    const times = tasks
      .filter((t) => t.status === "pending" || t.status === "paused")
      .map((t) => Math.max(Date.parse(t.notBefore ?? "") || 0, Date.parse(t.retryAfter ?? "") || 0));
    accountNextDue = times.length ? Math.min(...times) : null;
  } else {
    // A task was added or changed: check soon.
    accountNextDue = Date.now();
  }
  void scheduleDueAlarm().catch(() => {});
}

async function todoSource(): Promise<TodoSource> {
  await account.load();
  if (!account.session()) return new LocalTodo(localStore);
  return new AccountTodo(await account.api(), browserTimeZone(), (tasks) => {
    noteAccountTasks(tasks);
    if (!tasks) hub?.push({ type: "tasks.changed" });
  });
}

const createApi = (s: ExtensionSettings) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey });

let hub: UiHub;

const runner = new Runner({
  loadSettings,
  saveSettings,
  getRunnerId,
  createApi,
  accountApi: () => account.runnerApi(),
  localStore,
  sessions,
  media: mediaFiles,
  resolveBrain: resolveForRun,
  core,
  slots,
  tabChats,
  notify,
  keepAlive: () => chrome.runtime.getPlatformInfo(),
  onStateChange: () => hub?.pushState(),
  log: (m) => console.log("[browsertodo]", m),
});
cdp.onUserCancel = () => runner.onDebuggerCanceled();

async function nextRunAt(): Promise<string | undefined> {
  const settings = await loadSettings();
  if (settings.paused) return undefined;
  const times = (await Promise.all([chrome.alarms.get(ALARM_NAME), chrome.alarms.get(DUE_ALARM)]))
    .map((a) => a?.scheduledTime)
    .filter((t): t is number => typeof t === "number");
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

async function scheduleDueAlarm(): Promise<void> {
  const local = await localStore.nextWakeAt();
  const accountDue = account.session() && accountNextDue !== null ? new Date(accountNextDue) : null;
  const next = local && accountDue ? (local < accountDue ? local : accountDue) : (local ?? accountDue);
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
  showAgent: (sessionId) => slots.show(sessionId ?? runner.running?.sessionId),
  localStore,
  sessions,
  openConversations: () => [...claudeCodeBrain.openSessions(), ...apiBrain.openSessions()],
  helper,
  brainStatus,
  nextRunAt,
  testClaude: (s) => testClaude(s),
  testJev: (s) => testJev(s, core),
  testCloud: (s) => testCloud(s, (x) => createApi(x).check()),
  vault,
  account,
  todo: todoSource,
  tabChats,
  focusTab: async (tabId) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return true;
    } catch {
      return false;
    }
  },
  runningTabs: async () => {
    const out: Record<string, number[]> = {};
    for (const s of runner.runningSessions) {
      const tabs = await slots.tabsOf(s.sessionId);
      if (tabs.length) out[s.sessionId] = tabs;
    }
    return out;
  },
});
hub = new UiHub(() => router.getState());

sessions.subscribe({ onEvent: (e) => hub.event(e), onSession: (s) => hub.session(s) });
localStore.onChange(() => {
  hub.push({ type: "tasks.changed" });
  hub.pushState();
  void scheduleDueAlarm().catch(() => {});
});
helper.onInfo(() => hub.pushState());
tabChats.onChange(() => hub.pushState());

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
  if (alarm.name === DUE_ALARM && accountNextDue !== null && accountNextDue <= Date.now()) accountNextDue = null;
  if (alarm.name === ALARM_NAME || alarm.name === DUE_ALARM) void runner.runDue("alarm");
});
chrome.storage.onChanged.addListener((changes, area) => {
  void handleStorageChange(changes, area);
  if (area === "local" && changes.settings) {
    // The account server URL may have changed: the session belongs to the old one.
    void account.load().then(() => hub.pushState(), () => hub.pushState());
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => void runner.onTabUpdated(tabId, changeInfo));
// A closed tab loses its chat (the session stays in the Activity Log); a turn running there stops.
chrome.tabs.onRemoved.addListener((tabId) => {
  void tabChats
    .unbind(tabId)
    .then((sessionId) => {
      if (sessionId) runner.onChatTabClosed(sessionId);
    })
    .catch(() => {});
});
chrome.debugger.onDetach.addListener((source, reason) => cdp.handleDetach(source, String(reason)));
chrome.runtime.onMessage.addListener((msg: UiRequest | ExtraRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof (msg as { type?: unknown }).type !== "string") return false;
  void router.handle(msg).then(sendResponse);
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id && port.sender.id !== chrome.runtime.id) return;
  if (hub.attach(port)) {
    maybeConnectHelper();
    // Credit and plan may have changed elsewhere (dashboard, another browser).
    void account.refresh().catch(() => {});
  }
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
  account,
  router,
  media: mediaFiles,
  vault,
  cdp,
  slots,
  agentTab,
  tabChats,
  scheduleDueAlarm,
};
