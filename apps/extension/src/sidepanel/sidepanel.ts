/**
 * Side panel entry: wires the header (header.ts), the tabs (Chat | TODO |
 * History, tabs.ts), the composer and the push port to the background
 * (port.ts), and decides which conversation Chat shows: the one of the
 * browser tab the panel belongs to (each tab has its own panel, see
 * panel-tabs.ts; the page opened as a tab follows its window's active tab
 * instead), see tab-chat.ts.
 */
import { errorMessage, type SessionInfo, type VoiceEngineId, type VoiceEnginesResponse } from "@browsertodo/shared";
import { isStale, uiRequest, type UiPush, type UiState } from "../ui-protocol.js";
import { initChat } from "./chat.js";
import { initComposer } from "./composer.js";
import { showDetails } from "./details-sheet.js";
import { $, closeMenusOnOutsideClick } from "../ui/dom.js";
import { setErrorFixes, type ErrorFixes } from "./error-view.js";
import { initHeader } from "./header.js";
import { initHistory } from "./history.js";
import { openSettings } from "./open-settings.js";
import { initAutonomyWarning } from "./autonomy-warning.js";
import { connectBackground } from "./port.js";
import type { PanelMessage } from "../panel-command.js";
import { chatForTab, followChat, isBound, tabOfSession } from "./tab-chat.js";
import { openTabPanel, panelTabOf } from "../panel-tabs.js";
import { initPanelTabs, tabHasComposer, type TabName } from "./tabs.js";
import { initTasks } from "./tasks.js";
import { OPEN_CHAT_COMMAND, openShortcutSettings, readShortcut, VOICE_COMMAND } from "../shortcut.js";
import { voiceAllowed } from "../account/types.js";
import { openBilling, refreshOnReturn } from "../ui/billing.js";
import { browserMicAccessDeps, watchMicPermission } from "../voice/mic-access.js";
import { MicSource } from "../voice/recorder.js";
import { REALTIME_SAMPLE_RATE } from "../voice/realtime-client.js";
import { RealtimeEngine } from "../voice/realtime-engine.js";
import { Speaker } from "../voice/speaker.js";
import { StandardEngine } from "../voice/standard-engine.js";
import { panelTranscriber, VoiceError } from "../voice/transcribe.js";
import { initHandsFree, type SendExtra } from "./hands-free.js";
import { initVoiceInput, VOICE_NOTICE } from "./voice-input.js";
import { PanelTrace } from "../trace/panel-trace.js";

/** Relative times (the status line's next check, task times) are redrawn this often. */
const CLOCK_TICK_MS = 60_000;

let state: UiState | null = null;
let currentTab: TabName = "chat";
/** The conversation the Chat tab shows. */
let focused: SessionInfo | null = null;
/** The tab this side panel belongs to (null: the panel page opened as a tab). */
const ownTab = panelTabOf(location.search);
/**
 * The browser window this panel is in, and the tab whose conversation Chat shows: the panel's own tab (or where the
 * agent moved the chat it showed, see followChat), else the active tab of the window.
 */
let windowId: number | null = null;
let activeTab: number | null = ownTab;
/** The conversation Chat shows (null: an empty new chat). */
let shownChat: string | null = null;
/** A conversation just started from a tab, until the state shows it bound there. */
let pending: { tab: number; sessionId: string } | null = null;
/** The conversation last sent to from the tab Chat shows (kept once bound: its turn may move it, see followChat). */
let sent: { tab: number; sessionId: string } | null = null;
/** Running sessions the user left with New chat in a tab they act in (not bound to it). */
const left = new Map<number, string>();

/** Shows the conversation of the active tab (or an empty new chat). */
function resolveChat(): void {
  if (pending && state && isBound(pending.sessionId, state)) pending = null;
  shownChat = chatForTab(activeTab, state ?? {}, { pending, left });
  chat.show(shownChat);
}

/** Chat shows the conversation of `tab` from now on. */
function setActive(tab: number | null): void {
  if (tab === activeTab) return;
  activeTab = tab;
  resolveChat();
  handsFree.refresh();
}

