/**
 * Service worker entry. Every chrome event listener is registered
 * synchronously at the top level so Chrome can wake the worker for it.
 */
import { z } from "zod";
import { AgentWindow } from "./agent-window.js";
import { ApiClient } from "./api-client.js";
import { Cdp } from "./cdp.js";
import { Coordinator, type RunState } from "./coordinator.js";
import { Driver } from "./driver.js";
import { HelperLink, type HelperPeer } from "./helper-link.js";
import { handleUiMessage, type MessageDeps, type UiMessage } from "./messages.js";
import { notify } from "./notify.js";
import { ALARM_NAME, ensureAlarm, getRunnerId, handleStorageChange, loadSettings } from "./settings-store.js";
import { Vault } from "./vault.js";

// MV3 forbids eval; stop zod from probing for it.
z.config({ jitless: true });

const RUN_STATE_KEY = "runState";

const cdp = new Cdp();
const agentWindow = new AgentWindow();
const driver = new Driver(cdp, agentWindow);
const vault = new Vault();

function registerHandlers(peer: HelperPeer): void {
  peer.handle("browser.navigate", (p) => driver.navigate(p));
  peer.handle("browser.readPage", () => driver.readPage());
  peer.handle("browser.screenshot", () => driver.screenshot());
  peer.handle("browser.click", (p) => driver.click(p));
  peer.handle("browser.type", (p) => driver.type(p));
  peer.handle("browser.paste", (p) => driver.paste(p));
  peer.handle("browser.pressKey", (p) => driver.pressKey(p));
  peer.handle("browser.scroll", (p) => driver.scroll(p));
  peer.handle("browser.upload", (p) => driver.upload(p));
  peer.handle("browser.currentUrl", () => driver.currentUrl());
  peer.handle("vault.getCredential", (p) => vault.getCredential(p.site));
}

const helper = new HelperLink({ registerHandlers });

async function readRunState(): Promise<RunState> {
  const got = await chrome.storage.session.get(RUN_STATE_KEY);
  const s = (got[RUN_STATE_KEY] ?? {}) as Partial<RunState>;
  return {
    running: s.running ?? false,
    currentTaskId: s.currentTaskId ?? null,
    lastRunAt: s.lastRunAt ?? null,
    lastError: s.lastError ?? null,
  };
}

async function saveRunState(patch: Partial<RunState>): Promise<void> {
  const next = { ...(await readRunState()), ...patch };
  await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
}

const coordinator = new Coordinator({
  loadSettings,
  getRunnerId,
  createApi: (s) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey }),
  helper,
  prepareTab: async () => {
    cdp.reset();
    await driver.ready();
  },
  isAgentTab: (tabId) => agentWindow.isAgentTab(tabId),
  screenshot: () => driver.screenshot(),
  notify,
  saveState: saveRunState,
  log: (m) => console.log("[browsertodo]", m),
});
cdp.onUserCancel = () => void coordinator.onDebuggerCanceled();

const messageDeps: MessageDeps = {
  runNow: () => void coordinator.run("manual"),
  runState: readRunState,
  helperInfo: () => helper.info,
  connectHelper: () => helper.connect(10_000),
  getLog: (lines) => helper.call("helper.getLog", { lines }, { timeoutMs: 10_000 }),
  vault,
  testApi: (s) => new ApiClient({ apiBase: s.apiBase, runnerKey: s.runnerKey }).check(),
  loadSettings,
};

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => void ensureAlarm());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void coordinator.run("alarm");
});
chrome.storage.onChanged.addListener((changes, area) => void handleStorageChange(changes, area));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => void coordinator.onTabUpdated(tabId, changeInfo));
chrome.debugger.onDetach.addListener((source, reason) => cdp.handleDetach(source, String(reason)));
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((msg: UiMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  void handleUiMessage(msg, messageDeps).then(sendResponse);
  return true;
});

// A fresh worker has no active run, whatever the stored state says.
void saveRunState({ running: false, currentTaskId: null });
void ensureAlarm();

// Test hook for the Playwright smoke and e2e suites (service worker scope only).
(globalThis as unknown as { __browsertodo: unknown }).__browsertodo = { driver, coordinator, helper, vault, cdp, agentWindow };
