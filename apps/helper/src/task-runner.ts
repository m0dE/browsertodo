/**
 * Orchestrates task sessions: run folder, MCP config, prompts, the tool
 * executor, the brain, limits, user messages, events, and the TaskRunResult
 * of each turn.
 *
 * A session starts with run() (the first turn). With a persistent brain
 * (Claude Code in a terminal, or headless with stdin kept open) the agent
 * stays alive after its task_* call, idle, and continueSession() types the
 * user's next message into it as a new turn. One turn runs at a time (the
 * browser is shared); a few idle sessions may stay open beside it.
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
import { buildSystemPrompt, buildTaskPrompt, createToolExecutor, type BrowserCaller, type JevLike, type ToolExecutor } from "@browsertodo/core";
import { RunLog, type LiveLog } from "./logger.js";
import { UserInput, type Brain } from "./brains/brain.js";
import { INTERACTIVE_TASK_ID, type ToolSession } from "./tool-router.js";

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

/** Typed before a follow-up message, so the agent knows it continues the same conversation. */
export const FOLLOW_UP_PREFIX = "Next message from the user (same conversation; the browser tab is as you left it): ";

/** Added to the system prompt of kept-open sessions. */
export const FOLLOW_UP_PROMPT = [
  "Follow-up messages: after you call task_complete (or task_fail / task_pause), this session stays open",
  "and the user may send follow-up messages in it. Treat each follow-up as the next request in the same",
  "conversation, starting from the browser as you left it, and end each follow-up with exactly one",
  "task_complete, task_fail or task_pause call again. After that call, stop and wait.",
].join(" ");

export const IDLE_TURN_REASON = "agent ended its turn without reporting a result";

/** One turn: from the first message (or a follow-up) to its task_* call. */
interface Turn {
  config: RunConfig;
  finish: TaskRunResult | null;
  forcedPause: string | null;
  abortReason: string | null;
  timedOut: boolean;
  /** Persistent brains: the agent went idle without a task_* call. */
  idleEnd: boolean;
  lastError: string | null;
  toolCalls: number;
  timeLimit?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Resolves the turn's wait early (persistent brains: result recorded, or idle). */
  settle: () => void;
  settled: Promise<void>;
}

interface Session {
  sessionId: string;
  controller: AbortController;
  log: RunLog;
  runDir: string;
  persistent: boolean;
  allowed: Set<ToolName>;
  input: UserInput;
  executor: ToolExecutor;
  tools: ToolSession;
  screenshots: number;
  turn: Turn | null;
  brainDone: Promise<void>;
  brainError: string | null;
  ended: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastTurnAt: number;
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
}

