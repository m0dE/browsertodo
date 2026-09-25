/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import * as core from "@browsertodo/core";
import type { ExtensionSettings } from "@browsertodo/shared";
import { AccountService, browserTimeZone, type AccountServiceDeps } from "./account/account.js";
import { AccountTodo, LocalTodo, type TodoSource } from "./account/todo-source.js";
import { AgentSlots } from "./agent-slots.js";
import { ApiClient } from "./api-client.js";
import { Cdp } from "./cdp.js";
import { tabUrl } from "./chrome-tabs.js";
import { GOOGLE_CLIENT_ID } from "./build-config.js";
import { ApiBrain } from "./engine/api-brain.js";
import { hostedBackend } from "./engine/hosted-brain.js";
import { needsHelper, resolveBrain } from "./engine/brain-resolver.js";
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
import { logger } from "./log.js";
import { notify } from "./notify.js";
import { PanelCommands } from "./panel-command.js";
import { ALARM_NAME, DUE_ALARM, ensureAlarm, getRunnerId, handleStorageChange, loadSettings, saveSettings, saveSettingsPatch } from "./settings-store.js";
import type { UiRequest } from "./ui-protocol.js";
import { TabChats } from "./tab-chats.js";
import { Vault } from "./vault.js";

// MV3 forbids eval; stop zod from probing for it.
z.config({ jitless: true });

/** Do not re-spawn the helper for every side panel open. */
const HELPER_AUTOCONNECT_MS = 60_000;
/** Due alarms this close count as the same; a new one is set at least this far ahead. */
const DUE_ALARM_SLACK_MS = 1000;

// Pushes to the side panel. Its state comes from the router below; nothing pushes before this module has run.
const hub = new UiHub(() => router.getState());

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
const claudeCodeBrain = new ClaudeCodeBrain(helper, { onSessionsChanged: () => hub.pushState() });
const apiBrain = new ApiBrain({ core, browser, onSessionsChanged: () => hub.pushState() });

type SignInIdentity = { clientId: string; identity: NonNullable<AccountServiceDeps["identity"]> };
/** Google sign-in: the built-in client and Chrome's auth flow (the e2e suite swaps in a fake Google, setIdentity). */
let signInIdentity: SignInIdentity = {
  clientId: GOOGLE_CLIENT_ID,
  identity: {
    redirectUri: () => chrome.identity.getRedirectURL(),
    launch: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  },
};

// The browsertodo account: Google sign-in, the account's TODO list, billing and the hosted AI.
const account = new AccountService({
  loadSettings,
  get clientId() {
    return signInIdentity.clientId;
  },
  get identity() {
    return signInIdentity.identity;
  },
  localTasks: localStore,
  onChange: () => {
    hub.pushState();
    hub.push({ type: "tasks.changed" });
  },
  log: logger("account"),
});
void account.load().catch(() => {});
const hostedBrain = new ApiBrain({
  core,
  browser,
  onSessionsChanged: () => hub.pushState(),
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

const brains = { "claude-code": claudeCodeBrain, "claude-api": apiBrain, browsertodo: hostedBrain } as const;

/** The e2e suite's scripted brain (setBrainOverride); null: the real ones. */
let brainOverride: ((settings: ExtensionSettings) => Promise<ResolvedBrain>) | null = null;

async function resolveForRun(settings: ExtensionSettings): Promise<ResolvedBrain> {
  if (brainOverride) return brainOverride(settings);
  await account.load().catch(() => undefined);
  if (needsHelper(settings, account.brainAccount()) && !helper.connected) await helper.connect().catch(() => undefined);
  const status = brainStatus(settings);
  const brain = status.effective && status.effective !== "scripted" ? brains[status.effective] : null;
  return { brain, status };
}

/** Next due time among the signed-in account's pending tasks (from the last list), for the due alarm. */
let accountNextDue: number | null = null;
function noteAccountTasks(tasks?: { status: string; notBefore: string | null; retryAfter: string | null }[]): void {
  if (tasks) {
    // Paused tasks wait for the user (or their retryAfter, which the server turns back into pending).
    const times = tasks
      .filter((t) => t.status === "pending")
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
    if (!tasks) hub.push({ type: "tasks.changed" });
  });
}

const createApi = (s: ExtensionSettings) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey });

/** A tab's address and title (no tabId: the tab the user is looking at); chrome.tabs works on every page. */
async function pageOf(tabId?: number): Promise<{ url: string; title: string } | null> {
  const tab =
    tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" }))[0]
      : await chrome.tabs.get(tabId).catch(() => undefined);
  return tab ? { url: tabUrl(tab), title: tab.title ?? "" } : null;
}

// The keyboard shortcut: open the side panel with the cursor in the chat input (see panel-command.ts).
const panelCommands = new PanelCommands({
  open: (windowId) => chrome.sidePanel.open({ windowId }),
  log: logger(),
});

const runner = new Runner({
  loadSettings,
  saveSettings,
  getRunnerId,
  createApi,
  accountApi: () => account.runnerApi(),
  localStore,
  sessions,
  pageOf,
  media: mediaFiles,
  resolveBrain: resolveForRun,
  core,
  slots,
  tabChats,
  notify,
  keepAlive: () => chrome.runtime.getPlatformInfo(),
  onStateChange: () => hub.pushState(),
  log: logger(),
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
  if (existing && Math.abs(existing.scheduledTime - next.getTime()) < DUE_ALARM_SLACK_MS) return;
  await chrome.alarms.create(DUE_ALARM, { when: Math.max(next.getTime(), Date.now() + DUE_ALARM_SLACK_MS) });
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
// Before anything is awaited: sidePanel.open() needs the key press as its user gesture.
chrome.commands?.onCommand.addListener((command, tab) => void panelCommands.onCommand(command, tab));
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
    panelCommands.attach(port);
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
  panelCommands,
  /** Runs use this brain instead of the real ones (null: back to the real ones). */
  setBrainOverride: (fn: typeof brainOverride) => void (brainOverride = fn),
  /** Google sign-in uses this client ID and auth flow (a fake Google). */
  setIdentity: (next: SignInIdentity) => void (signInIdentity = next),
};
