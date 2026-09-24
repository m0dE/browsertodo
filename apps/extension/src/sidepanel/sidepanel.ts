/** Side panel entry: status line, tabs, and the push port to the background. */
import { UI_PORT_NAME, uiRequest, type UiPush, type UiState } from "../ui-protocol.js";
import { initActivity } from "./activity.js";
import { initComposer } from "./composer.js";
import { $, busy, errorText } from "./dom.js";
import { clip, clockLabel, statusLine } from "./format.js";
import { initTasks } from "./tasks.js";
import { initTerminal } from "./terminal.js";

type TabName = "tasks" | "activity" | "terminal";

let state: UiState | null = null;

const tasks = initTasks({ onStarted: () => showTab("activity") });
const composer = initComposer({ onStarted: () => showTab("activity"), onState: (s) => applyState(s) });
const activity = initActivity();
const terminal = initTerminal();

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
  // The terminal has its own input; the composer serves Tasks and Activity.
  composer.setVisible(name !== "terminal");
  if (name === "terminal") terminal.onShow();
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
    metaEl.textContent = s.running
      ? `· ${clip(s.running.title, 60)}`
      : s.nextRunAt
        ? `· next check ${clockLabel(s.nextRunAt).replace(/^today /, "")}`
        : "";
    metaEl.title = s.running?.title ?? "";
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
  activity.setRunning(s.running);
  composer.setRunning(!!s.running);
  composer.setState(s);
  terminal.onState(s);
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
      if (msg.session.endedAt && msg.session.source === "local") void tasks.refresh();
      break;
    case "tasks.changed":
      void tasks.refresh();
      break;
    case "terminal.data":
      terminal.onData(msg.terminalId, msg.data);
      break;
    case "terminal.exit":
      terminal.onExit(msg.terminalId, msg.exitCode);
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
  const saved = localStorage.getItem("tab");
  if (saved === "activity" || saved === "terminal") initial = saved;
} catch {
  // ignore
}
showTab(initial);
connect();
setInterval(() => {
  tasks.tick();
  if (state) renderStatus(state);
}, 60_000);
