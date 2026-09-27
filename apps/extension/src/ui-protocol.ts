/**
 * Contract between the UI pages (side panel, options) and the background
 * service worker. Requests go through chrome.runtime.sendMessage and always
 * resolve to UiResponse. Live updates go over a long-lived port named
 * UI_PORT_NAME that the side panel opens; the background pushes UiPush
 * messages on it.
 */
import type {
  ApprovalAnswer,
  BrainKind,
  ExtensionSettings,
  HelperInfo,
  LocalTask,
  MemoryEntry,
  RepeatSchedule,
  SessionInfo,
  StampedAgentEvent,
  TraceEvent,
} from "@browsertodo/shared";
import type { TraceBook } from "./trace/trace-book.js";
import type { MemorySyncStatus } from "./memory/sync.js";
import type { RealtimeTicketResult, VoiceEnginesResult } from "./voice/realtime-access.js";
import type { VoiceClipRequest, VoiceTranscribeResult } from "./voice/transcribe.js";
import type { VoiceSessionView } from "./voice-session.js";
import type { ApiKeyInfo, CreatedApiKey, CreditInfo, KeyRole, PlanId, PlanInfo } from "./account/types.js";

export type { ApiKeyInfo, CreatedApiKey, CreditInfo, KeyRole, PlanId, PlanInfo };

export const UI_PORT_NAME = "browsertodo-ui";

/** A file the user attached to a local task, sent from the UI as base64. */
export interface UiMediaUpload {
  name: string;
  type: string;
  dataBase64: string;
}

/**
 * An edit of a task that is not running: only the fields given change (null
 * clears). A new repeat rule goes with its first time (notBefore; none: its
 * next time); notBefore alone moves only the time.
 */
export interface TaskPatch {
  instructions?: string;
  account?: string | null;
  notBefore?: string | null;
  repeat?: RepeatSchedule | null;
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
  /** The dashboard's home (usage), at the account server's origin (account/dashboard.ts). */
  dashboardUrl: string;
  /** The dashboard's Billing page: plans, top-ups and invoices. Every upgrade button opens it (ui/billing.ts). */
  billingUrl: string;
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
  outOfCredit?: true;
  /** Pending or paused local tasks that can be moved into the account (the offer after sign-in). */
  localTasks?: number;
}