/** First non-empty line of the instructions, shortened: the task terminal's title. */
export function taskTitle(instructions: string, max = 80): string {
  const line = instructions.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "Task";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class TaskRunner {
  private readonly sessions = new Map<string, Session>();
  /** The session whose turn is running. */
  private active: Session | null = null;

  constructor(private readonly deps: TaskRunnerDeps) {}

  /** A turn is running (one at a time). */
  get busy(): boolean {
    return this.active !== null;
  }

  get currentSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  /** Sessions whose agent is still alive (running a turn, or idle and kept open). */
  get openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * The ToolSession for the ToolRouter: the running turn's when no id is given;
   * with an id, that session's (an idle one refuses tools until its next turn).
   */
  session(taskId?: string): ToolSession | null {
    if (taskId === undefined) return this.active?.tools ?? null;
    return this.sessions.get(taskId)?.tools ?? null;
  }

  forcePause(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.log.event({ type: "force_pause", reason });
    if (s.turn && s.turn.forcedPause === null) s.turn.forcedPause = reason;
    s.controller.abort(new Error(`paused: ${reason}`));
    return true;
  }

  abort(sessionId: string, reason: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.log.event({ type: "abort", reason });
    if (s.turn && s.turn.abortReason === null) s.turn.abortReason = reason;
    s.controller.abort(new Error(reason));
    return true;
  }

  /** Types a message into the running turn. False when there is no such turn or it already has its result. */
  sendUserMessage(sessionId: string, text: string): boolean {
    const s = this.active;
    if (!s || s.sessionId !== sessionId || !s.turn || s.turn.finish || s.controller.signal.aborted || !text.trim()) return false;
    if (!s.input.push(text)) return false;
    this.emit(s, { type: "user_message", text });
    return true;
  }

  /** Ends a kept-open session (gracefully: the agent is asked to exit, then killed). False when unknown. */
  endSession(sessionId: string, why = "ended"): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.log.event({ type: "session_end", why });
    if (s.turn) {
      if (s.turn.abortReason === null) s.turn.abortReason = `session ${why}`;
      s.controller.abort(new Error(why));
    } else {
      s.input.close();
      // A brain that ignores the close is killed after abortWaitMs.
      const timer = setTimeout(() => s.controller.abort(new Error(why)), this.deps.abortWaitMs ?? 15_000);
      void s.brainDone.finally(() => clearTimeout(timer));
    }
    return true;
  }

  /** Abort everything (used when Chrome closes the port). */
  shutdown(reason: string): void {
    for (const id of [...this.sessions.keys()]) this.abort(id, reason);
  }

  async run(params: RunTaskParams): Promise<TaskRunResult> {
    if (this.active) throw new Error("busy");
    const { sessionId, task, mediaPaths, config } = params;
    if (sessionId === INTERACTIVE_TASK_ID) throw new Error(`sessionId "${INTERACTIVE_TASK_ID}" is reserved`);
    if (this.sessions.has(sessionId)) this.endSession(sessionId, "replaced by a new run");
    this.makeRoom();

    const runDir = join(this.deps.runsDir, `${safeId(sessionId)}-${runStamp()}`);
    mkdirSync(runDir, { recursive: true });
    const log = new RunLog(join(runDir, "log.jsonl"), this.deps.live ?? null, sessionId);
    const jevKey = config.jevApiKey?.trim() || this.deps.envJevKey;
    const jev = config.jevEnabled && jevKey ? this.deps.makeJev(jevKey) : null;
    // With Jev, act replaces click and type (steps can still name an exact element index).
    const allowed = new Set<ToolName>(toolsFor({ jev: jev !== null }));
    const brain = this.deps.makeBrain();

    const s = {
      sessionId,
      controller: new AbortController(),
      log,
      runDir,
      persistent: brain.persistent === true,
      allowed,
      input: new UserInput(),
      screenshots: 0,
      turn: null,
      brainError: null,
      ended: false,
      lastTurnAt: Date.now(),
    } as unknown as Session;
    s.executor = createToolExecutor({
      browser: this.screenshotSaver(s),
      jev,
      jevThreshold: config.jevThreshold,
      onEvent: (e) => this.emit(s, e),
      onTaskEnd: (r) => this.recordFinish(s, r),
      mediaPaths,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    s.tools = { taskId: sessionId, allowedTools: allowed, beforeCall: (name) => this.beforeCall(s, name), executor: s.executor };
    this.sessions.set(sessionId, s);
    this.active = s;
    const turn = this.startTurn(s, config);

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
      writeFileSync(mcpConfigPath, JSON.stringify(this.mcpConfig(sessionId, toolNames), null, 2));
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
          emit: (e) => this.emit(s, e),
          input: s.input,
          title: taskTitle(task.instructions),
          runDir,
          pause: (reason) => void this.forcePause(sessionId, reason),
          idle: () => this.onIdle(s),
          inTurn: () => !!s.turn && !s.turn.finish,
          task: { instructions: task.instructions, account: task.account, mediaPaths },
        })
        .catch((e: unknown) => {
          s.brainError = e instanceof Error ? e.message : String(e);
          log.event({ type: "brain_error", message: s.brainError });
        })
        .finally(() => this.onBrainExit(s));
    } catch (e) {
      s.brainError = e instanceof Error ? e.message : String(e);
      s.brainDone = Promise.resolve();
      this.onBrainExit(s);
    }
    return this.finishTurn(s, turn);
  }

  /**
   * The next user message in a kept-open session: a new turn with fresh
   * limits. Throws "session ended" when its agent is gone (the caller then
   * starts a fresh run), "busy" while another turn runs.
   */
  async continueSession(params: ContinueSessionParams): Promise<TaskRunResult> {
    const s = this.sessions.get(params.sessionId);
    if (!s || s.ended || s.input.closed || s.controller.signal.aborted || !s.persistent) throw new Error("session ended");
    if (this.active) throw new Error("busy");
    if (!params.text.trim()) throw new Error("empty message");
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.active = s;
    const turn = this.startTurn(s, params.config);
    s.log.event({ type: "turn_start", chars: params.text.length, maxToolCalls: params.config.maxToolCalls, maxTaskMinutes: params.config.maxTaskMinutes });
    this.emit(s, { type: "user_message", text: params.text });
    s.input.push(`${FOLLOW_UP_PREFIX}${params.text}`, "followup");
    return this.finishTurn(s, turn);
  }

  private startTurn(s: Session, config: RunConfig): Turn {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const turn: Turn = {
      config,
      finish: null,
      forcedPause: null,
      abortReason: null,
      timedOut: false,
      idleEnd: false,
      lastError: null,
      toolCalls: 0,
      settle,
      settled,
    };
    const minutes = config.maxTaskMinutes;
    turn.timeLimit = setTimeout(() => {
      turn.timedOut = true;
      s.log.event({ type: "time_limit", minutes });
      s.controller.abort(new Error("time limit"));
    }, minutes * 60_000);
    s.turn = turn;
    s.lastTurnAt = Date.now();
    return turn;
  }

  /** Waits for the turn to end, then reports it. The session stays open when its agent is still alive. */
  private async finishTurn(s: Session, turn: Turn): Promise<TaskRunResult> {
    try {
      await this.waitForTurn(s, turn);
    } finally {
      clearTimeout(turn.timeLimit);
      if (turn.graceTimer) clearTimeout(turn.graceTimer);
      if (s.turn === turn) s.turn = null;
      if (this.active === s) this.active = null;
    }
    const result = this.resultFor(s, turn);
    const end: AgentEvent = { type: "task_end", outcome: result.outcome };
    if (result.summary !== undefined) end.summary = result.summary;
    if (result.url !== undefined) end.url = result.url;
    if (result.reason !== undefined) end.reason = result.reason;
    this.emit(s, end);
    result.logPath = s.log.path;
    if (!s.ended) this.armIdle(s);
    return result;
  }

  /** Until the brain exits, or (persistent) the turn settles; after an abort, give the brain abortWaitMs to exit. */
  private async waitForTurn(s: Session, turn: Turn): Promise<void> {
    const aborted = new Promise<void>((resolve) => {
      if (s.controller.signal.aborted) resolve();
      else s.controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([s.brainDone, turn.settled, aborted]);
    if (!s.controller.signal.aborted) return;
    const waitMs = this.deps.abortWaitMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), waitMs)));
    const r = await Promise.race([s.brainDone.then(() => "done" as const), gaveUp]);
    clearTimeout(timer);
    if (r === "timeout") s.log.event({ type: "brain_stuck", waitMs });
  }

  private onBrainExit(s: Session): void {
    if (s.ended) return;
    s.ended = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.input.close();
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    s.log.event({ type: "session_closed" });
  }

  private onIdle(s: Session): void {
    const turn = s.turn;
    if (!turn || turn.finish || turn.idleEnd) return;
    turn.idleEnd = true;
    s.log.event({ type: "turn_idle" });
    turn.settle();
  }

  private armIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
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

  private emit(s: Session, e: AgentEvent): void {
    if (e.type === "error" && s.turn) s.turn.lastError = e.text;
    s.log.event({ ...e });
    try {
      this.deps.notify(s.sessionId, e);
    } catch {
      /* the extension may be gone */
    }
  }

  /** Browser calls with screenshots also saved into the run folder. */
  private screenshotSaver(s: Session): BrowserCaller {
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

  private resultFor(s: Session, t: Turn): TaskRunResult {
    if (t.forcedPause !== null) return { outcome: "paused", reason: t.forcedPause };
    if (t.finish) return { ...t.finish };
    if (t.abortReason !== null) return { outcome: "failed", reason: t.abortReason };
    if (t.timedOut) return { outcome: "failed", reason: `task time limit of ${t.config.maxTaskMinutes} minutes reached` };
    if (s.brainError) return { outcome: "failed", reason: `agent error: ${s.brainError}` };
    // e.g. "Claude Code: Claude AI usage limit reached" (the extension classifies it as temporary)
    if (t.lastError) return { outcome: "failed", reason: t.lastError };
    if (t.idleEnd) return { outcome: "failed", reason: IDLE_TURN_REASON };
    return { outcome: "failed", reason: "agent exited without reporting a result" };
  }

  private beforeCall(s: Session, name: ToolName): string | null {
    const t = s.turn;
    if (s.controller.signal.aborted) return "The task was stopped. Stop now.";
    if (!t) return "No task is running in this session right now. Stop and wait for the user's next message.";
    const isFinish = name.startsWith("task_");
    if (t.finish) return isFinish ? "The task result was already recorded. Stop now." : "The task is finished. Stop now.";
    if (isFinish) return null;
    t.toolCalls++;
    const max = t.config.maxToolCalls;
    if (t.toolCalls >= max + 5) {
      if (t.abortReason === null) t.abortReason = `tool call limit exceeded (${max} calls)`;
      s.controller.abort(new Error("tool call limit"));
      return "Tool call limit exceeded. The task was stopped.";
    }
    if (t.toolCalls > max) return `Tool call limit of ${max} reached. Call task_fail now with a short reason.`;
    return null;
  }

  private recordFinish(s: Session, r: TaskRunResult): void {
    const t = s.turn;
    if (!t || t.finish || t.forcedPause !== null) return;
    t.finish = r;
    s.log.event({ type: "task_result", ...r });
    if (s.persistent) {
      // The agent stays open, idle, for the next message.
      t.settle();
      return;
    }
    // Single-turn brains: Claude Code exits once its stdin is closed and the turn ends.
    s.input.close();
    const grace = this.deps.finishGraceMs ?? 20_000;
    t.graceTimer = setTimeout(() => {
      s.log.event({ type: "grace_expired", ms: grace });
      s.controller.abort(new Error("finished"));
    }, grace);
  }
}