/** A message, a new task or a continue went out from this tab: its conversation shows here at once. */
function startedHere(sessionId: string): void {
  if (activeTab !== null) {
    pending = sent = { tab: activeTab, sessionId };
    left.delete(activeTab);
  }
  tabs.show("chat");
  resolveChat();
}

/**
 * Shows another browser tab. From a tab's own panel, that tab's panel opens too (it shows that tab's chat): called
 * synchronously in the user's click, since open() needs the gesture.
 */
async function goToTab(tabId: number): Promise<boolean> {
  if (ownTab !== null) void openTabPanel(tabId).catch((err: unknown) => console.warn(`[browsertodo] opening the panel of tab ${tabId} failed: ${errorMessage(err)}`));
  return (await uiRequest({ type: "tab.focus", tabId })).ok;
}

/** Switch to the tab another conversation lives in (its chat shows there). */
async function switchTo(sessionId: string): Promise<boolean> {
  const tab = state ? tabOfSession(sessionId, state) : null;
  try {
    if (tab !== null) return await goToTab(tab);
    return (await uiRequest({ type: "agent.show", sessionId })).ok;
  } catch {
    return false;
  }
}

/** A run picked in History: a running conversation of another tab is switched to; any other is bound to this tab. */
async function openHere(s: SessionInfo): Promise<void> {
  tabs.show("chat");
  const st = state ?? {};
  if (chatForTab(activeTab, st, { pending, left }) === s.sessionId) return composer.focus();
  const elsewhere = tabOfSession(s.sessionId, st);
  if (!s.endedAt && elsewhere !== null && elsewhere !== activeTab && (await switchTo(s.sessionId))) return;
  if (activeTab === null) return;
  const tab = activeTab;
  try {
    applyState(await uiRequest({ type: "chat.bind", sessionId: s.sessionId, tabId: tab }));
  } catch (err) {
    // Not bound: it still shows here now, and the box says why it will not stay with this tab.
    composer.showError(err);
  }
  left.delete(tab);
  pending = { tab, sessionId: s.sessionId };
  resolveChat();
  composer.focus();
}

/** "Open in TODO" from the details sheet: the TODO tab, scrolled to the task. */
function openInTodo(taskId: string): void {
  tabs.show("todo");
  void tasks.reveal(taskId);
}

/** The details sheet of a run's task (its first message in Chat): "Open in TODO" when the list has it. */
const runDetails = (s: SessionInfo, trigger: HTMLElement) => void showDetails({ session: s }, trigger, { onOpenInTodo: openInTodo });

/** Get a plan, Top up, Plan & billing: the dashboard's Billing page. */
function billing(): void {
  void openBilling(state?.account);
}

const tasks = initTasks({
  onStarted: () => tabs.show("chat"),
  onContinued: startedHere,
  onState: (s) => applyState(s),
  tabId: () => activeTab,
  onDetails: (task, listSource, trigger) => void showDetails({ task, listSource }, trigger),
  openBilling: billing,
  onGateChange: () => updateComposer(),
});
/** This panel's part of each conversation's timing trace (sending, voice), for the Raw view. */
const panelTrace = new PanelTrace((sessionId, events) => uiRequest({ type: "trace.add", sessionId, events }));
/** The voice engines' models as the server last listed them (for the trace). */
const voiceModels: Partial<Record<VoiceEngineId, string>> = {};
/** The server's voice engines (null: could not be loaded); remembers their models. */
async function loadVoiceModels(): Promise<VoiceEnginesResponse | null> {
  const r = await uiRequest({ type: "voice.engines" }).catch(() => null);
  if (!r || "error" in r) return null;
  for (const e of r.engines) voiceModels[e.id] = e.model;
  return r;
}
const composer = initComposer({
  onStarted: startedHere,
  onState: (s) => applyState(s),
  onTopup: billing,
  tabId: () => activeTab,
  trace: panelTrace,
});
// Voice: the mic left of Send and the voice shortcut start hands-free voice; Standard's clips are transcribed by the
// background with the account.
const micAccess = browserMicAccessDeps();
const transcribe = panelTranscriber(
  (clip) => uiRequest({ type: "voice.transcribe", ...clip }),
  () => composer.target()?.sessionId,
);
/**
 * A hands-free session is on (in tab `tabId`, on `engine`): the voice shortcut then reaches this panel, wherever the
 * focus is, the other panels say where voice is on, and the toolbar badges show it (see voice-session.ts).
 */
