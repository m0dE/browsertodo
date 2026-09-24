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
  /** True when node-pty loaded, so the interactive terminal can start. */
  ptyAvailable: boolean;
  /** Result of the startup self-test (one tiny headless Claude Code call), once it has run. */
  selfTest?: { ok: boolean; error?: string; ms: number; at: string };
}

/** RPC methods the extension calls on the helper. */
export type HelperMethods = {
  /** selfTest: run (or re-run) the Claude Code self-test before answering. */
  "helper.hello": { params: { selfTest?: boolean }; result: HelperInfo };
  /**
   * Run one task with headless Claude Code. Resolves when it finishes (up to
   * maxTaskMinutes plus shutdown). Progress arrives as helper.event
   * notifications. mediaPaths are absolute local files the extension prepared.
   */
  "helper.runTask": {
    params: { sessionId: string; task: AgentTask; mediaPaths: string[]; config: RunConfig };
    result: TaskRunResult;
  };
  /** Type a message into the running task's Claude Code session. */
  "helper.sendUserMessage": { params: { sessionId: string; text: string }; result: { ok: boolean } };
  /** Stop the running task now and report it as paused with this reason. */
  "helper.forcePause": { params: { sessionId: string; reason: string }; result: { ok: true } };
  /** Stop the running task now and report it as failed. */
  "helper.abortTask": { params: { sessionId: string; reason: string }; result: { ok: true } };
  "helper.getLog": { params: { lines: number }; result: { text: string } };
  /**
   * Start the interactive Claude Code terminal (one at a time). It runs in
   * %LOCALAPPDATA%\browsertodo\workspace with browsertodo's browser tools
   * attached. Output arrives as helper.terminal.data notifications.
   */
  "helper.terminal.start": {
    /** jevApiKey: the extension's Jev key, so the terminal gets the fast act tool too. */
    params: { cols: number; rows: number; jevApiKey?: string };
    result: { terminalId: string };
  };
  /** Recent output of a running terminal (up to ~256 KB), to repaint a reopened panel. */
  "helper.terminal.backlog": { params: { terminalId: string }; result: { data: string } };
  "helper.terminal.input": { params: { terminalId: string; data: string }; result: { ok: true } };
  "helper.terminal.resize": { params: { terminalId: string; cols: number; rows: number }; result: { ok: true } };
  "helper.terminal.stop": { params: { terminalId: string }; result: { ok: true } };
};

/** Notifications the helper sends to the extension (no reply). */
export type HelperNotifications = {
  "helper.event": { sessionId: string; event: AgentEvent };
  /** Raw terminal output, batched to at most ~64 KB per message. */
  "helper.terminal.data": { terminalId: string; data: string };
  "helper.terminal.exit": { terminalId: string; exitCode: number | null };
};
