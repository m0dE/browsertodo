/**
 * Contract between the UI pages (side panel, options) and the background
 * service worker. Requests go through chrome.runtime.sendMessage and always
 * resolve to UiResponse. Live updates go over a long-lived port named
 * UI_PORT_NAME that the side panel opens; the background pushes UiPush
 * messages on it.
 */
import type {
  BrainKind,
  ExtensionSettings,
  HelperInfo,
  LocalTask,
  RepeatRule,
  SessionInfo,
  StampedAgentEvent,
} from "@browsertodo/shared";
import type { VoiceClipRequest, VoiceTranscribeResult } from "./voice/transcribe.js";
import type { ApiKeyInfo, BillingAction, BillingLinkRequest, CreatedApiKey, CreditInfo, KeyRole, PlanId, PlanInfo } from "./account/types.js";

export type { ApiKeyInfo, BillingAction, BillingLinkRequest, CreatedApiKey, CreditInfo, KeyRole, PlanId, PlanInfo };

export const UI_PORT_NAME = "browsertodo-ui";

/** A file the user attached to a local task, sent from the UI as base64. */
export interface UiMediaUpload {
  name: string;
  type: string;
  dataBase64: string;
}

/** An edit of a task that is not running: only the fields given change (null clears). */
export interface TaskPatch {
  instructions?: string;
  account?: string | null;
  notBefore?: string | null;
  repeat?: RepeatRule | null;
}