let listeningReport: Extract<PanelMessage, { type: "panel.listening" }> = { type: "panel.listening", listening: false };
function reportListening(listening: boolean, tabId: number | null, engine: VoiceEngineId | null): void {
  listeningReport = { type: "panel.listening", listening, ...(tabId === null ? {} : { tabId }), ...(engine === null ? {} : { engine }) };
  port.send(listeningReport);
}
const voice = initVoiceInput({
  composer,
  mic: { ...micAccess, watch: (onChange) => watchMicPermission(onChange) },
  openBilling: billing,
  host: document.body,
});
/** The chat of a browser tab (null: it has none yet); an unknown tab's is the one Chat shows. */
const chatOfTab = (tab: number | null): string | null =>
  tab === null ? (focused?.sessionId ?? pending?.sessionId ?? null) : chatForTab(tab, state ?? {}, { pending, left });

/**
 * Hands-free voice sends what was said to its chat, whichever tab is shown: the chat by its id (it stays in the tab
 * it lives in), or a new chat in the session's tab.
 */
async function sendSpoken(text: string, target: { tabId: number | null; sessionId: string | null }, { cid, context }: SendExtra = {}): Promise<string> {
  const { tabId: tab, sessionId } = target;
  // A new chat carries the choice of memory made for its tab (the composer's menu).
  const where = sessionId ? { sessionId } : { ...(tab === null ? {} : { tabId: tab }), ...composer.memory.forNewChat(tab) };
  const r = await uiRequest({ type: "run.message", ...where, text, voice: true, ...(cid ? { cid } : {}), ...(context ? { context } : {}) });
  if (sessionId) return r.sessionId;
  if (tab === null || tab === activeTab) startedHere(r.sessionId);
  else {
    // Started from a tab not shown: it is that tab's chat once the state says so.
    pending = { tab, sessionId: r.sessionId };
    left.delete(tab);
  }
  return r.sessionId;
}

