/**
 * Running one turn of a session in its agent slot: the first turn of a new
 * session (tab, media, brain), the brain's run with its safety timer, the
 * brain's events into the session, and the checks on the result (X post
 * verification, failure classification). Next turns: conversation.ts.
 */
import { isXStatusUrl, type AgentEvent, type AgentTask, type ExtensionSettings, type RunConfig, type SessionInfo, type TaskRunResult } from "@browsertodo/shared";
import type { AgentSlot } from "../../agent-slots.js";
import { errText } from "../../errors.js";
import { SessionEndedError, type AbortOutcome, type Brain, type BrainRun, type CoreApi } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import type { MaterializedMedia, MediaSource } from "../media-files.js";
import type { SessionStore } from "../sessions.js";
import { mediaSources, type FirstJob } from "./jobs.js";

/** Extra wait after aborting a stuck brain before giving up on it. */
const ABORT_GRACE_MS = 30_000;

/** A session running right now. */
export interface ActiveSession {
  session: SessionInfo;
  /** The agent slot (tab) the session acts in. */
  slot: AgentSlot;
  run: BrainRun | null;
  forced: { outcome: AbortOutcome; reason: string } | null;
  /** Texts the user typed, to drop the brain's echo of them. */
  said: string[];
  /** Texts the agent typed or pasted into the page; the longest is the post body to verify. */
  typed: string[];
  /** It acts as an X account: it holds the X turn while it runs. */
  x: boolean;
  /** A due task run by the loop (counts toward maxParallelTasks). */
  scheduled: boolean;
  /** Local task id, while its run is on. */
  localTaskId: string | null;
}

export type Cleanup = () => void | Promise<void>;

/** Runs every cleanup; each is best effort. */
export async function runCleanups(cleanups: Cleanup[]): Promise<void> {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {
      /* cleanup is best effort */
    }
  }
}

/** Collects text the agent entered from a tool_call event (type, paste, act steps). */
export function typedTextsOf(e: AgentEvent): string[] {
  if (e.type !== "tool_call") return [];
  const args = (e.args ?? {}) as { text?: unknown; steps?: { text?: unknown }[] };
  const name = e.name.replace(/^mcp__browsertodo__/, "");
  if ((name === "type" || name === "paste") && typeof args.text === "string") return [args.text];
  if (name === "act" && Array.isArray(args.steps)) {
    return args.steps.map((s) => s?.text).filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  }
  return [];
}

/** The model setting, when one is set (both brains use it). */
export function modelOf(settings: ExtensionSettings): string | undefined {
  return settings.anthropicModel.trim() || undefined;
}

export function runConfig(settings: ExtensionSettings, isRetry: boolean): RunConfig {
  const config: RunConfig = {
    maxToolCalls: settings.maxToolCalls,
    maxTaskMinutes: settings.maxTaskMinutes,
    jevEnabled: settings.jevEnabled,
    jevThreshold: settings.jevThreshold,
    isRetry,
  };
  if (settings.jevApiKey) config.jevApiKey = settings.jevApiKey;
  // One model setting for both brains (the API brain also reads it from settings).
  const model = modelOf(settings);
  if (model) config.model = model;
  return config;
}

export interface TurnDeps {
  sessions: SessionStore;
  localStore: LocalStore;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  log(message: string): void;
}

export class TurnRunner {
  constructor(private readonly deps: TurnDeps) {}

  /** Appends an event to the session's thread. */
  emit(active: ActiveSession, e: AgentEvent): void {
    this.deps.sessions.append(active.session.sessionId, e);
  }

  /**
   * The first turn of a new session: picks its tab, writes its files, starts
   * the brain and waits for the result. One-off runs act on the tab the user
   * is looking at; other jobs on the slot's own tab.
   */
  async runFirst(
    active: ActiveSession,
    job: FirstJob,
    brain: Brain,
    opened: { task: AgentTask; isRetry: boolean },
    settings: ExtensionSettings,
    cleanups: Cleanup[],
  ): Promise<TaskRunResult> {
    const adhoc = job.source === "adhoc";
    await active.slot.prepare({ show: adhoc, mode: adhoc ? "current-tab" : "own-tab" });
    const sources = await mediaSources(job, this.deps.localStore);
    if (sources.length) this.emit(active, { type: "status", text: `Preparing ${sources.length} file(s)` });
    const mediaPaths = await this.materialize(active, sources, cleanups);
    const config = runConfig(settings, opened.isRetry);
    if (active.forced) throw new Error(active.forced.reason);
    const run = this.start(active, brain, { task: opened.task, mediaPaths, config, settings });
    return this.drive(active, run, settings, cleanups);
  }

