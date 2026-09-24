/**
 * Orchestrates one task: run folder, media, MCP config, prompts, the brain,
 * limits, and the final TaskRunResult. One task at a time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_SERVER_NAME,
  TOOL_NAMES,
  mcpToolName,
  type ClaimResponse,
  type RunConfig,
  type Screenshot,
  type TaskRunResult,
  type ToolName,
} from "@browsertodo/shared";
import { RunLog, type LiveLog } from "./logger.js";
import type { Brain } from "./brains/brain.js";
import type { TaskFinish, ToolSession } from "./tool-router.js";
import { downloadMedia } from "./media.js";
import { buildSystemPrompt, buildTaskPrompt } from "./system-prompt.js";

export interface TaskRunnerDeps {
  runsDir: string;
  mcpServerPath: string;
  pipePath: string;
  /** True when a Jev key is configured. */
  jevAvailable: boolean;
  makeBrain: () => Brain;
  live?: LiveLog | null;
  download?: typeof downloadMedia;
  /** Time the agent gets to exit after its first task_* call. Default 20 s. */
  finishGraceMs?: number;
  /** Time a brain gets to return after an abort before we stop waiting. Default 15 s. */
  abortWaitMs?: number;
  nodePath?: string;
}

interface RunState {
  taskId: string;
  controller: AbortController;
  log: RunLog;
  runDir: string;
  config: RunConfig;
  allowed: Set<ToolName>;
  finish: TaskFinish | null;
  forcedPause: string | null;
  abortReason: string | null;
  timedOut: boolean;
  toolCalls: number;
  screenshots: number;
  graceTimer?: ReturnType<typeof setTimeout>;
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
}

export class TaskRunner {
  private current: RunState | null = null;

  constructor(private readonly deps: TaskRunnerDeps) {}

  get busy(): boolean {
    return this.current !== null;
  }

  get currentTaskId(): string | null {
    return this.current?.taskId ?? null;
  }

  /** The ToolSession for the running task, for the ToolRouter. */
  session(): ToolSession | null {
    const s = this.current;
    if (!s) return null;
    return {
      taskId: s.taskId,
      allowedTools: s.allowed,
      jevThreshold: s.config.jevThreshold,
      beforeCall: (name) => this.beforeCall(s, name),
      finish: (r) => this.recordFinish(s, r),
      log: (e) => s.log.event(e),
      saveScreenshot: (shot) => this.saveScreenshot(s, shot),
    };
  }

  forcePause(taskId: string, reason: string): boolean {
    const s = this.current;
    if (!s || s.taskId !== taskId) return false;
    s.log.event({ type: "force_pause", reason });
    if (s.forcedPause === null) s.forcedPause = reason;
    s.controller.abort(new Error(`paused: ${reason}`));
    return true;
  }

  abort(taskId: string, reason: string): boolean {
    const s = this.current;
    if (!s || s.taskId !== taskId) return false;
    s.log.event({ type: "abort", reason });
    if (s.abortReason === null) s.abortReason = reason;
    s.controller.abort(new Error(reason));
    return true;
  }

  /** Abort whatever is running (used when Chrome closes the port). */
  shutdown(reason: string): void {
    if (this.current) this.abort(this.current.taskId, reason);
  }