// Hands-free voice (the voice shortcut): Realtime or Standard, bound to the tab it started in; see hands-free.ts.
const handsFree = initHandsFree({
  voice,
  composer,
  notify: ({ key, ...tip }) => composer.notices.show({ key: key ?? VOICE_NOTICE, ...tip }),
  activeTab: () => activeTab,
  homeTab: ownTab,
  visible: () => document.visibilityState === "visible",
  chatOf: chatOfTab,
  tabsOf: (sessionId) => {
    const home = state ? tabOfSession(sessionId, state) : null;
    return [...(home === null ? [] : [home]), ...(state?.runningTabs?.[sessionId] ?? [])];
  },
  send: sendSpoken,
  tabPage: async (tabId) => {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    return t ? { title: t.title ?? null, url: t.url ?? t.pendingUrl ?? null } : null;
  },
  goToTab: (tabId) => void goToTab(tabId).catch((err: unknown) => composer.showError(err)),
  onSpeaking: (line) => chat.setSpeaking(line),
  keepSpoken: (sessionId, text) =>
    void uiRequest({ type: "voice.spoken", sessionId, text }).catch((err: unknown) => console.warn(`[browsertodo] keeping a spoken line failed: ${errorMessage(err)}`)),
  keepHeard: (sessionId, text, sent, early) =>
    void uiRequest({ type: "voice.heard", sessionId, text, ...(sent ? { sent } : {}), ...(early ? { early } : {}) }).catch((err: unknown) =>
      console.warn(`[browsertodo] keeping what was said failed: ${errorMessage(err)}`),
    ),
  settings: () => state?.settings ?? null,
  account: () => state?.account,
  engines: loadVoiceModels,
  saveSettings: async (patch) => applyState(await uiRequest({ type: "settings.save", settings: patch })),
  createEngine: (id, events) => {
    // Standard chosen in Settings skips the engine list: its model (for the trace) is asked for here.
    if (id === "standard" && !voiceModels.standard && state?.account?.signedIn) void loadVoiceModels();
    return id === "realtime"
      ? new RealtimeEngine({
          ticket: async () => {
            const sessionId = handsFree.chat();
            const r = await uiRequest({ type: "voice.realtime", ...(sessionId ? { sessionId } : {}) });
            if ("error" in r) throw new VoiceError(r.error);
            return r;
          },
          createSource: () => new MicSource(undefined, REALTIME_SAMPLE_RATE),
          events,
          ...(state ? { voice: { voice: state.settings.realtimeVoice, speed: state.settings.realtimeSpeed } } : {}),
          log: (m) => console.info(`[browsertodo] ${m}`),
          trace: panelTrace,
        })
      : new StandardEngine({
          createSource: () => new MicSource(),
          transcribe,
          speaker: new Speaker(() => ({ voice: state?.settings.speechVoice ?? "", rate: state?.settings.speechRate ?? 1 })),
          events,
          trace: panelTrace,
          model: () => voiceModels.standard,
        });
  },
  answerApproval: async (sessionId, id, answer) => (await uiRequest({ type: "approval.answer", sessionId, id, answer, by: "voice" })).ok,
  stopTask: async (sessionId) => {
    if (!sessionId || !state?.runningSessions.some((s) => s.sessionId === sessionId)) return "No task is running.";
    await uiRequest({ type: "run.stop", sessionId });
    return "Stopped the task.";
  },
  openBilling: billing,
  signIn: () => signIn(),
  onActive: reportListening,
  stopRemote: () => port.send({ type: "panel.voiceStop" }),
  bar: $("voice-bar"),
  trace: panelTrace,
  log: (m) => console.info(`[browsertodo] ${m}`),
});
const chat = initChat({
  // Continue in an end card: go on now (with the note typed in the box, if any).
  onContinue: (sessionId) => void composer.continueNow(sessionId),
  onFocus: (s) => {
    focused = s;
    composer.setConversation(s);
    handsFree.refresh();
  },
  // New chat: this tab has no conversation any more (the session stays in History).
  onLeave: (s) => {
    if (activeTab !== null) {
      left.set(activeTab, s.sessionId);
      if (state?.tabChats?.[String(activeTab)] === s.sessionId) {
        const rest = { ...state.tabChats };
        delete rest[String(activeTab)];
        state = { ...state, tabChats: rest };
      }
    }
    if (pending?.sessionId === s.sessionId) pending = null;
    if (sent?.sessionId === s.sessionId) sent = null;
    composer.leave(s.sessionId);
    // A tab's own panel that followed its chat to the agent's tab starts the new one in its own tab.
    if (ownTab !== null) activeTab = ownTab;
    resolveChat();
  },
  onSwitch: (s) => void switchTo(s.sessionId),
  onDetails: runDetails,
  onOpenTask: openInTodo,
  onShortcuts: () => void openShortcutSettings(),
  voiceEnv: () => {
    const settings = state?.settings;
    if (!settings) return undefined;
    // Not listed yet (voice not used in this panel): ask now, for the next export.
    if (!voiceModels.realtime && !voiceModels.standard && state?.account?.signedIn) void loadVoiceModels();
    const engine = settings.voiceEngine;
    const model = voiceModels[engine];
    return {
      engine,
      ...(model ? { model } : {}),
      ...(voiceModels.realtime ? { realtimeModel: voiceModels.realtime } : {}),
      ...(voiceModels.standard ? { standardModel: voiceModels.standard } : {}),
      ...(engine === "realtime" ? { voice: settings.realtimeVoice, speed: settings.realtimeSpeed } : { voice: settings.speechVoice || "browser default", speed: settings.speechRate }),
    };
  },
});
const history = initHistory({ onOpenInChat: (s) => void openHere(s) });
/** The voice shortcut arrived before the first state (a panel it just opened): run it once voice knows the plan. */
let voicePending = false;
/** Log in: the TODO tab's sign-in, where its progress shows. */
function signIn(): void {
  tabs.show("todo");
  tasks.signIn();
}