export interface UiState {
  /**
   * When the background read this state (increasing, a clock in ms): a UI keeps the state with the highest rev,
   * since pushes and request answers can reach it out of order. Absent in states made up by tests.
   */
  rev?: number;
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
  /**
   * Signed in to another account than this computer's memory was synced with: nothing is sent until the user
   * answers "Add this computer's memory to <account>?" (memory.syncChoice). Absent: nothing to ask.
   */
  memoryQuestion?: { account: string };
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
      /** Correlation id of this message in the conversation's trace (the panel's own timings of it carry the same). */
      cid?: string;
      /** The new chat was started with memory off (its SessionInfo.memoryOff). */
      memoryOff?: true;
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
   * belongs to it (and a new one acts there). voice: the text was spoken.
   * context: what the agent is told with the message but the chat does not show as the user's words (hands-free:
   * the note on the tab the user looks at).
   */
  | { type: "run.message"; sessionId?: string; text: string; tabId?: number; screen?: boolean; voice?: boolean; cid?: string; memoryOff?: true; context?: string }
  /**
   * The conversation is over: close its kept-open agent session (a running
   * turn keeps running). tabId: that tab has no conversation any more.
   */
  | { type: "run.newChat"; sessionId?: string; tabId?: number }
  /** A run picked in History: the conversation now belongs to this browser tab (it leaves any other tab). */
  | { type: "chat.bind"; sessionId: string; tabId: number }
  /** Undo on a scheduled card: the task the agent put in the TODO list (schedule_task) is deleted, and the card says so. */
  | { type: "chat.undoScheduled"; sessionId: string; taskId: string }
  /** Undo on a "Remembered" note: that memory change is undone (the entry is as it was before), and the note says so. */
  | { type: "memory.undo"; sessionId: string; changeId: string }
  /** Memory on or off for one conversation (the composer's menu). */
  | { type: "chat.setMemory"; sessionId: string; on: boolean }
  /** Settings > Memory: every entry the agent keeps. */
  | { type: "memory.list" }
  /** The user's edit of an entry (refused when it holds a secret). */
  | { type: "memory.edit"; id: string; subject: string; text: string }
  | { type: "memory.delete"; id: string }
  /** Settings > Memory: give this entry at the start of every turn (pinned), or only when it is relevant. */
  | { type: "memory.pin"; id: string; pinned: boolean }
  /** Delete everything one repeating task keeps (its run notes and records). */
  | { type: "memory.deleteTask"; taskKey: string }
  /** Forget everything. */
  | { type: "memory.clear" }
  /** The answer to "Add this computer's memory to <account>?" (UiState.memoryQuestion): add it, or keep it separate. */
  | { type: "memory.syncChoice"; add: boolean }
  /** The user's answer on an approval card (or by voice): the waiting action runs or is refused. */
  | { type: "approval.answer"; sessionId: string; id: string; answer: ApprovalAnswer; by?: "voice" }
  /** Switch to a browser tab (another tab's chat): activates it and focuses its window. */
  | { type: "tab.focus"; tabId: number }
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
      repeat?: RepeatSchedule;
      media?: UiMediaUpload[];
    }
  | { type: "tasks.update"; id: string; patch: TaskPatch }
  /** Run on a TODO row: that task now, whatever its time (a stopped one starts over). */
  | { type: "tasks.run"; id: string }
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
  /** Erase every saved login and the passphrase (the only way out of a forgotten passphrase). */
  | { type: "vault.reset" }
  /** Standard hands-free voice: one clip of the live transcription to text, with the signed-in account (see voice/transcribe.ts). */
  | ({ type: "voice.transcribe" } & VoiceClipRequest)
  /** Hands-free voice: the engines and what a minute of each costs (the account server's list). */
  | { type: "voice.engines" }
  /** Realtime voice: where to connect and the token to offer (sessionId: the chat, recorded with the usage). */
  | { type: "voice.realtime"; sessionId?: string }
  /** Hands-free voice said a line in this conversation: kept in its thread (a "spoken" event). */
  | { type: "voice.spoken"; sessionId: string; text: string }
  /**
   * What the user said in Realtime hands-free voice, word for word: kept in its thread (a "heard" event).
   * sent: the request the narrator passed to the agent for it.
   */
  | { type: "voice.heard"; sessionId: string; text: string; sent?: string; early?: true }
  /** The side panel's timings of a conversation (voice, sending), for its trace. */
  | { type: "trace.add"; sessionId: string; events: TraceEvent[] }
  /** The Raw view: the whole conversation, its timing trace, and what it ran on. */
  | { type: "trace.get"; sessionId: string };

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
  "chat.undoScheduled": { ok: boolean };
  "memory.undo": { ok: boolean };
  "chat.setMemory": { session: SessionInfo };
  /** sync: whether memory syncs with the account (absent: this build has no sync). */
  "memory.list": { entries: MemoryEntry[]; sync?: MemorySyncStatus };
  "memory.edit": { entry: MemoryEntry };
  "memory.delete": { ok: boolean };
  "memory.pin": { entry: MemoryEntry };
  /** How many entries went. */
  "memory.deleteTask": { removed: number };
  /** How many entries were forgotten. */
  "memory.clear": { removed: number };
  /** Whether memory syncs now. */
  "memory.syncChoice": { sync: MemorySyncStatus };
  /** ok false: the request no longer waits (answered, timed out, its turn ended). */
  "approval.answer": { ok: boolean };
  "tab.focus": { ok: boolean };
  "agent.show": { ok: boolean };
  "run.say": { ok: boolean };
  "schedule.pause": UiState;
  "schedule.resume": UiState;
  /** source: the signed-in account's tasks, or this browser's (signed out). */
  /** locked: the account's plan does not include the TODO list; the tasks are read-only until the user subscribes. */
  "tasks.list": { tasks: (LocalTask & { media: LocalMediaInfo[] })[]; locked: boolean; source?: "local" | "account" };
  "tasks.add": { task: LocalTask };
  "tasks.update": { task: LocalTask };
  "tasks.run": { sessionId: string };
  "tasks.delete": { ok: boolean };
  "tasks.retry": { task: LocalTask };
  "tasks.cancel": { task: LocalTask };
  "account.signIn": UiState;
  "account.signOut": UiState;
  "account.refresh": UiState;
  "account.migrate": { moved: number; failed: number; errors: string[]; state: UiState };
  "account.dismissMigration": UiState;
  "account.keys.list": { keys: ApiKeyInfo[] };
  /** key: the new key, shown once. */
  "account.keys.create": CreatedApiKey;
  "account.keys.revoke": { ok: boolean };
  "sessions.list": { sessions: SessionInfo[] };
  "sessions.events": { session: SessionInfo; events: StampedAgentEvent[] };
  /** exists: a passphrase has been set; false: the next unlock chooses one. Site names are listed even while locked. */
  "vault.list": { exists: boolean; locked: boolean; sites: string[] };
  /** ok: false is a wrong passphrase (other failures are errors). */
  "vault.unlock": { ok: boolean };
  "vault.lock": { ok: boolean };
  "vault.set": { ok: boolean };
  "vault.delete": { ok: boolean };
  "vault.reset": { ok: boolean };
  /** Failures come back as data (plan, credit, ...), not as a failed request. */
  "voice.transcribe": VoiceTranscribeResult;
  "voice.engines": VoiceEnginesResult;
  "voice.realtime": RealtimeTicketResult;
  "voice.spoken": { ok: boolean };
  "voice.heard": { ok: boolean };
  "trace.add": { ok: boolean };
  "trace.get": RawTrace;
}

