import type { ClaimResponse, TaskOutcome } from "./task.js";

/** Native messaging host name registered with Chrome. */
export const NATIVE_HOST_NAME = "com.browsertodo.helper";

/** Settings for one task run, sent by the extension with runTask. */
export interface RunConfig {
  /** API base URL without trailing slash, e.g. https://api.example.com */
  apiBase: string;
  runnerKey: string;
  maxToolCalls: number;
  maxTaskMinutes: number;
  jevEnabled: boolean;
  jevThreshold: number;
}

/** How a task run ended, as reported by the helper. */
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
  claudePath: string | null;
  logDir: string;
}

/** RPC methods the extension calls on the helper. */
export type HelperMethods = {
  "helper.hello": { params: Record<string, never>; result: HelperInfo };
  /** Resolves when the task finishes. Can take up to maxTaskMinutes. */
  "helper.runTask": { params: { claim: ClaimResponse; config: RunConfig }; result: TaskRunResult };
  /** Stop the running task now and report it as paused with this reason. */
  "helper.forcePause": { params: { taskId: string; reason: string }; result: { ok: true } };
  /** Stop the running task now and report it as failed. */
  "helper.abortTask": { params: { taskId: string; reason: string }; result: { ok: true } };
  "helper.getLog": { params: { lines: number }; result: { text: string } };
}
