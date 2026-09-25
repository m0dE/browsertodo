/**
 * Side panel entry: status line and account, tabs (Chat | TODO | Activity
 * Log), the push port to the background, and which browser tab's chat is
 * shown (the active tab of the panel's window; see tab-chat.ts).
 */
import type { SessionInfo } from "@browsertodo/shared";
import { UI_PORT_NAME, uiRequest, type UiPush, type UiState } from "../ui-protocol.js";
import { initChat } from "./chat.js";
import { initComposer } from "./composer.js";
import { showDetails } from "./details-sheet.js";
import { $, busy, errorText } from "./dom.js";
import { setTopupUrl } from "./event-render.js";
import { centsLabel, clip, clockLabel, conversationNote, statusLine } from "./format.js";
import { initHistory } from "./history.js";
import { chatForTab, isBound, tabOfSession } from "./tab-chat.js";
import { savedTab, tabHasComposer, type TabName } from "./tabs.js";
import { initTasks } from "./tasks.js";
import { openSettings } from "./open-settings.js";

let state: UiState | null = null;
let currentTab: TabName = "chat";
/** The conversation the Chat tab shows. */
let focused: SessionInfo | null = null;
/** The browser window this panel is in, and its active tab: Chat shows that tab's conversation. */
let windowId: number | null = null;
let activeTab: number | null = null;
/** A conversation just started from a tab, until the state shows it bound there. */
let pending: { tab: number; sessionId: string } | null = null;
/** Running sessions the user left with New Chat in a tab they act in (not bound to it). */
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
  showTab("chat");
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

/** "Open in Chat": a conversation of another tab is switched to; any other is bound to this tab. */
async function openHere(s: SessionInfo): Promise<void> {
  showTab("chat");
  const st = state ?? {};
  if (chatForTab(activeTab, st, { pending, left }) === s.sessionId) return composer.focus();
  const elsewhere = tabOfSession(s.sessionId, st);
  if (!s.endedAt && elsewhere !== null && elsewhere !== activeTab && (await switchTo(s.sessionId))) return;
  if (activeTab === null) return;
  const tab = activeTab;
  try {
    applyState(await uiRequest({ type: "chat.bind", sessionId: s.sessionId, tabId: tab }));
  } catch {
    // The background refused (e.g. an older one): show it here anyway.
  }
  left.delete(tab);
  pending = { tab, sessionId: s.sessionId };
  resolveChat();
  composer.focus();
}

/** "Open in TODO" from the details sheet: the TODO tab, scrolled to the task. */
function openInTodo(taskId: string): void {
  showTab("todo");
  void tasks.reveal(taskId);
}

/** The details sheet of a run's task (Chat, Activity Log): "Open in TODO" when the list has it. */
const runDetails = (s: SessionInfo, trigger: HTMLElement) => void showDetails({ session: s }, trigger, { onOpenInTodo: openInTodo });

const tasks = initTasks({
  onStarted: () => showTab("chat"),
  onContinued: startedHere,
  onState: (s) => applyState(s),
  tabId: () => activeTab,
  onDetails: (task, listSource, trigger) => void showDetails({ task, listSource }, trigger),
});
const composer = initComposer({
  onStarted: startedHere,
  onState: (s) => applyState(s),
  onTargetChange: () => updateNote(),
  onTopup: () => openTopup(),
  tabId: () => activeTab,
});
const chat = initChat({
  // Continue in an end card: go on now (with the note typed in the box, if any).
  onContinue: (sessionId) => void composer.continueNow(sessionId),
  onFocus: (s) => {
    focused = s;
    composer.setConversation(s);
    updateNote();
  },
  // New Chat: this tab has no conversation any more (the session stays in the Activity Log).
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
});
const history = initHistory({ onOpenInChat: (s) => void openHere(s), onDetails: runDetails });

/** Follows the active tab of this panel's window (each window's panel follows its own). */
async function trackTabs(): Promise<void> {
  if (!chrome.tabs?.query) return;
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
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId === null || info.windowId === windowId) setActive(info.tabId);
  });
  // A tab moved between windows, or the window regained focus: look again.
  chrome.tabs.onAttached?.addListener(() => void refresh());
  chrome.tabs.onDetached?.addListener(() => void refresh());
  chrome.windows.onFocusChanged?.addListener(() => void refresh());
  await refresh();
}

