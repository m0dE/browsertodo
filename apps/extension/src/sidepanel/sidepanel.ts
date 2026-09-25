/** Side panel entry: status line, tabs, and the push port to the background. */
import type { SessionInfo } from "@browsertodo/shared";
import { UI_PORT_NAME, uiRequest, type UiPush, type UiState } from "../ui-protocol.js";
import { initActivity } from "./activity.js";
import { initComposer } from "./composer.js";
import { $, busy, errorText } from "./dom.js";
import { clip, clockLabel, conversationNote, statusLine } from "./format.js";
import { initTasks } from "./tasks.js";

type TabName = "tasks" | "activity";

let state: UiState | null = null;
/** The conversation the Activity tab shows. */
let focused: SessionInfo | null = null;

/** A message or a continue went out: show the conversation it went to. */
const followLive = (sessionId?: string) => {
  showTab("activity");
  activity.followLive(sessionId);
};
const tasks = initTasks({ onStarted: () => showTab("activity"), onContinued: followLive });
const composer = initComposer({ onStarted: followLive, onState: (s) => applyState(s), onTargetChange: () => updateNote() });
const activity = initActivity({
  // Continue in an end card: the next message goes to that conversation.
  onContinue: (sessionId) => composer.focusConversation(sessionId),
  onFocus: (s) => {
    focused = s;
    composer.setConversation(s);
    updateNote();
  },
});

/** "Conversation open · …" under the Activity header while the composer's conversation waits for a message. */
function updateNote(): void {
  const t = composer.target();
  const open = !!t && (state?.openConversations ?? []).includes(t.sessionId);
  activity.setNote(t && t.source !== "cloud" && composer.mode() === "conversation" ? conversationNote(t, open) : null);
}

function showTab(name: TabName): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) {
    const on = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(on));
    $(`tab-${btn.dataset.tab}`).hidden = !on;
  }
  try {
    localStorage.setItem("tab", name);
  } catch {
    // Storage may be unavailable; the tab just is not remembered.
  }
  if (name === "tasks") void tasks.refresh();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab as TabName));
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
  statusAction.textContent = line.action === "settings" ? "Fix" : line.action === "resume" ? "Resume" : "Pause";
  statusAction.dataset.action = line.action ?? "pause";
  statusAction.title = line.action ? "" : "Pause scheduled runs";
  $("live-dot").hidden = !s.running;
}

statusAction.addEventListener("click", () =>
  void busy(statusAction, async () => {
    const action = statusAction.dataset.action;
    if (action === "settings") return void chrome.runtime.openOptionsPage();
    try {
      applyState(await uiRequest({ type: action === "resume" ? "schedule.resume" : "schedule.pause" }));
    } catch (err) {
      $("status-text").textContent = errorText(err);
    }
  }),
);
$("open-settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());

function applyState(s: UiState): void {
  state = s;
  renderStatus(s);
  const running = s.runningSessions ?? (s.running ? [s.running] : []);
  activity.setRunning(running);
  composer.setRunning(running);
  composer.setState(s);
  updateNote();
}

function onPush(msg: UiPush): void {
  switch (msg.type) {
    case "state":
      applyState(msg.state);
      break;
    case "event":
      activity.onEvent(msg.event);
      break;
    case "session":
      activity.onSession(msg.session);
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
  } catch (err) {
    statusEl.dataset.tone = "bad";
    $("status-text").textContent = `Background not reachable: ${errorText(err)}`;
    statusAction.hidden = true;
  }
}

let initial: TabName = "tasks";
try {
  if (localStorage.getItem("tab") === "activity") initial = "activity";
} catch {
  // ignore
}
showTab(initial);
connect();
setInterval(() => {
  tasks.tick();
  if (state) renderStatus(state);
}, 60_000);
