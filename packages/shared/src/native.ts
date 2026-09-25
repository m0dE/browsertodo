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

/**
 * A terminal (PTY) running in the helper: the user's own interactive Claude
 * Code session, or the Claude Code session of a running task.
 */
export interface TerminalInfo {
  terminalId: string;
  kind: "task" | "user";
  /** The task's title for task terminals, "Claude Code" for the user's session. */
  title: string;
  /** The task's session id (task terminals only). */
  sessionId?: string;
}

export interface HelperInfo {
  version: string;
  jevAvailable: boolean;
  /** Absolute path of claude.exe, "scripted" in test mode, or null when not found. */
  claudePath: string | null;
  logDir: string;
  /**
   * True when node-pty loaded: the interactive terminal can start, and Claude
   * Code tasks run as real interactive sessions in a task terminal (headless otherwise).
   */
  ptyAvailable: boolean;
  /** Terminals running right now, so a reconnecting extension finds a running task's session. */
  terminals?: TerminalInfo[];
  /** Result of the startup self-test (one tiny headless Claude Code call), once it has run. */
  selfTest?: { ok: boolean; error?: string; ms: number; at: string };
}

/** RPC methods the extension calls on the helper. */
export type HelperMethods = {
  /** selfTest: run (or re-run) the Claude Code self-test before answering. */
  "helper.hello": { params: { selfTest?: boolean }; result: HelperInfo };
  /**
   * Run one task with Claude Code: a real interactive session in a task
   * terminal (announced with helper.terminal.opened) when node-pty is
   * available, else headless. Resolves when it finishes (up to
   * maxTaskMinutes plus shutdown). Progress arrives as helper.event
   * notifications. mediaPaths are absolute local files the extension prepared.
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
   * Close a kept-open session (Claude Code exits; its terminal reports
   * helper.terminal.exit). Sessions also close after 30 idle minutes, on
   * helper shutdown, and when a 4th would open (the oldest idle one closes).
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
   * Start the user's interactive Claude Code terminal (one at a time; task
   * terminals run beside it). It runs in %LOCALAPPDATA%\browsertodo\workspace
   * with browsertodo's browser tools attached. Output arrives as
   * helper.terminal.data notifications.
   */
  "helper.terminal.start": {
    /** jevApiKey: the extension's Jev key, so the terminal gets the fast act tool too. */
    params: { cols: number; rows: number; jevApiKey?: string };
    result: { terminalId: string };
  };
  /** Terminals running right now, task and user. */
  "helper.terminal.list": { params: Record<string, never>; result: { terminals: TerminalInfo[] } };
  /** Recent output of a running terminal (up to ~256 KB), to repaint a reopened panel. */
  "helper.terminal.backlog": { params: { terminalId: string }; result: { data: string } };
  /**
   * Keystrokes for a terminal. Task terminals answer the TUI's capability
   * queries in the helper, so xterm.js's own answers are dropped from their input.
   */
  "helper.terminal.input": { params: { terminalId: string; data: string }; result: { ok: true } };
  "helper.terminal.resize": { params: { terminalId: string; cols: number; rows: number }; result: { ok: true } };
  "helper.terminal.stop": { params: { terminalId: string }; result: { ok: true } };
};

/** Notifications the helper sends to the extension (no reply). */
export type HelperNotifications = {
  "helper.event": { sessionId: string; event: AgentEvent };
  /** A terminal started: the user's session, or a task's Claude Code session. */
  "helper.terminal.opened": TerminalInfo;
  /** Raw terminal output, batched to at most ~64 KB per message. */
  "helper.terminal.data": { terminalId: string; data: string };
  "helper.terminal.exit": { terminalId: string; exitCode: number | null };
};
