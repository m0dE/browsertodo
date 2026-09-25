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

export const UI_PORT_NAME = "browsertodo-ui";

/** A file the user attached to a local task, sent from the UI as base64. */
export interface UiMediaUpload {
  name: string;
  type: string;
  dataBase64: string;
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
}

export type UiRequest =
  | { type: "state.get" }
  /** Partial update. Secret fields: omit to keep, "" to clear, a value to set. */
  | { type: "settings.save"; settings: Partial<ExtensionSettings> }
  | { type: "settings.testClaude" }
  | { type: "settings.testJev" }
  | { type: "settings.testCloud" }
  | { type: "helper.connect" }
  /** Start a one-off task now ("Do this now"). */
  | { type: "run.adhoc"; instructions: string; account?: string; media?: UiMediaUpload[] }
  /** Run everything that is due now (local, then cloud if enabled). */
  | { type: "run.due" }
  /** Stop one session (its current turn is paused), or everything running and the due run. */
  | { type: "run.stop"; sessionId?: string }
  /**
   * Continue a run that ended paused, failed or retry (e.g. stopped by the
   * user): the next turn of that conversation. text: an optional note.
   */
  | { type: "run.continue"; sessionId: string; text?: string }
  /**
   * The user's message in a conversation: typed into its turn while one
   * runs, else its next turn (same session when still open, else a fresh one
   * with a summary). No sessionId: starts a new one-off conversation.
   */
  | { type: "run.message"; sessionId?: string; text: string }
  /** The conversation is over: close its kept-open agent session (a running turn keeps running). */
  | { type: "run.newChat"; sessionId?: string }
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
  | { type: "tasks.update"; id: string; patch: { instructions?: string; account?: string | null; notBefore?: string | null; repeat?: RepeatRule | null } }
  | { type: "tasks.delete"; id: string }
  | { type: "tasks.retry"; id: string }
  | { type: "sessions.list"; limit?: number }
  | { type: "sessions.events"; sessionId: string }
  /** Site logins for get_credential (never used for X). Encrypted; unlocked per browser session. */
  | { type: "vault.list" }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.set"; site: string; username: string; password: string }
  | { type: "vault.delete"; site: string };

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

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
  /** mode: "inject" typed into the running turn, "turn" a new turn of the conversation, "new" a new conversation. */
  "run.message": { sessionId: string; mode: "inject" | "turn" | "new" };
  "run.newChat": { ok: boolean };
  "session.log": { path: string; text: string; truncated: boolean };
  "agent.show": { ok: boolean };
  "run.say": { ok: boolean };
  "schedule.pause": UiState;
  "schedule.resume": UiState;
  "tasks.list": { tasks: (LocalTask & { media: LocalMediaInfo[] })[] };
  "tasks.add": { task: LocalTask };
  "tasks.update": { task: LocalTask };
  "tasks.delete": { ok: boolean };
  "tasks.retry": { task: LocalTask };
  "sessions.list": { sessions: SessionInfo[] };
  "sessions.events": { session: SessionInfo; events: StampedAgentEvent[] };
  "vault.list": { locked: boolean; sites: string[] };
  "vault.unlock": { ok: boolean };
  "vault.lock": { ok: boolean };
  "vault.set": { ok: boolean };
  "vault.delete": { ok: boolean };
}

/** Pushed by the background on the UI port. */
export type UiPush =
  | { type: "state"; state: UiState }
  | { type: "event"; event: StampedAgentEvent }
  | { type: "session"; session: SessionInfo }
  | { type: "tasks.changed" };

/** Typed helper for UI pages. */
export async function uiRequest<R extends UiRequest>(req: R): Promise<UiResults[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResults[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
