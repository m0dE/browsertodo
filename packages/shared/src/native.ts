import type { AgentEvent } from "./events.js";
import type { TaskOutcome } from "./task.js";

/** Native messaging host name registered with Chrome. */
export const NATIVE_HOST_NAME = "com.browsertodo.helper";

/** Limits and options for one task run, sent by the extension with runTask. */
export interface RunConfig {
  maxToolCalls: number;
  maxTaskMinutes: number;
  jevEnabled: boolean;
  jevThreshold: number;
  /** Jev key from the extension settings. The helper falls back to TYPESAFE_API_KEY. */
  jevApiKey?: string;
  /**
   * Claude model from the extension settings (e.g. "claude-sonnet-5"), so both
   * brains run the same model. The helper falls back to BROWSERTODO_MODEL, then "sonnet".
   */
  model?: string;
  /**
   * True when an earlier attempt of this task may have crashed after acting.
   * The agent must first check whether the work was already done (for posts:
   * look for it on the profile) instead of repeating it.
   */
  isRetry: boolean;
}

/** The task as the agent sees it. */
export interface AgentTask {
  id: string;
  instructions: string;
  account: string | null;
}

/** How a task run ended, as reported by either brain. */
export interface TaskRunResult {
  outcome: TaskOutcome;
  summary?: string;
  url?: string;
  reason?: string;
  logPath?: string;
}

export interface HelperInfo {
  version: string;
  jevAvailable: boolean;
  /** Absolute path of claude.exe, "scripted" in test mode, or null when not found. */
  claudePath: string | null;
  logDir: string;
  /**
   * Claude Code task sessions whose agent is alive (running a turn, or idle
   * and kept open for follow-ups), so a reconnecting extension knows which
   * conversations can continue in their own session. Updates arrive as
   * helper.sessions notifications.
   */
  openSessions?: string[];
  /** Result of the startup self-test (one tiny headless Claude Code call), once it has run. */
  selfTest?: { ok: boolean; error?: string; ms: number; at: string };
}

/** RPC methods the extension calls on the helper. */
export type HelperMethods = {
  /** selfTest: run (or re-run) the Claude Code self-test before answering. */
  "helper.hello": { params: { selfTest?: boolean }; result: HelperInfo };
  /**
   * Run one task with Claude Code (headless, stream-json in and out; stdin
   * stays open so the session can take follow-up turns). Resolves when the
   * turn ends (up to maxTaskMinutes plus shutdown). Progress arrives as
   * helper.event notifications. mediaPaths are absolute local files the
   * extension prepared.
   */
  "helper.runTask": {
    params: { sessionId: string; task: AgentTask; mediaPaths: string[]; config: RunConfig };
    result: TaskRunResult;
  };
  /**
   * The next user message in a session kept open after its turn (Claude Code
   * stays alive, idle, after each task_* call). Typed in as a follow-up, as a
   * new turn with this config's limits; resolves like runTask when the next
   * task_* call arrives. Rejects with "session ended" when the session's agent
   * is gone (idle timeout, ended, crashed, or never kept open): start a fresh
   * runTask instead. Rejects with "busy" while another turn runs.
   */
  "helper.continueSession": { params: { sessionId: string; text: string; config: RunConfig }; result: TaskRunResult };
  /**
   * Close a kept-open session (Claude Code exits). Sessions also close after
   * 30 idle minutes, on helper shutdown, and when a 4th would open (the
   * oldest idle one closes).
   * ok: false when there was no such session.
   */
  "helper.endSession": { params: { sessionId: string }; result: { ok: boolean } };
  /** Type a message into the running task's Claude Code session. */
  "helper.sendUserMessage": { params: { sessionId: string; text: string }; result: { ok: boolean } };
  /** Stop the running task now and report it as paused with this reason. */
  "helper.forcePause": { params: { sessionId: string; reason: string }; result: { ok: true } };
  /** Stop the running task now and report it as failed. */
  "helper.abortTask": { params: { sessionId: string; reason: string }; result: { ok: true } };
  "helper.getLog": { params: { lines: number }; result: { text: string } };
  /**
   * The tail of a task session's run log (TaskRunResult.logPath, JSONL of
   * every Claude Code stream event, tool call and result). Only paths inside
   * the helper's runs folder. maxBytes: at most 256 KB (the default).
   */
  "helper.runLog": { params: { path: string; maxBytes?: number }; result: { text: string; truncated: boolean } };
};

/** Notifications the helper sends to the extension (no reply). */
export type HelperNotifications = {
  "helper.event": { sessionId: string; event: AgentEvent };
  /** The open task sessions changed (one started, or one closed: ended, idle timeout, crash, abort). */
  "helper.sessions": { open: string[] };
};
