/**
 * Side panel entry: wires the header (header.ts), the tabs (Chat | TODO |
 * Activity log, tabs.ts), the composer and the push port to the background
 * (port.ts), and decides which conversation Chat shows: the one of the
 * browser tab active in the panel's window (see tab-chat.ts).
 */
import { errorMessage, type SessionInfo } from "@browsertodo/shared";
import { uiRequest, type UiPush, type UiState } from "../ui-protocol.js";
import { initChat } from "./chat.js";
import { initComposer } from "./composer.js";
import { showDetails } from "./details-sheet.js";
import { $, closeMenusOnOutsideClick } from "../ui/dom.js";
import { setErrorFixes, type ErrorFixes } from "./error-view.js";
import { initHeader } from "./header.js";
import { initHistory } from "./history.js";
import { openSettings } from "./open-settings.js";
import { connectBackground } from "./port.js";
import { chatForTab, isBound, tabOfSession } from "./tab-chat.js";
import { initPanelTabs, tabHasComposer, type TabName } from "./tabs.js";
import { initTasks } from "./tasks.js";
import { OPEN_CHAT_COMMAND, openShortcutSettings, readShortcut, VOICE_COMMAND } from "../shortcut.js";
import { voiceAllowed } from "../account/types.js";
import { openBilling, refreshOnReturn } from "../ui/billing.js";
import { browserMicAccessDeps, watchMicPermission } from "../voice/mic-access.js";
import { MicSource } from "../voice/recorder.js";
import { panelTranscriber } from "../voice/transcribe.js";
import { initVoiceInput, isListening } from "./voice-input.js";

/** Relative times (the status line's next check, task times) are redrawn this often. */
const CLOCK_TICK_MS = 60_000;

let state: UiState | null = null;
let currentTab: TabName = "chat";
/** The conversation the Chat tab shows. */
let focused: SessionInfo | null = null;
/** The browser window this panel is in, and its active tab: Chat shows that tab's conversation. */
let windowId: number | null = null;
let activeTab: number | null = null;
/** A conversation just started from a tab, until the state shows it bound there. */
let pending: { tab: number; sessionId: string } | null = null;
/** Running sessions the user left with New chat in a tab they act in (not bound to it). */
const left = new Map<number, string>();

/** Shows the conversation of the active tab (or an empty new chat). */
function resolveChat(): void {
  if (pending && state && isBound(pending.sessionId, state)) pending = null;
  chat.show(chatForTab(activeTab, state ?? {}, { pending, left }));
}

/** A message, a new task or a continue went out from this tab: its conversation shows here at once. */
function startedHere(sessionId: string): void {
  if (activeTab !== null) {
    pending = { tab: activeTab, sessionId };
    left.delete(activeTab);
  }
  tabs.show("chat");
  resolveChat();
}

/** Switch to the tab another conversation lives in (its chat then shows, since the panel follows the tab). */
async function switchTo(sessionId: string): Promise<boolean> {
  const tab = state ? tabOfSession(sessionId, state) : null;
  try {
    if (tab !== null) return (await uiRequest({ type: "tab.focus", tabId: tab })).ok;
    return (await uiRequest({ type: "agent.show", sessionId })).ok;
  } catch {
    return false;
  }
}

/** A run picked in the Activity log: a running conversation of another tab is switched to; any other is bound to this tab. */
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
const composer = initComposer({
  onStarted: startedHere,
  onState: (s) => applyState(s),
  onTopup: billing,
  tabId: () => activeTab,
});
// Voice input: the mic left of Send; clips are transcribed by the background with the account.
const micAccess = browserMicAccessDeps();
const voice = initVoiceInput({
  composer,
  transcribe: panelTranscriber(
    (clip) => uiRequest({ type: "voice.transcribe", ...clip }),
    () => composer.target()?.sessionId,
  ),
  createSource: () => new MicSource(),
  mic: { ...micAccess, watch: (onChange) => watchMicPermission(onChange) },
  openBilling: billing,
  host: document.body,
  // The voice shortcut stops and sends while listening, wherever the keyboard focus is.
  onListening: (listening) => port.send({ type: "panel.listening", listening }),
});
const chat = initChat({
  // Continue in an end card: go on now (with the note typed in the box, if any).
  onContinue: (sessionId) => void composer.continueNow(sessionId),
  onFocus: (s) => {
    focused = s;
    composer.setConversation(s);
  },
  // New chat: this tab has no conversation any more (the session stays in the Activity log).
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
    composer.leave(s.sessionId);
    resolveChat();
  },
  onSwitch: (s) => void switchTo(s.sessionId),
  onDetails: runDetails,
  onShortcuts: () => void openShortcutSettings(),
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

/** Follows the active tab of this panel's window (each window's panel follows its own). */
async function trackTabs(): Promise<void> {
  const setActive = (id: number | null) => {
    if (id === activeTab) return;
    activeTab = id;
    resolveChat();
  };
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
  state = s;
  setErrorFixes(errorFixes(s));
  header.render(s);
  voice.setAllowed(!!s.account?.signedIn && voiceAllowed(s.account.plan));
  if (voicePending) {
    voicePending = false;
    voice.shortcut();
  }
  chat.setRunning(s.runningSessions);
  composer.setRunning(s.runningSessions);
  composer.setState(s);
  tasks.setState(s);
  // A left running session that ended no longer needs hiding.
  for (const [tab, id] of [...left]) if (!s.runningSessions.some((r) => r.sessionId === id)) left.delete(tab);
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
      // The voice shortcut (after panel.focus): start listening, or stop and send.
      tabs.show("chat");
      if (state) voice.shortcut();
      else voicePending = true;
      break;
  }
}

/** Tells the background which window this panel is in (the keyboard shortcut acts per window). */
function hello(): void {
  if (windowId === null) return;
  port.send({ type: "panel.hello", windowId });
  reportDocumentFocus();
  // A background that restarted meanwhile learns it again (the voice shortcut stops a listening panel).
  if (isListening(voice.state)) port.send({ type: "panel.listening", listening: true });
}

/** Whether this page has the keyboard focus, for the shortcut (see panel-command.ts), with the text in the box. */
function reportDocumentFocus(): void {
  port.send({ type: "panel.document", focused: document.hasFocus(), draft: composer.draft() });
}
window.addEventListener("focus", reportDocumentFocus);
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
