/**
 * Recording how a run ended: on its local task, to the cloud API (with a
 * final screenshot), and in the session history.
 */
import type { AgentEvent, ExtensionSettings, ResultInput, SessionInfo, TaskRunResult } from "@browsertodo/shared";
import { base64ToBytes } from "../../base64.js";
import { errText } from "../../errors.js";
import type { LocalStore } from "../local-store.js";
import type { SessionStore } from "../sessions.js";
import { localTaskOf, type CloudJob, type Job } from "./jobs.js";
import type { RunnerState } from "./state.js";
import type { ActiveSession } from "./turn.js";

export interface RecorderDeps {
  localStore: LocalStore;
  sessions: SessionStore;
  patchState(patch: Partial<RunnerState>): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export class ResultRecorder {
  constructor(private readonly deps: RecorderDeps) {}

  /** Records the result on the job's local task, or reports it to the cloud. */
  async recordTask(active: ActiveSession, job: Job, result: TaskRunResult, settings: ExtensionSettings): Promise<void> {
    const localTask = localTaskOf(job);
    if (localTask) {
      try {
        await this.deps.localStore.finish(localTask.id, result, { retryAfterMinutes: settings.retryAfterMinutes });
      } catch (err) {
        this.deps.log(`recording local result failed: ${errText(err)}`);
      }
    } else if (job.source === "cloud") {
      await this.reportCloud(active, job, result, settings);
    }
  }

  /** Ends the session's turn: the one final task_end event and the latest-turn fields. */
  async endSession(sessionId: string, result: TaskRunResult): Promise<void> {
    const end: AgentEvent = { type: "task_end", outcome: result.outcome };
    if (result.summary) end.summary = result.summary;
    if (result.url) end.url = result.url;
    if (result.reason) end.reason = result.reason;
    this.deps.sessions.append(sessionId, end);
    const patch: Partial<SessionInfo> = { endedAt: this.deps.now().toISOString(), outcome: result.outcome };
    if (result.summary) patch.summary = result.summary;
    if (result.url) patch.url = result.url;
    if (result.reason) patch.reason = result.reason;
    if (result.logPath) patch.logPath = result.logPath;
    await this.deps.sessions.update(sessionId, patch);
  }

  private async reportCloud(active: ActiveSession, job: CloudJob, result: TaskRunResult, settings: ExtensionSettings): Promise<void> {
    const taskId = job.claim.task.id;
    const body: ResultInput = {
      runnerId: job.runnerId,
      outcome: result.outcome,
      retryAfterMinutes: result.outcome === "retry" ? settings.retryAfterMinutes : settings.pauseRetryMinutes,
    };
    if (result.summary) body.summary = result.summary.slice(0, 4000);
    if (result.url) body.url = result.url.slice(0, 2000);
    if (result.reason) body.reason = result.reason.slice(0, 4000);
    try {
      const shot = await active.slot.screenshot();
      const ext = shot.mimeType === "image/png" ? "png" : "jpg";
      const blob = new Blob([base64ToBytes(shot.base64)], { type: shot.mimeType });
      body.screenshotId = (await job.api.uploadMedia(blob, `result-${taskId}.${ext}`)).id;
    } catch (err) {
      this.deps.log(`final screenshot skipped: ${errText(err)}`);
    }
    try {
      await job.api.result(taskId, body);
    } catch (err) {
      await this.deps.patchState({ lastError: `Reporting ${taskId} failed: ${errText(err)}` });
    }
  }
}