  async run(claim: ClaimResponse, config: RunConfig): Promise<TaskRunResult> {
    if (this.current) throw new Error("busy");
    const task = claim.task;
    const runDir = join(this.deps.runsDir, `${safeId(task.id)}-${runStamp()}`);
    const mediaDir = join(runDir, "media");
    mkdirSync(mediaDir, { recursive: true });
    const log = new RunLog(join(runDir, "log.jsonl"), this.deps.live ?? null, task.id);
    const jevOn = config.jevEnabled && this.deps.jevAvailable;
    const allowed = new Set<ToolName>(TOOL_NAMES.filter((n) => n !== "act" || jevOn));
    const s: RunState = {
      taskId: task.id,
      controller: new AbortController(),
      log,
      runDir,
      config,
      allowed,
      finish: null,
      forcedPause: null,
      abortReason: null,
      timedOut: false,
      toolCalls: 0,
      screenshots: 0,
    };
    this.current = s;
    const minutes = config.maxTaskMinutes;
    const timeLimit = setTimeout(() => {
      s.timedOut = true;
      s.log.event({ type: "time_limit", minutes });
      s.controller.abort(new Error("time limit"));
    }, minutes * 60_000);

    log.event({
      type: "task_start",
      attempts: task.attempts,
      account: task.account,
      media: claim.media.length,
      jev: jevOn,
      maxToolCalls: config.maxToolCalls,
      maxTaskMinutes: minutes,
    });

    let setupError: string | null = null;
    let brainError: string | null = null;
    try {
      let mediaPaths: string[] = [];
      try {
        mediaPaths = await (this.deps.download ?? downloadMedia)({
          apiBase: config.apiBase,
          runnerKey: config.runnerKey,
          media: claim.media,
          dir: mediaDir,
          signal: s.controller.signal,
        });
        if (mediaPaths.length) log.event({ type: "media", paths: mediaPaths });
      } catch (e) {
        setupError = `media download failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (!setupError && !s.controller.signal.aborted) {
        const toolNames = TOOL_NAMES.filter((n) => allowed.has(n));
        const mcpConfigPath = join(runDir, "mcp-config.json");
        writeFileSync(mcpConfigPath, JSON.stringify(this.mcpConfig(task.id, toolNames), null, 2));
        const brain = this.deps.makeBrain();
        const ctx = {
          taskId: task.id,
          prompt: buildTaskPrompt(task, mediaPaths),
          systemPrompt: buildSystemPrompt({ allowedTools: toolNames }),
          mcpConfigPath,
          allowedTools: toolNames.map(mcpToolName),
          signal: s.controller.signal,
          log: (e: Record<string, unknown>) => log.event(e),
          task: { instructions: task.instructions, account: task.account, mediaPaths },
        };
        const brainDone = brain.run(ctx).catch((e: unknown) => {
          brainError = e instanceof Error ? e.message : String(e);
          log.event({ type: "brain_error", message: brainError });
        });
        await this.waitForBrain(s, brainDone);
      }
    } finally {
      clearTimeout(timeLimit);
      if (s.graceTimer) clearTimeout(s.graceTimer);
      this.current = null;
    }

    const result = this.resultFor(s, setupError, brainError);
    result.logPath = log.path;
    log.event({ type: "task_end", ...result });
    return result;
  }

  private mcpConfig(taskId: string, toolNames: ToolName[]) {
    return {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: this.deps.nodePath ?? process.execPath,
          args: [this.deps.mcpServerPath],
          env: {
            BROWSERTODO_PIPE: this.deps.pipePath,
            BROWSERTODO_TASK: taskId,
            BROWSERTODO_TOOLS: toolNames.join(","),
          },
        },
      },
    };
  }

  /** Wait for the brain; after an abort, give it abortWaitMs to exit, then move on. */
  private async waitForBrain(s: RunState, brainDone: Promise<void>): Promise<void> {
    const aborted = new Promise<void>((resolve) => {
      if (s.controller.signal.aborted) resolve();
      else s.controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([brainDone, aborted]);
    if (!s.controller.signal.aborted) return;
    const waitMs = this.deps.abortWaitMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), waitMs)));
    const r = await Promise.race([brainDone.then(() => "done" as const), gaveUp]);
    clearTimeout(timer);
    if (r === "timeout") s.log.event({ type: "brain_stuck", waitMs });
  }

  private resultFor(s: RunState, setupError: string | null, brainError: string | null): TaskRunResult {
    if (s.forcedPause !== null) return { outcome: "paused", reason: s.forcedPause };
    if (s.finish) {
      const r: TaskRunResult = { outcome: s.finish.outcome };
      if (s.finish.summary !== undefined) r.summary = s.finish.summary;
      if (s.finish.url !== undefined) r.url = s.finish.url;
      if (s.finish.reason !== undefined) r.reason = s.finish.reason;
      return r;
    }
    if (setupError) return { outcome: "failed", reason: setupError };
    if (s.abortReason !== null) return { outcome: "failed", reason: s.abortReason };
    if (s.timedOut) return { outcome: "failed", reason: `timed out after ${s.config.maxTaskMinutes} minutes` };
    if (brainError) return { outcome: "failed", reason: `agent error: ${brainError}` };
    return { outcome: "failed", reason: "agent exited without reporting a result" };
  }

  private beforeCall(s: RunState, name: ToolName): string | null {
    if (s.controller.signal.aborted) return "The task was stopped. Stop now.";
    const isFinish = name.startsWith("task_");
    if (s.finish) return isFinish ? "The task result was already recorded. Stop now." : "The task is finished. Stop now.";
    s.toolCalls++;
    const max = s.config.maxToolCalls;
    if (s.toolCalls >= max + 5 && !isFinish) {
      if (s.abortReason === null) s.abortReason = `tool call limit exceeded (${max} calls)`;
      s.controller.abort(new Error("tool call limit"));
      return "Tool call limit exceeded. The task was stopped.";
    }
    if (s.toolCalls > max && !isFinish) {
      return `Tool call limit of ${max} reached. Call task_fail now with a short reason.`;
    }
    return null;
  }

  private recordFinish(s: RunState, r: TaskFinish): void {
    if (s.finish || s.forcedPause !== null) return;
    s.finish = r;
    s.log.event({ type: "task_result", ...r });
    const grace = this.deps.finishGraceMs ?? 20_000;
    s.graceTimer = setTimeout(() => {
      s.log.event({ type: "grace_expired", ms: grace });
      s.controller.abort(new Error("finished"));
    }, grace);
  }

  private saveScreenshot(s: RunState, shot: Screenshot): void {
    s.screenshots++;
    const ext = shot.mimeType === "image/png" ? "png" : "jpg";
    try {
      writeFileSync(join(s.runDir, `screenshot-${String(s.screenshots).padStart(3, "0")}.${ext}`), Buffer.from(shot.base64, "base64"));
    } catch {
      /* best effort */
    }
  }
}
