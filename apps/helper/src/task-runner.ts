/**
 * Keeps the helper's task sessions and their lifecycle: starts a session
 * (run folder, MCP config, prompts, brain), runs its turns, keeps it open
 * between turns, and closes it (ended, idle, replaced, or to make room).
 * What happens inside one session lives in session/task-session.ts.
 *
 * A session starts with run() (the first turn). With a persistent brain
 * (Claude Code headless with stdin kept open) the agent stays alive after
 * its task_* call, idle, and continueSession() types the user's next message
 * into it as a new turn. Several sessions can run turns at the same time (the
 * extension gives each its own tab: every browser call carries the session
 * id); a few idle sessions may stay open beside them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAMES, toolsFor, mcpToolName, type AgentEvent, type AgentTask, type RunConfig, type TaskRunResult, type ToolName } from "@browsertodo/shared";
import { buildSystemPrompt, buildTaskPrompt, type BrowserCaller, type JevLike } from "@browsertodo/core";
import { errorMessage, RunLog, type LiveLog } from "./logger.js";
import type { Brain } from "./brains/brain.js";
import { INTERACTIVE_TASK_ID } from "./mcp-tools.js";
import type { ToolSession } from "./tool-router.js";
import { buildMcpConfig, FOLLOW_UP_PREFIX, FOLLOW_UP_PROMPT, runDirFor } from "./session/session-setup.js";
import { TaskSession } from "./session/task-session.js";
import type { Turn } from "./session/turn.js";

export interface RunTaskParams {
  sessionId: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
}

export interface ContinueSessionParams {
  sessionId: string;
  text: string;
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
  /** The set of open sessions changed (one opened or closed): helper.sessions notifications. */
  onSessionsChanged?: (open: string[]) => void;
  live?: LiveLog | null;
  /** Single-turn brains: time the agent gets to exit after its first task_* call. Default 20 s. */
  finishGraceMs?: number;
  /** Time a brain gets to return after an abort before we stop waiting. Default 15 s. */
  abortWaitMs?: number;
  /** An idle kept-open session is closed after this long without a turn. Default 30 min. */
  idleSessionMs?: number;
  /** At most this many kept-open task sessions; starting another closes the oldest idle one. Default 3. */
  maxSessions?: number;
  nodePath?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class TaskRunner {
  private readonly sessions = new Map<string, TaskSession>();
  /** Sessions whose turn is running. */
  private readonly active = new Set<TaskSession>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  /** Some turn is running. */
  get busy(): boolean {
    return this.active.size > 0;
  }

  /** Sessions whose turn is running. */
  get runningSessions(): string[] {
    return [...this.active].map((s) => s.sessionId);
  }

  /** Sessions whose agent is still alive (running a turn, or idle and kept open). */
  get openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * The ToolSession for the ToolRouter: a running turn's when no id is given;
   * with an id, that session's (an idle one refuses tools until its next turn).
   */
  session(taskId?: string): ToolSession | null {
    if (taskId === undefined) return [...this.active][0]?.tools ?? null;
    return this.sessions.get(taskId)?.tools ?? null;
  }

  forcePause(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    s?.forcePause(reason);
    return s !== undefined;
  }

  abort(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    s?.abort(reason);
    return s !== undefined;
  }

  /** Types a message into the running turn. False when there is no such turn or it already has its result. */
  sendUserMessage(sessionId: string, text: string): boolean {
    return this.sessions.get(sessionId)?.sendUserMessage(text) ?? false;
  }

  /** Ends a kept-open session (gracefully: the agent is asked to exit, then killed). False when unknown. */
  endSession(sessionId: string, why = "ended"): boolean {
    const s = this.sessions.get(sessionId);
    s?.end(why);
    return s !== undefined;
  }

  /** Abort everything (used when Chrome closes the port). */
  shutdown(reason: string): void {
    for (const id of [...this.sessions.keys()]) this.abort(id, reason);
  }

  async run(params: RunTaskParams): Promise<TaskRunResult> {
    const { sessionId, task, mediaPaths, config } = params;
    if (sessionId === INTERACTIVE_TASK_ID) throw new Error(`sessionId "${INTERACTIVE_TASK_ID}" is reserved`);
    // A session runs one turn at a time; other sessions may run beside it.
    if (this.sessions.get(sessionId)?.turn) throw new Error("busy");
    if (this.sessions.has(sessionId)) this.endSession(sessionId, "replaced by a new run");
    this.makeRoom();

    const runDir = runDirFor(this.deps.runsDir, sessionId);
    mkdirSync(runDir, { recursive: true });
    const log = new RunLog(join(runDir, "log.jsonl"), this.deps.live ?? null, sessionId);
    const jevKey = config.jevApiKey?.trim() || this.deps.envJevKey;
    const jev = config.jevEnabled && jevKey ? this.deps.makeJev(jevKey) : null;
    // With Jev, act replaces click and type (steps can still name an exact element index).
    const allowed = new Set<ToolName>(toolsFor({ jev: jev !== null }));
    const brain = this.deps.makeBrain();

    const s = new TaskSession({
      sessionId,
      runDir,
      log,
      persistent: brain.persistent === true,
      allowed,
      browser: this.deps.browser,
      jev,
      jevThreshold: config.jevThreshold,
      mediaPaths,
      notify: this.deps.notify,
      finishGraceMs: this.deps.finishGraceMs ?? 20_000,
      abortWaitMs: this.deps.abortWaitMs ?? 15_000,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.sessions.set(sessionId, s);
    this.sessionsChanged();
    this.active.add(s);
    const turn = s.startTurn(config);

    log.event({
      type: "task_start",
      taskId: task.id,
      account: task.account,
      media: mediaPaths,
      jev: jev !== null,
      persistent: s.persistent,
      isRetry: config.isRetry,
      maxToolCalls: config.maxToolCalls,
      maxTaskMinutes: config.maxTaskMinutes,
    });

    try {
      const toolNames = TOOL_NAMES.filter((n) => allowed.has(n));
      const mcpConfigPath = join(runDir, "mcp-config.json");
      const mcpConfig = buildMcpConfig({
        nodePath: this.deps.nodePath ?? process.execPath,
        mcpServerPath: this.deps.mcpServerPath,
        pipePath: this.deps.pipePath,
        taskId: sessionId,
        toolNames,
        jev: jev !== null,
      });
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      const system = buildSystemPrompt({ tools: toolNames, jev: jev !== null });
      s.brainDone = brain
        .run({
          taskId: sessionId,
          prompt: buildTaskPrompt(task, mediaPaths, { isRetry: config.isRetry }),
          systemPrompt: s.persistent ? `${system}\n\n${FOLLOW_UP_PROMPT}` : system,
          ...(config.model?.trim() ? { model: config.model.trim() } : {}),
          mcpConfigPath,
          allowedTools: toolNames.map(mcpToolName),
          signal: s.controller.signal,
          log: (e) => log.event(e),
          emit: (e) => s.emit(e),
          input: s.input,
          idle: () => s.onIdle(),
          task: { instructions: task.instructions, account: task.account, mediaPaths },
        })
        .catch((e: unknown) => {
          s.brainError = errorMessage(e);
          log.event({ type: "brain_error", message: s.brainError });
        })
        .finally(() => this.onBrainExit(s));
    } catch (e) {
      s.brainError = errorMessage(e);
      s.brainDone = Promise.resolve();
      this.onBrainExit(s);
    }
    return this.finishTurn(s, turn);
  }

  /**
   * The next user message in a kept-open session: a new turn with fresh
   * limits. Throws "session ended" when its agent is gone (the caller then
   * starts a fresh run), "busy" while this session's turn runs.
   */
  async continueSession(params: ContinueSessionParams): Promise<TaskRunResult> {
    const s = this.sessions.get(params.sessionId);
    if (!s || s.ended || s.input.closed || s.aborted || !s.persistent) throw new Error("session ended");
    if (s.turn) throw new Error("busy");
    if (!params.text.trim()) throw new Error("empty message");
    s.clearIdleTimer();
    this.active.add(s);
    const turn = s.startTurn(params.config);
    s.log.event({ type: "turn_start", chars: params.text.length, maxToolCalls: params.config.maxToolCalls, maxTaskMinutes: params.config.maxTaskMinutes });
    s.emit({ type: "user_message", text: params.text });
    s.input.push(`${FOLLOW_UP_PREFIX}${params.text}`, "followup");
    return this.finishTurn(s, turn);
  }

  /** Waits for the turn to end, then reports it. The session stays open when its agent is still alive. */
  private async finishTurn(s: TaskSession, turn: Turn): Promise<TaskRunResult> {
    try {
      await s.waitForTurn(turn);
    } finally {
      this.active.delete(s);
    }
    const result = s.report(turn);
    if (!s.ended) this.armIdle(s);
    return result;
  }

  private onBrainExit(s: TaskSession): void {
    if (!s.markEnded()) return;
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    this.sessionsChanged();
    s.log.event({ type: "session_closed" });
  }

  private armIdle(s: TaskSession): void {
    s.clearIdleTimer();
    const ms = this.deps.idleSessionMs ?? 30 * 60_000;
    s.idleTimer = setTimeout(() => this.endSession(s.sessionId, "idle"), ms);
    // Never keep the helper alive just for this.
    (s.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Keeps at most maxSessions open: closes the oldest idle ones to make room for a new one. */
  private makeRoom(): void {
    const max = this.deps.maxSessions ?? 3;
    const idle = [...this.sessions.values()].filter((x) => !x.turn && !x.ended).sort((a, b) => a.lastTurnAt - b.lastTurnAt);
    while (this.sessions.size >= max && idle.length) {
      const oldest = idle.shift()!;
      this.endSession(oldest.sessionId, "closed to make room for a new session");
      this.sessions.delete(oldest.sessionId);
    }
  }

  private sessionsChanged(): void {
    try {
      this.deps.onSessionsChanged?.(this.openSessions);
    } catch {
      /* the extension may be gone */
    }
  }
}