/** "Conversation open · …" under the Chat header while the composer's conversation waits for a message. */
function updateNote(): void {
  const t = composer.target();
  const open = !!t && (state?.openConversations ?? []).includes(t.sessionId);
  chat.setNote(t && t.source !== "cloud" && composer.mode() === "conversation" ? conversationNote(t, open) : null);
}

function showTab(name: TabName): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) {
    const on = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $(`tab-${btn.dataset.tab}`).hidden = !on;
  }
  currentTab = name;
  updateComposer();
  try {
    localStorage.setItem("tab", name);
  } catch {
    // Storage may be unavailable; the tab just is not remembered.
  }
  if (name === "todo") void tasks.refresh();
  if (name === "history") history.refresh();
}

/** The composer sits under Chat and TODO, but not under the TODO tab's Log In button. */
function updateComposer(): void {
  $("composer").hidden = !tabHasComposer(currentTab) || (currentTab === "todo" && tasks.signedOut());
}

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")];
for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab as TabName));
  // Arrow keys move between tabs (the tablist pattern).
  btn.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabButtons[(tabButtons.indexOf(btn) + step + tabButtons.length) % tabButtons.length]!;
    next.focus();
    showTab(next.dataset.tab as TabName);
  });
}

const statusEl = $("status");
const statusAction = $<HTMLButtonElement>("status-action");

function renderStatus(s: UiState): void {
  const line = statusLine(s);
  statusEl.dataset.tone = line.tone;
  $("status-text").textContent = line.text;
  const metaEl = $("status-meta");
  if (line.tone === "ok") {
    const n = s.runningSessions?.length ?? (s.running ? 1 : 0);
    metaEl.textContent =
      n > 1
      ? `· ${n} running`
      : s.running
      ? `· ${clip(s.running.title, 60)}`
      : s.nextRunAt
        ? `· next check ${clockLabel(s.nextRunAt).replace(/^today /, "")}`
        : "";
    metaEl.title = (s.runningSessions ?? []).map((r) => r.title).join("\n") || (s.running?.title ?? "");
  } else {
    metaEl.textContent = "";
  }
  statusAction.hidden = false;
  const labels = { settings: "Fix", resume: "Resume", topup: "Top up", pause: "Pause" } as const;
  const titles = {
    settings: "Open the settings",
    resume: "Run scheduled tasks again",
    topup: "Buy usage credit (opens the billing page)",
    pause: "Pause scheduled runs",
  } as const;
  const action = line.action ?? "pause";
  // Pausing lives in Settings now; the header only offers actions that fix something.
  statusAction.hidden = action === "pause";
  const paused = action === "resume";
  const pauseItem = $("acct-pause");
  pauseItem.textContent = paused ? "Resume scheduled runs" : "Pause scheduled runs";
  pauseItem.dataset.paused = paused ? "1" : "";
  statusAction.textContent = labels[action];
  statusAction.dataset.action = action;
  statusAction.title = titles[action];
  $("live-dot").hidden = !s.running;
}

statusAction.addEventListener("click", () =>
  void busy(statusAction, async () => {
    const action = statusAction.dataset.action;
    if (action === "settings") return void openSettings("ai");
    if (action === "topup") return openTopup();
    try {
      applyState(await uiRequest({ type: action === "resume" ? "schedule.resume" : "schedule.pause" }));
    } catch (err) {
      $("status-text").textContent = errorText(err);
    }
  }),
);

/** The account's top-up page (the link a 402 carried, or the dashboard). */
function openTopup(): void {
  const a = state?.account;
  const url = a?.outOfCredit?.topupUrl || a?.dashboardUrl;
  if (url) window.open(url, "_blank", "noopener");
  else void openSettings("account");
}