export interface LocalMediaInfo {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface BrainStatus {
  /** What "auto" (or the chosen mode) resolves to right now; null = nothing usable. */
  effective: BrainKind | null;
  /** Human-readable reason when effective is null or differs from the choice. */
  note?: string;
  helper: HelperInfo | null;
  helperError?: string;
  hasApiKey: boolean;
  jevActive: boolean;
}

/** The browsertodo account (Google sign-in) as the UI shows it. */
export interface AccountView {
  signedIn: boolean;
  /** This build has a Google client ID (else Log In explains that sign-in is not set up). */
  signInConfigured: boolean;
  /** The account server (setting accountApiBase). */
  apiBase: string;
  /** Usage & billing dashboard (the API origin + "/"). */
  dashboardUrl: string;
  user?: { email: string; name: string | null; pictureUrl: string | null };
  /** Missing while the server has no billing (or it could not be loaded). */
  plan?: PlanInfo;
  credit?: CreditInfo;
  /** false: the server has no Stripe (billing buttons say so instead). undefined: not known yet. */
  stripeConfigured?: boolean;
  /** Loading the account failed (offline, server error). */
  error?: string;
  fetchedAt?: string;
  /** The hosted AI refused a request for lack of credit (or the credit is 0). */
  outOfCredit?: { topupUrl: string };
  /** Pending or paused local tasks that can be moved into the account (the offer after sign-in). */
  localTasks?: number;
}

export interface UiState {
  /** Secrets redacted to "set" / "" (see redactSettings). */
  settings: ExtensionSettings;
  brain: BrainStatus;
  /** The session started last among those running (null when idle). */
  running: SessionInfo | null;
  /** Every running session, oldest first: several tasks can run at once, each in its own tab. */
  runningSessions: SessionInfo[];
  /** Scheduled runs are paused (by the user or after repeated failures). */
  paused: boolean;
  pausedReason?: string;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
  /**
   * Conversations whose agent session is still open (a kept-open Claude Code
   * session in the helper, or Claude API history in memory): their next
   * message continues in that session. Others continue in a fresh session
   * that gets a summary.
   */
  openConversations: string[];
  /** Absent from older backgrounds: treated as signed out. */
  account?: AccountView;
  /**
   * Which conversation belongs to which browser tab (tab id -> session id):
   * the side panel shows the conversation of the tab active in its window.
   */
  tabChats?: Record<string, string>;
  /** The tabs each running session acts in right now (session id -> tab ids, its main tab first). */
  runningTabs?: Record<string, number[]>;
}

export type UiRequest =
  | { type: "state.get" }
  /** Partial update. Secret fields: omit to keep, "" to clear, a value to set. */
  | { type: "settings.save"; settings: Partial<ExtensionSettings> }
  | { type: "settings.testClaude" }
  | { type: "settings.testJev" }
  | { type: "settings.testCloud" }
  | { type: "helper.connect" }
  /** Start a one-off task now ("Do this now"). tabId: the browser tab it is started from (it acts there, the chat belongs to it). */
  | {
      type: "run.adhoc";
      instructions: string;
      account?: string;
      media?: UiMediaUpload[];
      tabId?: number;
      /** An empty message in Chat: look at the tab's page and do what is needed (instructions may be empty). */
      screen?: boolean;
    }
  /** Run everything that is due now (local, then cloud if enabled). */
  | { type: "run.due" }
  /** Stop one session (its current turn is paused), or everything running and the due run. */
  | { type: "run.stop"; sessionId?: string }
  /**
   * Continue a run that ended paused, failed or retry (e.g. stopped by the
   * user): the next turn of that conversation. text: an optional note.
   */
  | { type: "run.continue"; sessionId: string; text?: string; tabId?: number }
  /**
   * The user's message in a conversation: typed into its turn while one
   * runs, else its next turn (same session when still open, else a fresh one
   * with a summary). No sessionId: starts a new one-off conversation.
   * screen with an empty text: "look at the page and do what is needed"
   * (a new conversation, or the next turn: "look at the page now and continue").
   * tabId: the browser tab the message was sent from; the conversation
   * belongs to it (and a new one acts there).
   */
  | { type: "run.message"; sessionId?: string; text: string; tabId?: number; screen?: boolean }
  /**
   * The conversation is over: close its kept-open agent session (a running
   * turn keeps running). tabId: that tab has no conversation any more.
   */
  | { type: "run.newChat"; sessionId?: string; tabId?: number }
  /** "Open in Chat": the conversation now belongs to this browser tab (it leaves any other tab). */
  | { type: "chat.bind"; sessionId: string; tabId: number }
  /** Switch to a browser tab (another tab's chat): activates it and focuses its window. */
  | { type: "tab.focus"; tabId: number }
  /** The helper's raw run log of a Claude Code session's latest turn. */
  | { type: "session.log"; sessionId: string }
  /** Bring the agent's tab to the front: the session's, or the first agent tab. */
  | { type: "agent.show"; sessionId?: string }
  /** Type into a running agent session (default: the one started last). */
  | { type: "run.say"; text: string; sessionId?: string }
  | { type: "schedule.pause" }
  | { type: "schedule.resume" }
  | { type: "tasks.list" }
  | {
      type: "tasks.add";
      instructions: string;
      account?: string;
      notBefore?: string;
      repeat?: RepeatRule;
      media?: UiMediaUpload[];
    }
  | { type: "tasks.update"; id: string; patch: TaskPatch }
  | { type: "tasks.delete"; id: string }
  | { type: "tasks.retry"; id: string }
  /** Account tasks only: pending or paused tasks stop without running. */
  | { type: "tasks.cancel"; id: string }
  /** Google sign-in (opens Google's window), then the account's state. */
  | { type: "account.signIn" }
  | { type: "account.signOut" }
  /** Refetch profile, plan and credit (force: even when fetched a moment ago). */
  | { type: "account.refresh"; force?: boolean }
  /** Move the pending and paused local tasks (with files) into the account. */
  | { type: "account.migrate" }
  /** "Not now" on the offer to move local tasks. */
  | { type: "account.dismissMigration" }
  /** A Stripe page to open in a new tab (see BillingAction). */
  | ({ type: "account.billing" } & BillingLinkRequest)
  | { type: "account.keys.list" }
  | { type: "account.keys.create"; name: string; role: KeyRole }
  | { type: "account.keys.revoke"; id: string }
  /** Newest first; taskId: only that task's runs. */
  | { type: "sessions.list"; limit?: number; taskId?: string }
  | { type: "sessions.events"; sessionId: string }
  /** Site logins for get_credential (never used for X). Encrypted; unlocked per browser session. */
  | { type: "vault.list" }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.set"; site: string; username: string; password: string }
  | { type: "vault.delete"; site: string }
  /** Voice input: one clip of the live dictation to text, with the signed-in account (see voice/transcribe.ts). */
  | ({ type: "voice.transcribe" } & VoiceClipRequest);

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** How run.message delivered the user's text. */
export type MessageMode =
  /** Typed into the turn that is running. */
  | "inject"
  /** A new turn of an ended conversation (in its own agent session when it is still open, else a fresh one with a summary). */
  | "turn"
  /** No conversation given: a new one-off conversation. */
  | "new";

/** Result data per request type. */
export interface UiResults {
  "state.get": UiState;
  "settings.save": UiState;
  "settings.testClaude": { ok: boolean; detail: string };
  "settings.testJev": { ok: boolean; detail: string };
  "settings.testCloud": { ok: boolean; detail: string };
  "helper.connect": UiState;
  "run.adhoc": { sessionId: string };
  "run.due": { started: boolean; detail?: string };
  "run.stop": { ok: boolean };
  /** The conversation's session id (the same one). */
  "run.continue": { sessionId: string };
  "run.message": { sessionId: string; mode: MessageMode };
  "run.newChat": { ok: boolean };
  "chat.bind": UiState;
  "tab.focus": { ok: boolean };
  "session.log": { path: string; text: string; truncated: boolean };
  "agent.show": { ok: boolean };
  "run.say": { ok: boolean };
  "schedule.pause": UiState;
  "schedule.resume": UiState;
  /** source: the signed-in account's tasks, or this browser's (signed out). */
  /** locked: the account's plan does not include the TODO list; the tasks are read-only until the user subscribes. */
  "tasks.list": { tasks: (LocalTask & { media: LocalMediaInfo[] })[]; locked: boolean; source?: "local" | "account" };
  "tasks.add": { task: LocalTask };
  "tasks.update": { task: LocalTask };
  "tasks.delete": { ok: boolean };
  "tasks.retry": { task: LocalTask };
  "tasks.cancel": { task: LocalTask };
  "account.signIn": UiState;
  "account.signOut": UiState;
  "account.refresh": UiState;
  "account.migrate": { moved: number; failed: number; errors: string[]; state: UiState };
  "account.dismissMigration": UiState;
  "account.billing": { url: string };
  "account.keys.list": { keys: ApiKeyInfo[] };
  /** key: the new key, shown once. */
  "account.keys.create": CreatedApiKey;
  "account.keys.revoke": { ok: boolean };
  "sessions.list": { sessions: SessionInfo[] };
  "sessions.events": { session: SessionInfo; events: StampedAgentEvent[] };
  "vault.list": { locked: boolean; sites: string[] };
  "vault.unlock": { ok: boolean };
  "vault.lock": { ok: boolean };
  "vault.set": { ok: boolean };
  "vault.delete": { ok: boolean };
  /** Failures come back as data (plan, credit, ...), not as a failed request. */
  "voice.transcribe": VoiceTranscribeResult;
}

/** Pushed by the background on the UI port. */
export type UiPush =
  | { type: "state"; state: UiState }
  | { type: "event"; event: StampedAgentEvent }
  | { type: "session"; session: SessionInfo }
  | { type: "tasks.changed" }
  /** The keyboard shortcut: show the Chat tab and put the cursor in the input (see panel-command.ts). */
  | { type: "panel.focus" }
  /** The keyboard shortcut, pressed while the cursor is in the input: start or stop voice input. */
  | { type: "panel.voice" };

/** Typed helper for UI pages. */
export async function uiRequest<R extends UiRequest>(req: R): Promise<UiResults[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResults[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
