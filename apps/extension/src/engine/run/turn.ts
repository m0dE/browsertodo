/**
 * Running one turn of a session in its agent slot: the first turn of a new
 * session (tab, media, brain), the brain's run with its safety timer, the
 * brain's events into the session, and the checks on the result (X post
 * verification, failure classification). Next turns: conversation.ts.
 */
import { bareToolName, errorMessage, isXStatusUrl, type AgentEvent, type AgentTask, type ExtensionSettings, type RunConfig, type SessionInfo, type TaskRunResult, type UserTab } from "@browsertodo/shared";
import type { AgentSlot } from "../../agent-slots.js";
import { SessionEndedError, type Brain, type BrainRun, type ContinuableBrain, type CoreApi } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import type { MaterializedMedia, MediaSource } from "../media-files.js";
import type { SessionStore } from "../sessions.js";
import type { TabChatsLike } from "../../tab-chats.js";
import { isRestrictedUrl, RESTRICTED_STATUS } from "../../restricted.js";
import type { ForcedStop } from "./active.js";
import { ABORT_GRACE_MS, safetyTimeoutMinutes } from "./deadline.js";
import { mediaSources, type FirstJob } from "./jobs.js";

/** Said in the thread when a conversation's tab could not be used and it moved to a new one. */
export const MOVED_TAB_STATUS = "That tab cannot be controlled (a browser page) or another run is using it: working in a new tab next to it";

/** A session running right now. */
export interface ActiveSession {
  session: SessionInfo;
  /** The agent slot (tab) the session acts in. */
  slot: AgentSlot;
  run: BrainRun | null;
  /** Set when the runner stopped the session (Stop, a pause URL, ...): the outcome it ends with. */
  forced: ForcedStop | null;
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
  const name = bareToolName(e.name);
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

/** A browser tab as chrome.tabs reports it. */
export interface TabPage {
  tabId: number;
  url: string;
  title: string;
}

export interface TurnDeps {
  sessions: SessionStore;
  /** Which browser tab each conversation belongs to (absent: conversations have no tab). */
  tabChats?: TabChatsLike;
  localStore: LocalStore;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  /**
   * The id, address and title of a browser tab (no tabId: the tab the user is
   * looking at), from chrome.tabs, which works on every page. Absent: not known.
   */
  pageOf?(tabId?: number): Promise<TabPage | null>;
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
   * the brain and waits for the result. One-off runs act on the tab they were
   * started from (or, without one, the tab the user is looking at); other
   * jobs on the slot's own tab.
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
    const origin = adhoc ? job.input.tabId : undefined;
    // The tab the user sent it from (no origin: the one they are looking at). It may be a page Chrome keeps
    // extensions out of: the run still starts, in a tab next to it.
    const page = adhoc ? await this.pageOf(origin) : null;
    const restricted = !!page && isRestrictedUrl(page.url);
    let picked: number;
    if (origin === undefined) {
      picked = await active.slot.prepare({ mode: adhoc ? "current-tab" : "own-tab" });
      if (restricted) this.emit(active, { type: "status", text: RESTRICTED_STATUS });
    } else {
      // Not brought to the front: the user may have moved on to another tab already.
      picked = await active.slot.prepare({ mode: "current-tab", tabId: origin });
      await this.follow(active, origin, picked, restricted);
    }
    // The agent is told which page the user is looking at (buildTaskPrompt); scheduled and TODO tasks have none.
    const task: AgentTask = page ? { ...opened.task, userTab: userTabOf(page, picked) } : opened.task;
    const sources = await mediaSources(job, this.deps.localStore);
    if (sources.length) this.emit(active, { type: "status", text: `Preparing ${sources.length} file(s)` });
    const mediaPaths = await this.materialize(active, sources, cleanups);
    const config = runConfig(settings, opened.isRetry);
    if (active.forced) throw new Error(active.forced.reason);
    const run = this.start(active, brain, { task, mediaPaths, config, settings });
    return this.drive(active, run, settings, cleanups);
  }

  /** The browser tab a conversation belongs to, or null. */
  async tabOf(sessionId: string): Promise<number | null> {
    return this.deps.tabChats ? this.deps.tabChats.tabOf(sessionId).catch(() => null) : null;
  }

  /** A browser tab's id, address and title (no tabId: the one the user is looking at), or null when not known. */
  async pageOf(tabId?: number): Promise<TabPage | null> {
    return (await this.deps.pageOf?.(tabId).catch(() => null)) ?? null;
  }

  /**
   * The conversation's run went to another tab than its own (e.g. its tab
   * shows a chrome:// page): it now belongs there. restricted: the reason was
   * a page Chrome keeps extensions out of (said in a quiet line).
   */
  async follow(active: ActiveSession, origin: number, picked: number, restricted = false): Promise<void> {
    if (picked === origin) return;
    if (restricted) this.emit(active, { type: "status", text: RESTRICTED_STATUS });
    if (!this.deps.tabChats) return;
    if (!restricted) this.emit(active, { type: "status", text: MOVED_TAB_STATUS });
    await this.bindChat(picked, active.session.sessionId);
  }

  /** The conversation now belongs to this browser tab (the side panel shows it there). A failure is logged, not thrown. */
  async bindChat(tabId: number, sessionId: string): Promise<void> {
    await this.deps.tabChats?.bind(tabId, sessionId).catch((err: unknown) => this.deps.log(`binding the chat to tab ${tabId} failed: ${errorMessage(err)}`));
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
  continue(active: ActiveSession, brain: ContinuableBrain, opts: { text: string; config: RunConfig; settings: ExtensionSettings }): BrainRun {
    return brain.continue({
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
    const forced = active.forced;
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
        detail = errorMessage(err);
      }
      if (!ok) {
        this.emit(active, { type: "status", text: `Post not verified: ${detail}` });
        // The agent's follow-up assumed the post went out: not offered.
        const { suggestion: _unverified, ...unverified } = result;
        return { ...unverified, outcome: "retry", reason: `could not verify the post${detail ? `: ${detail}` : ""}` };
      }
      this.emit(active, { type: "status", text: "Post verified" });
    }
    if (result.outcome === "failed" && result.reason && !active.forced) {
      let kind: string = "permanent";
      try {
        kind = this.deps.core.classifyFailure(result.reason);
      } catch (err) {
        this.deps.log(`classifyFailure failed: ${errorMessage(err)}`);
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

/** The user's tab as the agent is told about it, once the run's tab was picked (`picked`: where the run works). */
export function userTabOf(page: TabPage, picked: number): UserTab {
  const access = isRestrictedUrl(page.url) ? "restricted" : picked === page.tabId ? "here" : "elsewhere";
  return { url: page.url, title: page.title, access };
}

function withSafetyTimer(run: BrainRun, settings: ExtensionSettings, cleanups: Cleanup[], throwEnded: boolean): Promise<TaskRunResult> {
  const minutes = safetyTimeoutMinutes(settings.maxTaskMinutes);
  const safety = new Promise<TaskRunResult>((resolve) => {
    const reason = `No result after ${minutes} minutes`;
    const t1 = setTimeout(() => {
      run.abort(reason, "failed");
      const t2 = setTimeout(() => resolve({ outcome: "failed", reason }), ABORT_GRACE_MS);
      cleanups.push(() => clearTimeout(t2));
    }, minutes * 60_000);
    cleanups.push(() => clearTimeout(t1));
  });
  const done = run.done.catch((err: unknown): TaskRunResult => {
    if (throwEnded && err instanceof SessionEndedError) throw err;
    return { outcome: "failed", reason: errorMessage(err) };
  });
  return Promise.race([done, safety]);
}