  /** Writes the files to disk for the brain; they are deleted with the cleanups. */
  async materialize(active: ActiveSession, sources: MediaSource[], cleanups: Cleanup[]): Promise<string[]> {
    const media = await this.deps.media.materialize(active.session.sessionId, sources);
    cleanups.push(() => media.cleanup());
    return media.paths;
  }

  /** Starts the brain on a task in the session's tab. */
  start(active: ActiveSession, brain: Brain, opts: { task: AgentTask; mediaPaths: string[]; config: RunConfig; settings: ExtensionSettings }): BrainRun {
    return brain.start({
      sessionId: active.session.sessionId,
      ...opts,
      browser: active.slot.browser,
      onEvent: (e) => this.onBrainEvent(active, e),
    });
  }

  /** The next turn in the conversation's own agent session (the brain has continue()). */
  continue(active: ActiveSession, brain: Brain, opts: { text: string; config: RunConfig; settings: ExtensionSettings }): BrainRun {
    return brain.continue!({
      sessionId: active.session.sessionId,
      ...opts,
      browser: active.slot.browser,
      onEvent: (e) => this.onBrainEvent(active, e),
    });
  }

  /**
   * Waits for the brain's result (safety timer included). A stop or pause
   * URL that landed while the brain was starting is passed on. throwEnded:
   * let SessionEndedError through (continue path).
   */
  async drive(active: ActiveSession, run: BrainRun, settings: ExtensionSettings, cleanups: Cleanup[], throwEnded = false): Promise<TaskRunResult> {
    active.run = run;
    const forced = active.forced as ActiveSession["forced"];
    if (forced) run.abort(forced.reason, forced.outcome);
    try {
      return await withSafetyTimer(run, settings, cleanups, throwEnded);
    } finally {
      if (active.run === run) active.run = null;
    }
  }

  /** Verification and failure classification (pipeline steps 4-5). */
  async check(active: ActiveSession, result: TaskRunResult): Promise<TaskRunResult> {
    if (result.outcome === "done" && result.url && isXStatusUrl(result.url) && !active.forced) {
      this.emit(active, { type: "status", text: "Verifying the post" });
      let ok = false;
      let detail = "";
      try {
        // Compare against what the agent actually entered, not the whole instructions.
        const expected = active.typed.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "");
        const v = await this.deps.core.verifyXPost(active.slot.browser, result.url, expected);
        ok = v.ok;
        detail = v.detail;
      } catch (err) {
        detail = errText(err);
      }
      if (!ok) {
        this.emit(active, { type: "status", text: `Post not verified: ${detail}` });
        return { ...result, outcome: "retry", reason: `could not verify the post${detail ? `: ${detail}` : ""}` };
      }
      this.emit(active, { type: "status", text: "Post verified" });
    }
    if (result.outcome === "failed" && result.reason && !active.forced) {
      let kind: string = "permanent";
      try {
        kind = this.deps.core.classifyFailure(result.reason);
      } catch (err) {
        this.deps.log(`classifyFailure failed: ${errText(err)}`);
      }
      if (kind === "transient") return { ...result, outcome: "retry" };
    }
    return result;
  }

  private onBrainEvent(active: ActiveSession, e: AgentEvent): void {
    // The runner emits the one final task_end after verification and classification.
    if (e.type === "task_end") return;
    active.typed.push(...typedTextsOf(e));
    if (e.type === "user_message") {
      const i = active.said.indexOf(e.text.trim());
      if (i >= 0) {
        active.said.splice(i, 1);
        return;
      }
    }
    this.emit(active, e);
  }
}

function withSafetyTimer(run: BrainRun, settings: ExtensionSettings, cleanups: Cleanup[], throwEnded: boolean): Promise<TaskRunResult> {
  const minutes = settings.maxTaskMinutes + 2;
  const safety = new Promise<TaskRunResult>((resolve) => {
    const reason = `no result after ${minutes} minutes`;
    const t1 = setTimeout(() => {
      run.abort(reason, "failed");
      const t2 = setTimeout(() => resolve({ outcome: "failed", reason }), ABORT_GRACE_MS);
      cleanups.push(() => clearTimeout(t2));
    }, minutes * 60_000);
    cleanups.push(() => clearTimeout(t1));
  });
  const done = run.done.catch((err: unknown): TaskRunResult => {
    if (throwEnded && err instanceof SessionEndedError) throw err;
    return { outcome: "failed", reason: errText(err) };
  });
  return Promise.race([done, safety]);
}