/** What the background knows about where a conversation ran (the panel adds its own: voice, display). */
export interface TraceEnv {
  extensionVersion: string;
  /** The browser as it names itself (navigator.userAgent) and the OS (chrome.runtime.getPlatformInfo). */
  userAgent: string;
  os?: string;
  arch?: string;
  helper: { version: string; brain: string; jev: boolean } | null;
}

/** trace.get: a conversation in full (events as stored), with its timing trace. */
export interface RawTrace {
  session: SessionInfo;
  events: StampedAgentEvent[];
  /** Null for conversations from before traces were kept. */
  trace: TraceBook | null;
  env: TraceEnv;
}

/** Pushed by the background on the UI port. */
export type UiPush =
  | { type: "state"; state: UiState }
  | { type: "event"; event: StampedAgentEvent }
  | { type: "session"; session: SessionInfo }
  | { type: "tasks.changed" }
  /**
   * A keyboard shortcut: show the Chat tab and put the cursor in the input (see panel-command.ts);
   * `draft`: the text the box had before the shortcut recreated the panel.
   */
  | { type: "panel.focus"; draft?: string }
  /** The voice shortcut: hands-free voice on or off (as the mic button). */
  | { type: "panel.voice" }
  /** The hands-free session (null: none is on), and the tab the user looks at: when it changes, and when a panel connects. */
  | { type: "voice.session"; session: VoiceSessionView | null }
  /** To the panel running the hands-free session: end it (Stop, or Use voice here, in another tab's panel). */
  | { type: "voice.stop" };

/** Typed helper for UI pages. */
export async function uiRequest<R extends UiRequest>(req: R): Promise<UiResults[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResults[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** `next` is older than the state the UI has (see UiState.rev). */
export function isStale(next: Pick<UiState, "rev">, current: Pick<UiState, "rev"> | null): boolean {
  return next.rev !== undefined && current?.rev !== undefined && next.rev < current.rev;
}
