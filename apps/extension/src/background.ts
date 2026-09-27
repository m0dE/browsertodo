/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import * as core from "@browsertodo/core";
import { errorMessage, type ExtensionSettings, type ScheduledTask, type SessionInfo } from "@browsertodo/shared";
import { AccountService, browserTimeZone, type AccountServiceDeps } from "./account/account.js";
import type { AccountTaskList } from "./account/account-api.js";
import { AccountTodo, LocalTodo, type TodoSource } from "./account/todo-source.js";
import { AgentSlots } from "./agent-slots.js";
import { ApprovalBroker } from "./approval/broker.js";
import { approvalJev } from "./approval/jev-source.js";
import type { GateContext } from "./approval/gate.js";
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
import { TraceStore } from "./engine/trace-store.js";
import { MEMORY_SEARCH_LIMIT, MemoryService, type MemoryTool } from "./memory/service.js";
import { MemoryStore } from "./memory/store.js";
import { MemorySync } from "./memory/sync.js";
import { EPISODE_ALARM, EpisodeWriter } from "./memory/episodes.js";
import { memorySummarizer } from "./memory/summarizers.js";
import { testClaude, testCloud, testJev } from "./engine/settings-tests.js";
import { UiHub } from "./engine/ui-hub.js";
import { UiRouter, type ExtraRequest } from "./engine/ui-router.js";
import { HelperLink } from "./helper-link.js";
import { logger } from "./log.js";
import { notify } from "./notify.js";
import { PanelCommands } from "./panel-command.js";
import { openTabPanel, panelTabOf, StoredPanelTabs } from "./panel-tabs.js";
import { ALARM_NAME, DUE_ALARM, ensureAlarm, getRunnerId, handleStorageChange, loadSettings, migrateStoredSettings, saveSettings, saveSettingsPatch } from "./settings-store.js";
import type { UiPush, UiRequest } from "./ui-protocol.js";
import { VOICE_BADGES, VoiceSessions } from "./voice-session.js";
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
// Each browser tab has its own chat (tab -> conversation); the tab's own side panel shows it.
const tabChats = new TabChats();
// Each running session acts in its own agent tab (slot); slot 0 is the first agent tab.
// Scheduled runs never take over a tab that has a chat.
// Every browser call of a session is timed in its conversation's trace (the Raw view).
// Actions the automation level holds wait for the user's OK: a card in the conversation's chat (approval/broker.ts).
// The side panel may be closed (a scheduled run): a notification says so too.
const approvals = new ApprovalBroker({
  note: async (sessionId, e) => {
    if (!(await sessions.note(sessionId, e))) throw new Error(`No conversation ${sessionId}`);
  },
  onRequest: (_sessionId, r) => void notify("needs your OK", `${r.action}${r.site ? ` on ${r.site}` : ""}: ${r.why}. Answer in the side panel.`),
});
const slots: AgentSlots = new AgentSlots(
  cdp,
  vault,
  async (tabId) => (await tabChats.get(tabId)) !== null,
  (sessionId, call) => sessions.append(sessionId, { type: "trace", trace: { t: call.t, ms: call.ms, cat: "browser", name: call.method, src: "engine", data: call.data } }),
  {
    context: (sessionId): Promise<GateContext> => runner.gateContext(sessionId),
    request: (sessionId, ask, opts) => approvals.request(sessionId, ask, opts),
    jev: async (sessionId) =>
      approvalJev({ settings: await loadSettings(), brain: runner.runningSessions.find((s: SessionInfo) => s.sessionId === sessionId)?.brain, hosted: account.session(), sessionId }),
    end: (sessionId) => approvals.end(sessionId),
  },
  (tabId) => panelCommands.hasPanel(tabId),
);
const { tab: agentTab, driver, browser } = slots.get(0);
const db = new IdbKvDb();
const localStore = new LocalStore({ db });
// Each conversation's timing trace (Raw view) lives beside its events.
const sessions = new SessionStore(db, { trace: new TraceStore(db, { log: logger("trace") }) });
// schedule_task (every brain): the agent's task goes into the TODO list of that conversation's user (engine/schedule-task.ts).
const scheduleTask = (sessionId: string, args: unknown): Promise<ScheduledTask> => router.scheduler.schedule(sessionId, args);
// The agent's long-term memory (memory/): given at each turn's start, kept with remember / forget and run notes.
const memoryStore = new MemoryStore();
// On a plan with the TODO list, memory syncs with the signed-in account (memory/sync.ts); else it stays here.
const memorySync = new MemorySync({
  store: memoryStore,
  account: async () => {
    await account.load();
    const s = account.session();
    return s ? { userId: s.user.id, email: s.user.email, syncAllowed: account.todoAllowed(), api: await account.api() } : null;
  },
  log: logger("memory"),
  // "Add this computer's memory to <account>?" shows in the side panel and Settings.
  onQuestionChange: () => hub.pushState(),
});
// Signed in and syncing, the account's semantic search adds meaning to what each turn is given (memory/search.ts).
const memory = new MemoryService({
  store: memoryStore,
  sessions,
  settings: loadSettings,
  sync: memorySync,
  semantic: (query, taskKey) => memorySync.search(query, { taskKey, limit: MEMORY_SEARCH_LIMIT }),
});
// remember / recall / forget (every brain): answered by the memory of that conversation.
const memoryTool = (sessionId: string, tool: MemoryTool, args: unknown) => memory.tool(sessionId, tool, args);
// Claude Code's browser calls name their task session: they are served in that session's tab.
const helper = new HelperLink({
  registerHandlers: (peer) => {
    registerBrowserHandlers(peer, (sessionId) => slots.browserFor(sessionId));
    peer.handle("todo.scheduleTask", ({ sessionId, args }) => scheduleTask(sessionId, args));
    peer.handle("memory.call", ({ sessionId, tool, args }) => memoryTool(sessionId, tool, args));
  },
});
const mediaFiles = new MediaFiles();
// Which conversations still have their agent session open shows in the side panel.
const claudeCodeBrain = new ClaudeCodeBrain(helper, { onSessionsChanged: () => hub.pushState() });
const apiBrain = new ApiBrain({ core, browser, scheduleTask, memoryTool, onSessionsChanged: () => hub.pushState() });

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
    // Signed in, out, or a new plan: memory syncs (or stops) accordingly.
    memorySync.schedule();
  },
  log: logger("account"),
});
void account.load().catch(() => {});
memorySync.schedule();
const hostedBrain = new ApiBrain({
  core,
  browser,
  scheduleTask,
  memoryTool,
  onSessionsChanged: () => hub.pushState(),
  backend: hostedBackend({
    core,
    session: () => account.session(),
    onOutOfCredit: () => void account.markOutOfCredit().catch(() => {}),
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
  if (needsHelper(settings) && !helper.connected) await helper.connect().catch(() => undefined);
  const status = brainStatus(settings);
  const brain = status.effective && status.effective !== "scripted" ? brains[status.effective] : null;
  return { brain, status };
}

/** Next due time among the signed-in account's pending tasks (from the last list), for the due alarm. */
let accountNextDue: number | null = null;
function noteAccountTasks(listed?: AccountTaskList): void {
  if (listed) {
    // The server judges the plan: when it disagrees with the plan cached here, fetch the plan again (at most once a minute).
    if (listed.locked === account.todoAllowed()) void account.refresh().catch(() => {});
    // Paused tasks wait for the user (or their retryAfter, which the server turns back into pending).
    // A locked list does not run, so it sets no alarm.
    const times = listed.locked
      ? []
      : listed.tasks
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
  return new AccountTodo(await account.api(), browserTimeZone(), (listed) => {
    noteAccountTasks(listed);
    if (!listed) hub.push({ type: "tasks.changed" });
  });
}

const createApi = (s: ExtensionSettings) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey });

/** A tab's id, address and title (no tabId: the tab the user is looking at); chrome.tabs works on every page. */
async function pageOf(tabId?: number): Promise<{ tabId: number; url: string; title: string } | null> {
  const tab =
    tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" }))[0]
      : await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.id === undefined ? null : { tabId: tab.id, url: tabUrl(tab), title: tab.title ?? "" };
}

// Each tab's own side panel, and the keyboard shortcut: open it with the cursor in the chat input (see panel-command.ts).
const panelTabs = new StoredPanelTabs({ log: logger("panel") });
// The hands-free session (which tab, which panel runs it, the tab the user looks at): every panel is told, and the
// toolbar badges show it (see voice-session.ts).
const DEFAULT_ACTION_TITLE = chrome.runtime.getManifest().action?.default_title ?? "BrowserTODO";
const voiceSessions = new VoiceSessions({
  broadcast: (session) => hub.push({ type: "voice.session", session }),
  badge: (tabId, look) => {
    const b = look ? VOICE_BADGES[look] : null;
    void Promise.all(
      b
        ? [
            chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }),
            chrome.action.setBadgeTextColor({ tabId, color: b.textColor }),
            chrome.action.setBadgeText({ tabId, text: b.text }),
            chrome.action.setTitle({ tabId, title: b.title ?? DEFAULT_ACTION_TITLE }),
          ]
        : [chrome.action.setBadgeText({ tabId, text: "" }), chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE })],
    ).catch((err: unknown) => logger("voice")(`badge on tab ${tabId}: ${errorMessage(err)}`));
  },
  storage: {
    load: async () => (await chrome.storage.session.get("voiceSession")).voiceSession,
    save: (value) => chrome.storage.session.set({ voiceSession: value }),
  },
  // After a worker restart: the panel page that ran it is still open.
  alive: async (s) => {
    const pages = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL, chrome.runtime.ContextType.TAB] });
    return pages.some((c) => URL.canParse(c.documentUrl ?? "") && new URL(c.documentUrl!).pathname === "/sidepanel.html" && panelTabOf(new URL(c.documentUrl!).search) === s.host);
  },
  log: logger("voice"),
});
void Promise.all([
  chrome.tabs.query({ active: true, windowType: "normal" }),
  chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null),
])
  .then(([tabs, focused]) => voiceSessions.seed(tabs.flatMap((t) => (t.id === undefined ? [] : [{ tabId: t.id, windowId: t.windowId }])), focused?.id ?? null))
  .catch((err: unknown) => logger("voice")(`reading the active tabs failed: ${errorMessage(err)}`));