const header = initHeader({ onState: (s) => applyState(s), onBilling: billing, onSignIn: signIn });
// While the agent may act without asking, the panel says so (Settings > AI > Automation).
const autonomyWarning = initAutonomyWarning();

/** What the fix buttons of error cards and the status line do (error-help.ts names them). Billing ones need an account. */
function errorFixes(s: UiState): ErrorFixes {
  const aiSettings = () => void openSettings("ai");
  const useHosted = () =>
    void uiRequest({ type: "settings.save", settings: { brain: "browsertodo" } }).then(applyState, (err: unknown) => composer.showError(err));
  return {
    "own-claude": aiSettings,
    "claude-code": aiSettings,
    "api-key": aiSettings,
    "set-up-ai": aiSettings,
    "new-tab": () => void chrome.tabs.create({}),
    login: signIn,
    ...(s.account?.signedIn ? { topup: billing, plans: billing, "use-hosted": useHosted } : {}),
  };
}
closeMenusOnOutsideClick("details.menu");

const tabs = initPanelTabs((name) => {
  currentTab = name;
  composer.setPanelTab(name);
  updateComposer();
  if (name === "todo") void tasks.refresh();
  if (name === "history") history.refresh();
});

/** A tab's own panel: its window (the tab may be dragged to another one); the chat it follows goes back when that tab closes. */
async function trackOwnTab(tab: number): Promise<void> {
  const refresh = async () => {
    try {
      windowId = (await chrome.tabs.get(tab)).windowId;
    } catch {
      // The tab is closing, and its panel with it.
      return;
    }
    hello();
  };
  chrome.tabs.onRemoved.addListener((tabId) => {
    handsFree.tabClosed(tabId);
    if (tabId === activeTab) setActive(tab);
  });
  chrome.tabs.onAttached.addListener((tabId) => tabId === tab && void refresh());
  await refresh();
}

/** The panel page opened as a tab: follows the active tab of its window. */
async function trackTabs(): Promise<void> {
  if (ownTab !== null) return trackOwnTab(ownTab);
  const refresh = async () => {
    try {
      const [t] = await chrome.tabs.query(windowId === null ? { active: true, currentWindow: true } : { active: true, windowId });
      setActive(t?.id ?? null);
    } catch {
      // The window is closing.
    }
  };
  try {
    windowId = (await chrome.windows.getCurrent()).id ?? null;
  } catch {
    windowId = null;
  }
  hello();
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId === null || info.windowId === windowId) setActive(info.tabId);
  });
  // A tab moved between windows, or the window regained focus: look again.
  chrome.tabs.onRemoved.addListener((tabId) => handsFree.tabClosed(tabId));
  chrome.tabs.onAttached.addListener(() => void refresh());
  chrome.tabs.onDetached.addListener(() => void refresh());
  chrome.windows.onFocusChanged.addListener(() => void refresh());
  await refresh();
}

/** The composer sits under Chat and TODO, but not under the TODO tab's Log in or Get a plan button. */
function updateComposer(): void {
  $("composer").hidden = !tabHasComposer(currentTab) || (currentTab === "todo" && tasks.callToActionOnly());
}

function applyState(s: UiState): void {
  // An older state that arrived late (a slow answer after a newer push) would undo what the newer one says.
  if (isStale(s, state)) return;
  state = s;
  setErrorFixes(errorFixes(s));
  header.render(s);
  autonomyWarning.render(s.settings);
  voice.setAllowed(!!s.account?.signedIn && voiceAllowed(s.account.plan));
  if (voicePending) {
    voicePending = false;
    voice.shortcut();
  }
  chat.setRunning(s.runningSessions);
  composer.setRunning(s.runningSessions);
  handsFree.setRunning(s.runningSessions.map((r) => r.sessionId));
  composer.setState(s);
  tasks.setState(s);
  // A left running session that ended no longer needs hiding.
  for (const [tab, id] of [...left]) if (!s.runningSessions.some((r) => r.sessionId === id)) left.delete(tab);
  // The agent moved this panel's chat to the tab it works in: the panel goes on showing it (and talking to it).
  if (ownTab !== null && activeTab !== null) {
    const followed = followChat(activeTab, shownChat, s, sent);
    if (followed !== activeTab) {
      activeTab = followed;
      handsFree.refresh();
    }
  }
  resolveChat();
  updateComposer();
}