// The account in the header: avatar, email, plan and credit, sign out.
const acct = $<HTMLDetailsElement>("acct");
function renderAccount(s: UiState): void {
  const a = s.account;
  // Always shown: signed out it offers Log in and Settings, signed in the account too.
  const signedIn = !!(a?.signedIn && a.user);
  acct.toggleAttribute("data-signed-in", signedIn);
  if (!signedIn || !a?.user) {
    $<HTMLImageElement>("acct-avatar").hidden = true;
    $("acct-initial").textContent = "";
    $("acct-btn").title = "Log in or open settings";
    return;
  }
  const u = a.user;
  const avatar = $<HTMLImageElement>("acct-avatar");
  const initial = $("acct-initial");
  const who = u.name ? `${u.name} (${u.email})` : u.email;
  $("acct-btn").title = `Signed in as ${who}`;
  $("acct-email").textContent = u.email;
  $("acct-email").title = who;
  if (u.pictureUrl) {
    if (avatar.getAttribute("src") !== u.pictureUrl) avatar.src = u.pictureUrl;
    avatar.hidden = false;
    initial.textContent = "";
  } else {
    avatar.hidden = true;
    initial.textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
  }
  const plan = $("acct-plan");
  const planName = a.plan ? `${a.plan.id.charAt(0).toUpperCase()}${a.plan.id.slice(1)} plan` : "";
  const credit = a.credit ? `${centsLabel(a.credit.totalCents)} usage credit` : "";
  plan.textContent = a.outOfCredit ? `${planName ? `${planName} · ` : ""}Out of usage credit` : [planName, credit].filter(Boolean).join(" · ");
  plan.dataset.tone = a.outOfCredit ? "warn" : "";
}
$("acct-avatar").addEventListener("error", () => {
  // The picture did not load: show the initial instead.
  $("acct-avatar").hidden = true;
  const u = state?.account?.user;
  if (u) $("acct-initial").textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
});
const pauseItem = $<HTMLButtonElement>("acct-pause");
pauseItem.addEventListener("click", () =>
  void busy(pauseItem, async () => {
    try {
      applyState(await uiRequest({ type: pauseItem.dataset.paused ? "schedule.resume" : "schedule.pause" }));
      acct.open = false;
    } catch (err) {
      $("status-text").textContent = errorText(err);
    }
  }),
);
$("acct-open-settings").addEventListener("click", () => {
  acct.open = false;
  void openSettings();
});
$("acct-login").addEventListener("click", () => {
  acct.open = false;
  // Same flow as the TODO tab's Log In button.
  showTab("todo");
  $<HTMLButtonElement>("login-btn").click();
});
$("acct-settings").addEventListener("click", () => {
  acct.open = false;
  void openSettings("account");
});
const signOutBtn = $<HTMLButtonElement>("acct-signout");
signOutBtn.addEventListener("click", () =>
  void busy(signOutBtn, async () => {
    try {
      applyState(await uiRequest({ type: "account.signOut" }));
      acct.open = false;
    } catch (err) {
      $("status-text").textContent = errorText(err);
    }
  }),
);
document.addEventListener("click", (e) => {
  if (acct.open && !acct.contains(e.target as Node)) acct.open = false;
});

function applyState(s: UiState): void {
  state = s;
  renderStatus(s);
  renderAccount(s);
  setTopupUrl(s.account?.outOfCredit?.topupUrl || s.account?.dashboardUrl || null);
  const running = s.runningSessions ?? (s.running ? [s.running] : []);
  chat.setRunning(running);
  composer.setRunning(running);
  composer.setState(s);
  tasks.setState(s);
  // A left running session that ended no longer needs hiding.
  for (const [tab, id] of [...left]) if (!running.some((r) => r.sessionId === id)) left.delete(tab);
  resolveChat();
  updateComposer();
  updateNote();
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
  }
}

/** Keep a port open; the background may restart, so reconnect and refetch state. */
function connect(): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: UI_PORT_NAME });
  } catch {
    setTimeout(connect, 2000);
    return;
  }
  port.onMessage.addListener((m: UiPush) => onPush(m));
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
  void loadState();
}

async function loadState(): Promise<void> {
  try {
    applyState(await uiRequest({ type: "state.get" }));
    // Plan and credit may have changed elsewhere; the fresh state arrives as a push.
    void uiRequest({ type: "account.refresh" }).then(applyState, () => {});
  } catch (err) {
    statusEl.dataset.tone = "bad";
    $("status-text").textContent = `Background not reachable: ${errorText(err)}`;
    statusAction.hidden = true;
  }
}

let saved: string | null = null;
try {
  saved = localStorage.getItem("tab");
} catch {
  // ignore
}
showTab(savedTab(saved));
// The TODO list also feeds Run now and the task counts, whichever tab opens first.
void tasks.refresh();
void trackTabs();
connect();
setInterval(() => {
  tasks.tick();
  if (state) renderStatus(state);
}, 60_000);
