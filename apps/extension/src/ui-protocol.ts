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
  running: SessionInfo | null;
  /** Scheduled runs are paused (by the user or after repeated failures). */
  paused: boolean;
  pausedReason?: string;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
  terminal: { terminalId: string } | null;
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
  | { type: "run.stop" }
  /** Bring the agent's window to the front. */
  | { type: "agent.show" }
  /** Type into the running agent session. */
  | { type: "run.say"; text: string }
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
  | { type: "terminal.start"; cols: number; rows: number }
  | { type: "terminal.input"; data: string }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "terminal.stop" }
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
  /** backlog: recent output when attaching to an already running terminal. */
  "terminal.start": { terminalId: string; backlog?: string };
  "terminal.input": { ok: boolean };
  "terminal.resize": { ok: boolean };
  "terminal.stop": { ok: boolean };
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
  | { type: "tasks.changed" }
  | { type: "terminal.data"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string; exitCode: number | null };

/** Typed helper for UI pages. */
export async function uiRequest<R extends UiRequest>(req: R): Promise<UiResults[R["type"]]> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<UiResults[R["type"]]> | undefined;
  if (!res) throw new Error("No response from the extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