function onPush(msg: UiPush): void {
  switch (msg.type) {
    case "state":
      applyState(msg.state);
      break;
    case "event":
      chat.onEvent(msg.event);
      handsFree.onEvent(msg.event);
      break;
    case "session":
      chat.onSession(msg.session);
      history.onSession(msg.session);
      if (focused?.sessionId === msg.session.sessionId) composer.setConversation(msg.session);
      if (msg.session.endedAt && msg.session.source === "local") void tasks.refresh();
      break;
    case "tasks.changed":
      void tasks.refresh();
      break;
    case "panel.focus":
      // The keyboard shortcut: Chat, with the cursor in the box (a panel it recreated gets the text its box had).
      tabs.show("chat");
      if (msg.draft && !composer.draft()) composer.setDraft(msg.draft);
      window.focus();
      composer.focus();
      break;
    case "panel.voice":
      // The voice shortcut (after panel.focus): hands-free on or off, as the mic button (see voice-input.ts shortcut()).
      tabs.show("chat");
      if (state) voice.shortcut();
      else voicePending = true;
      break;
    case "voice.session":
      // Where hands-free voice is on, and the tab the user looks at (this panel's tab may be hidden).
      handsFree.setSession(msg.session);
      break;
    case "voice.stop":
      handsFree.stopHere();
      break;
  }
}

/** Tells the background which tab and window this panel is in (the keyboard shortcut acts on the tab's panel). */
function hello(): void {
  if (windowId === null) return;
  port.send({ type: "panel.hello", windowId, ...(ownTab === null ? {} : { tabId: ownTab }) });
  reportDocumentFocus();
  // A background that restarted meanwhile learns it again (the voice shortcut stops a listening panel).
  if (handsFree.active && listeningReport.listening) port.send(listeningReport);
}

/** Whether this page has the keyboard focus, for the shortcut (see panel-command.ts), with the text in the box. */
function reportDocumentFocus(): void {
  port.send({ type: "panel.document", focused: document.hasFocus(), draft: composer.draft() });
}
window.addEventListener("focus", reportDocumentFocus);
// A tab's own panel shows only with its tab: on screen, the user looks at that tab (hands-free voice).
document.addEventListener("visibilitychange", () => handsFree.refresh());
window.addEventListener("blur", reportDocumentFocus);

/** The keyboard shortcuts as Chrome assigned them (null: none is set), for the new chat and the mic's tooltip. */
async function loadShortcuts(): Promise<void> {
  const [open, talk] = await Promise.all([readShortcut(OPEN_CHAT_COMMAND), readShortcut(VOICE_COMMAND)]);
  chat.setShortcuts({ open, voice: talk });
  voice.setShortcut(talk);
}

async function loadState(): Promise<void> {
  try {
    applyState(await uiRequest({ type: "state.get" }));
    // Plan and credit may have changed elsewhere; the fresh state arrives as a push.
    void uiRequest({ type: "account.refresh" }).then(applyState, () => {});
  } catch (err) {
    header.unreachable(errorMessage(err));
  }
}

// The TODO list also feeds Run now and the task counts, whichever tab opens first.
void tasks.refresh();
void trackTabs();
// Every (re)connect: say which window this is, and fetch the state.
const port = connectBackground(onPush, () => {
  hello();
  void loadState();
});
void loadShortcuts();
// Back from the dashboard's Billing page: a new plan or credit shows without Refresh (the push brings it).
refreshOnReturn(() => void uiRequest({ type: "account.refresh", force: true }).then(applyState, () => {}));
// The shortcut may have been changed on chrome://extensions/shortcuts meanwhile.
window.addEventListener("focus", () => void loadShortcuts());
// Opened (by the shortcut or the toolbar button): the cursor is in the box.
composer.focus();
setInterval(() => {
  tasks.tick();
  if (state) header.render(state);
}, CLOCK_TICK_MS);
