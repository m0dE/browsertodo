/**
 * Orchestrates one task run: run folder, MCP config, prompts, the tool
 * executor, the brain, limits, user messages, events, and the final
 * TaskRunResult. One task at a time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_SERVER_NAME,
  TOOL_NAMES,
  toolsFor,
  mcpToolName,
  type AgentEvent,
  type AgentTask,
  type RunConfig,
  type TaskRunResult,
  type ToolName,
} from "@browsertodo/shared";
import { buildSystemPrompt, buildTaskPrompt, createToolExecutor, type BrowserCaller, type JevLike } from "@browsertodo/core";
import { RunLog, type LiveLog } from "./logger.js";
import { UserInput, type Brain } from "./brains/brain.js";
import { INTERACTIVE_TASK_ID, type ToolSession } from "./tool-router.js";

export interface RunTaskParams {
  sessionId: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
}

export interface TaskRunnerDeps {
  runsDir: string;
  mcpServerPath: string;
  pipePath: string;
  browser: BrowserCaller;
  /** Jev key from the helper environment (TYPESAFE_API_KEY), used when the run config has none. */
  envJevKey: string | null;
  makeJev: (apiKey: string) => JevLike;
  makeBrain: () => Brain;
  /** helper.event notifications. */
  notify: (sessionId: string, event: AgentEvent) => void;
  live?: LiveLog | null;
  /** Time the agent gets to exit after its first task_* call. Default 20 s. */
  finishGraceMs?: number;
  /** Time a brain gets to return after an abort before we stop waiting. Default 15 s. */
  abortWaitMs?: number;
  nodePath?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface RunState {
  sessionId: string;
  controller: AbortController;
  log: RunLog;
  runDir: string;
  config: RunConfig;
  allowed: Set<ToolName>;
  input: UserInput;
  finish: TaskRunResult | null;
  forcedPause: string | null;
  abortReason: string | null;
  timedOut: boolean;
  lastError: string | null;
  toolCalls: number;
  screenshots: number;
  session: ToolSession;
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

  get currentSessionId(): string | null {
    return this.current?.sessionId ?? null;
  }

  /** The ToolSession for the running task, for the ToolRouter. */
  session(): ToolSession | null {
    return this.current?.session ?? null;
  }

  forcePause(sessionId: string, reason: string): boolean {
    const s = this.current;
    if (!s || s.sessionId !== sessionId) return false;
    s.log.event({ type: "force_pause", reason });
    if (s.forcedPause === null) s.forcedPause = reason;
    s.controller.abort(new Error(`paused: ${reason}`));
    return true;
  }

  abort(sessionId: string, reason: string): boolean {
    const s = this.current;
    if (!s || s.sessionId !== sessionId) return false;
    s.log.event({ type: "abort", reason });
    if (s.abortReason === null) s.abortReason = reason;
    s.controller.abort(new Error(reason));
    return true;
  }

  /** Types a message into the running task. False when there is no such task or it already ended. */
  sendUserMessage(sessionId: string, text: string): boolean {
    const s = this.current;
    if (!s || s.sessionId !== sessionId || s.finish || s.controller.signal.aborted || !text.trim()) return false;
    if (!s.input.push(text)) return false;
    this.emit(s, { type: "user_message", text });
    return true;
  }

  /** Abort whatever is running (used when Chrome closes the port). */
  shutdown(reason: string): void {
    if (this.current) this.abort(this.current.sessionId, reason);
  }

  async run(params: RunTaskParams): Promise<TaskRunResult> {
    if (this.current) throw new Error("busy");
    const { sessionId, task, mediaPaths, config } = params;
    if (sessionId === INTERACTIVE_TASK_ID) throw new Error(`sessionId "${INTERACTIVE_TASK_ID}" is reserved`);
    const runDir = join(this.deps.runsDir, `${safeId(sessionId)}-${runStamp()}`);
    mkdirSync(runDir, { recursive: true });
    const log = new RunLog(join(runDir, "log.jsonl"), this.deps.live ?? null, sessionId);
    const jevKey = config.jevApiKey?.trim() || this.deps.envJevKey;
    const jev = config.jevEnabled && jevKey ? this.deps.makeJev(jevKey) : null;
    // With Jev, act replaces click and type (steps can still name an exact element index).
    const allowed = new Set<ToolName>(toolsFor({ jev: jev !== null }));
    const controller = new AbortController();

    const s = {
      sessionId,
      controller,
      log,
      runDir,
      config,
      allowed,
      input: new UserInput(),
      finish: null,
      forcedPause: null,
      abortReason: null,
      timedOut: false,
      lastError: null,
      toolCalls: 0,
      screenshots: 0,
    } as Omit<RunState, "session"> as RunState;

    const executor = createToolExecutor({
      browser: this.screenshotSaver(s),
      jev,
      jevThreshold: config.jevThreshold,
      onEvent: (e) => this.emit(s, e),
      onTaskEnd: (r) => this.recordFinish(s, r),
      mediaPaths,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    s.session = { taskId: sessionId, allowedTools: allowed, beforeCall: (name) => this.beforeCall(s, name), executor };
    this.current = s;

    const minutes = config.maxTaskMinutes;
    const timeLimit = setTimeout(() => {
      s.timedOut = true;
      s.log.event({ type: "time_limit", minutes });
      s.controller.abort(new Error("time limit"));
    }, minutes * 60_000);

    log.event({
      type: "task_start",
      taskId: task.id,
      account: task.account,
      media: mediaPaths,
      jev: jev !== null,
      isRetry: config.isRetry,
      maxToolCalls: config.maxToolCalls,
      maxTaskMinutes: minutes,
    });

    let brainError: string | null = null;
    try {
      const toolNames = TOOL_NAMES.filter((n) => allowed.has(n));
      const mcpConfigPath = join(runDir, "mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify(this.mcpConfig(sessionId, toolNames), null, 2));
      const brain = this.deps.makeBrain();
      const brainDone = brain
        .run({
          taskId: sessionId,
          prompt: buildTaskPrompt(task, mediaPaths, { isRetry: config.isRetry }),
          systemPrompt: buildSystemPrompt({ tools: toolNames, jev: jev !== null }),
          mcpConfigPath,
          allowedTools: toolNames.map(mcpToolName),
          signal: controller.signal,
          log: (e) => log.event(e),
          emit: (e) => this.emit(s, e),
          input: s.input,
          task: { instructions: task.instructions, account: task.account, mediaPaths },
        })
        .catch((e: unknown) => {
          brainError = e instanceof Error ? e.message : String(e);
          log.event({ type: "brain_error", message: brainError });
        });
      await this.waitForBrain(s, brainDone);
    } catch (e) {
      brainError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timeLimit);
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.input.close();
      this.current = null;
    }

    const result = this.resultFor(s, brainError);
    const end: AgentEvent = { type: "task_end", outcome: result.outcome };
    if (result.summary !== undefined) end.summary = result.summary;
    if (result.url !== undefined) end.url = result.url;
    if (result.reason !== undefined) end.reason = result.reason;
    this.emit(s, end);
    result.logPath = log.path;
    return result;
  }

  private emit(s: RunState, e: AgentEvent): void {
    if (e.type === "error") s.lastError = e.text;
    s.log.event({ ...e });
    try {
      this.deps.notify(s.sessionId, e);
    } catch {
      /* the extension may be gone */
    }
  }

  /** Browser calls with screenshots also saved into the run folder. */
  private screenshotSaver(s: RunState): BrowserCaller {
    const browser = this.deps.browser;
    return {
      call: async (method, params) => {
        const r = await browser.call(method, params);
        if (method === "browser.screenshot") {
          const shot = r as { base64: string; mimeType: string };
          s.screenshots++;
          const ext = shot.mimeType === "image/png" ? "png" : "jpg";
          try {
            writeFileSync(join(s.runDir, `screenshot-${String(s.screenshots).padStart(3, "0")}.${ext}`), Buffer.from(shot.base64, "base64"));
          } catch {
            /* best effort */
          }
        }
        return r;
      },
    };
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

  private resultFor(s: RunState, brainError: string | null): TaskRunResult {
    if (s.forcedPause !== null) return { outcome: "paused", reason: s.forcedPause };
    if (s.finish) return { ...s.finish };
    if (s.abortReason !== null) return { outcome: "failed", reason: s.abortReason };
    if (s.timedOut) return { outcome: "failed", reason: `task time limit of ${s.config.maxTaskMinutes} minutes reached` };
    if (brainError) return { outcome: "failed", reason: `agent error: ${brainError}` };
    // e.g. "Claude Code: Claude AI usage limit reached" (the extension classifies it as temporary)
    if (s.lastError) return { outcome: "failed", reason: s.lastError };
    return { outcome: "failed", reason: "agent exited without reporting a result" };
  }

  private beforeCall(s: RunState, name: ToolName): string | null {
    if (s.controller.signal.aborted) return "The task was stopped. Stop now.";
    const isFinish = name.startsWith("task_");
    if (s.finish) return isFinish ? "The task result was already recorded. Stop now." : "The task is finished. Stop now.";
    if (isFinish) return null;
    s.toolCalls++;
    const max = s.config.maxToolCalls;
    if (s.toolCalls >= max + 5) {
      if (s.abortReason === null) s.abortReason = `tool call limit exceeded (${max} calls)`;
      s.controller.abort(new Error("tool call limit"));
      return "Tool call limit exceeded. The task was stopped.";
    }
    if (s.toolCalls > max) return `Tool call limit of ${max} reached. Call task_fail now with a short reason.`;
    return null;
  }

  private recordFinish(s: RunState, r: TaskRunResult): void {
    if (s.finish || s.forcedPause !== null) return;
    s.finish = r;
    s.log.event({ type: "task_result", ...r });
    // Claude Code exits once its stdin is closed and the turn ends.
    s.input.close();
    const grace = this.deps.finishGraceMs ?? 20_000;
    s.graceTimer = setTimeout(() => {
      s.log.event({ type: "grace_expired", ms: grace });
      s.controller.abort(new Error("finished"));
    }, grace);
  }
}