const panelCommands = new PanelCommands({
  open: (tabId) => openTabPanel(tabId),
  // Disabling closes the tab's panel at once (close() animates and keeps the page); it goes out before the
  // open() that follows, in the same gesture.
  disable: (tabId) => chrome.sidePanel.setOptions({ tabId, enabled: false }),
  tabs: panelTabs,
  reportsClosed: !!chrome.sidePanel?.onClosed,
  // Which panel runs hands-free voice: the background's one record of it.
  voice: (session) => voiceSessions.set(session),
  log: logger(),
});

// The background memory writer (memory/episodes.ts): each conversation's episode and new facts, on the brain it used,
// once a task run ends or a chat goes idle. Its queue lives in storage and an alarm wakes the worker for it.
const episodes = new EpisodeWriter({
  store: memoryStore,
  sessions,
  settings: loadSettings,
  summarizer: (brain) => memorySummarizer(brain, { settings: loadSettings, hosted: () => account.session(), helper }),
  alarms: {
    set: async (when) => void (await chrome.alarms.create(EPISODE_ALARM, { when })),
    clear: async () => void (await chrome.alarms.clear(EPISODE_ALARM)),
  },
  log: logger("memory"),
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
  memory,
  episodes,
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
  const accountDue = account.todoAllowed() && accountNextDue !== null ? new Date(accountNextDue) : null;
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
  approvals,
  memory,
  memoryQuestion: () => memorySync.question(),
  showAgent: (sessionId) => slots.show(sessionId ?? runner.running?.sessionId),
  localStore,
  sessions,
  openConversations: () => [...claudeCodeBrain.openSessions(), ...apiBrain.openSessions()],
  helper,
  brainStatus,
  nextRunAt,
  testClaude: (s) => testClaude(s),
  testJev: (s, brain) => testJev(s, brain, { core, hosted: account.session() }),
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
  traceEnv: async () => {
    const platform = await chrome.runtime.getPlatformInfo().catch(() => null);
    const h = helper.info;
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      ...(platform ? { os: platform.os, arch: platform.arch } : {}),
      helper: h ? { version: h.version, brain: h.brain ?? "claude", jev: h.jevAvailable } : null,
    };
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
  // An install saved with an earlier default account server moves to its current address (also on update).
  void migrateStoredSettings().catch((err: unknown) => logger("settings")(`migration failed: ${errorMessage(err)}`));
  void ensureAlarm();
  // No window-wide panel: a tab without its own options has none (panel-tabs.ts). The toolbar button opens or closes
  // a tab's own panel; in a tab without one it fires action.onClicked, which opens it there.
  void chrome.sidePanel?.setOptions({ enabled: false }).catch(() => {});
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void runner.recover().catch(() => {});
  void episodes.resume();
  void scheduleDueAlarm().catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => onStart());
chrome.runtime.onStartup.addListener(() => onStart());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (episodes.onAlarm(alarm.name)) return;
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => changeInfo.status === "loading" && voiceSessions.tabLoading(tabId));
// What the user looks at, for hands-free voice (the panel running it is hidden on other tabs).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => voiceSessions.tabActivated(tabId, windowId));
chrome.windows.onFocusChanged.addListener((windowId) => voiceSessions.windowFocused(windowId), { windowTypes: ["normal"] });
chrome.windows.onRemoved.addListener((windowId) => voiceSessions.windowRemoved(windowId));
// A tab a running agent's page opened (target=_blank, window.open) joins that run's tabs.
chrome.tabs.onCreated.addListener((tab) => void slots.adopt(tab).catch(() => {}));
// A closed tab loses its chat (the session stays in History); a turn running there stops.
chrome.tabs.onRemoved.addListener((tabId) => {
  panelCommands.tabRemoved(tabId);
  voiceSessions.tabRemoved(tabId);
  void tabChats
    .unbind(tabId)
    .then((sessionId) => {
      if (sessionId) runner.onChatTabClosed(sessionId);
    })
    .catch(() => {});
});
// Before anything is awaited: sidePanel.open() needs the key press (or the click) as its user gesture.
chrome.commands?.onCommand.addListener((command, tab) => void panelCommands.onCommand(command, tab));
const onActionClicked = (tab: chrome.tabs.Tab) => panelCommands.onAction(tab);
chrome.action.onClicked.addListener(onActionClicked);
// A panel the user closed stays off in its tab (it may wake the worker: the remembered tabs are read first).
chrome.sidePanel?.onClosed?.addListener(({ tabId }) => {
  if (tabId !== undefined) void panelTabs.ready.then(() => panelCommands.panelClosed(tabId));
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
    panelCommands.attach(port);
    // Where hands-free voice is on, before the panel's hello (a voice shortcut it gets then acts on it).
    port.postMessage({ type: "voice.session", session: voiceSessions.view() } satisfies UiPush);
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
  memory,
  memorySync,
  episodes,
  scheduleDueAlarm,
  panelCommands,
  panelTabs,
  voiceSessions,
  /** The toolbar button's listener (the e2e shortcut presser points the button at the command handler instead). */
  onActionClicked,
  /** Runs use this brain instead of the real ones (null: back to the real ones). */
  setBrainOverride: (fn: typeof brainOverride) => void (brainOverride = fn),
  /** Google sign-in uses this client ID and auth flow (a fake Google). */
  setIdentity: (next: SignInIdentity) => void (signInIdentity = next),
};
