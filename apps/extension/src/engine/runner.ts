/**
 * The run pipeline (spec "Run pipeline"): pick the next task (local first,
 * then cloud claims), resolve the brain, materialize media, run, verify,
 * record, pace. Also runs one-off "do this now" sessions. One agent session
 * at a time.
 */
import {
  pauseReasonForUrl,
  pickDelayMs,
  type AgentEvent,
  type AgentTask,
  type ClaimResponse,
  type ExtensionSettings,
  type MediaInfo,
  type ResultInput,
  type RunConfig,
  type Screenshot,
  type SessionInfo,
  type TaskRunResult,
  type TaskSource,
} from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import type { BrainStatus } from "../ui-protocol.js";
import type { AbortOutcome, Brain, BrainRun, CoreApi } from "./brains.js";
import type { LocalStore, StoredLocalTask } from "./local-store.js";
import type { MaterializedMedia, MediaSource } from "./media-files.js";
import type { SessionStore } from "./sessions.js";

export const HEARTBEAT_MS = 2 * 60_000;
export const KEEP_ALIVE_MS = 20_000;
/** Extra wait after aborting a stuck brain before giving up on it. */
const ABORT_GRACE_MS = 30_000;
export const RUNNER_STATE_KEY = "runnerState";

export interface RunnerApi {
  claim(runnerId: string): Promise<ClaimResponse | null>;
  heartbeat(taskId: string, runnerId: string): Promise<unknown>;
  result(taskId: string, body: ResultInput): Promise<void>;
  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo>;
  mediaUrl(mediaId: string): string;
  authHeaders(): { name: string; value: string }[];
}

export interface ResolvedBrain {
  brain: Brain | null;
  status: BrainStatus;
}

/** Persisted across service worker restarts (chrome.storage.local). */
export interface RunnerState {
  lastRunAt?: string;
  lastError?: string;
  /** Set when runs were paused automatically; shown in the side panel. */
  pausedReason?: string;
  consecutiveFailures: number;
  /** The "no brain" message already notified, so it is shown once. */
  noBrainNotified?: string;
}

type StorageLike = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

export interface RunnerDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** Raw partial settings update (used for paused). */
  saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  getRunnerId(): Promise<string>;
  createApi(settings: ExtensionSettings): RunnerApi;
  localStore: LocalStore;
  sessions: SessionStore;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  /** Resolves the brain for these settings; may (re)connect the helper. */
  resolveBrain(settings: ExtensionSettings): Promise<ResolvedBrain>;
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  /** Direct driver access, used for post verification. */
  browser: BrowserCaller;
  /**
   * Pick the run's agent tab and attach the debugger to it.
   * mode "current-tab": the tab the user is looking at (one-off runs);
   * "own-tab": the reusable agent tab (scheduled runs).
   * show: bring the agent tab to the front (one-off runs the user is watching).
   */
  prepareTab(opts?: { show?: boolean; mode?: "current-tab" | "own-tab" }): Promise<void>;
  isAgentTab(tabId: number): Promise<boolean>;
  screenshot(): Promise<Screenshot>;
  notify(title: string, message: string): void | Promise<void>;
  /** Called every KEEP_ALIVE_MS while busy (chrome.runtime.getPlatformInfo). */
  keepAlive(): unknown;
  /** Something the UI shows changed (running session, pause, errors). */
  onStateChange?(): void;
  storage?: StorageLike;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  newId?(): string;
  log?(message: string): void;
}

export interface AdhocInput {
  instructions: string;
  account?: string | null;
  media?: { name: string; blob: Blob }[];
}

type Job =
  | { source: "local"; task: StoredLocalTask }
  | { source: "cloud"; claim: ClaimResponse; api: RunnerApi; runnerId: string }
  | { source: "adhoc"; input: AdhocInput };

interface Active {
  session: SessionInfo;
  run: BrainRun | null;
  forced: { outcome: AbortOutcome; reason: string } | null;
  /** Texts the user typed, to drop the brain's echo of them. */
  said: string[];
  /** Texts the agent typed or pasted into the page; the longest is the post body to verify. */
  typed: string[];
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

const X_STATUS_URL = /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/?#]+\/status\/\d+/i;

export function isXStatusUrl(url: string): boolean {
  return X_STATUS_URL.test(url);
}

export class Runner {
  private active: Active | null = null;
  private isBusy = false;
  private stopRequested = false;
  private wakePacing: (() => void) | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> = Promise.resolve();
  private stateCache: RunnerState | null = null;
  /** An alarm fired while busy: run the due check again once this run ends. */
  private alarmMissed = false;

  constructor(private readonly deps: RunnerDeps) {}

  get busy(): boolean {
    return this.isBusy;
  }

  /** The session running right now, if any. */
  get running(): SessionInfo | null {
    return this.active?.session ?? null;
  }

  /** Resolves when the current run (if any) has finished. */
  idle(): Promise<void> {
    return this.current;
  }

  async state(): Promise<RunnerState> {
    if (!this.stateCache) {
      const got = await this.storage().get(RUNNER_STATE_KEY);
      const raw = (got[RUNNER_STATE_KEY] ?? {}) as Partial<RunnerState>;
      this.stateCache = { ...raw, consecutiveFailures: raw.consecutiveFailures ?? 0 };
    }
    return { ...this.stateCache };
  }

  /** Runs everything due now: local tasks, then cloud claims. Returns at once. */
  async runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }> {
    if (this.isBusy) {
      if (trigger === "alarm") this.alarmMissed = true;
      return { started: false, detail: "A task is already running" };
    }
    this.begin();
    let settings: ExtensionSettings;
    try {
      settings = await this.deps.loadSettings();
    } catch (err) {
      this.end();
      return { started: false, detail: errText(err) };
    }
    if (settings.paused && trigger === "alarm") {
      this.end();
      return { started: false, detail: "Scheduled runs are paused" };
    }
    this.current = this.loop(settings).finally(() => this.end());
    return { started: true };
  }

  /** Starts a one-off task now. Resolves once its session exists. */
  async runAdhoc(input: AdhocInput): Promise<{ sessionId: string }> {
    if (!input.instructions?.trim()) throw new Error("Instructions are empty");
    if (this.isBusy) throw new Error("A task is already running. Stop it or wait for it to finish.");
    this.begin();
    let settings: ExtensionSettings;
    let resolved: ResolvedBrain;
    try {
      settings = await this.deps.loadSettings();
      resolved = await this.deps.resolveBrain(settings);
      if (!resolved.brain) throw new Error(resolved.status.note ?? "No brain available");
    } catch (err) {
      this.end();
      throw err;
    }
    const sessionId = this.newId();
    let created!: () => void;
    const sessionReady = new Promise<void>((r) => (created = r));
    this.current = this.runJob({ source: "adhoc", input }, resolved, settings, sessionId, created)
      .then(() => {})
      .catch((err) => this.log(`adhoc run failed: ${errText(err)}`))
      .finally(() => {
        created();
        this.end();
      });
    await sessionReady;
    return { sessionId };
  }

  /** Stops the running session (reported as paused "stopped by user") and the run loop. */
  stop(): boolean {
    if (!this.isBusy) return false;
    this.stopRequested = true;
    this.wakePacing?.();
    const a = this.active;
    if (a && !a.forced) {
      a.forced = { outcome: "paused", reason: "stopped by user" };
      a.run?.abort("stopped by user", "paused");
    }
    return true;
  }

  /** Types into the running session. */
  async say(text: string): Promise<boolean> {
    const a = this.active;
    const t = text.trim();
    if (!a?.run || !t) return false;
    a.said.push(t);
    this.emit(a, { type: "user_message", text: t });
    return a.run.sendUserMessage(t);
  }

  async pauseSchedule(reason?: string): Promise<void> {
    await this.deps.saveSettings({ paused: true });
    await this.patchState(reason ? { pausedReason: reason } : { pausedReason: undefined });
    this.changed();
  }

  async resumeSchedule(): Promise<void> {
    await this.deps.saveSettings({ paused: false });
    await this.patchState({ pausedReason: undefined, consecutiveFailures: 0 });
    this.changed();
  }

  /** Startup crash recovery for local tasks. */
  async recover(): Promise<number> {
    const settings = await this.deps.loadSettings();
    const n = await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes);
    if (n) this.log(`recovered ${n} interrupted local task(s)`);
    return n;
  }

  /** chrome.tabs.onUpdated: pause the session when the agent tab hits a pause URL. */
  async onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void> {
    const a = this.active;
    if (!a || !changeInfo.url || a.forced) return;
    const reason = pauseReasonForUrl(changeInfo.url);
    if (!reason || !(await this.deps.isAgentTab(tabId))) return;
    if (a.forced || this.active !== a) return;
    a.forced = { outcome: "paused", reason };
    this.emit(a, { type: "status", text: `Pausing: ${reason}` });
    a.run?.abort(reason, "paused");
  }

  /** The user closed the debugger infobar: stop the session. */
  onDebuggerCanceled(): void {
    const a = this.active;
    if (!a || a.forced) return;
    a.forced = { outcome: "failed", reason: "debugger detached by user" };
    a.run?.abort("debugger detached by user", "failed");
  }

  // ---------------------------------------------------------------------------

  private async loop(initial: ExtensionSettings): Promise<void> {
    let settings = initial;
    const pausedAtStart = settings.paused;
    await this.patchState({ lastRunAt: this.now().toISOString(), lastError: undefined });
    this.changed();
    try {
      await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes);
      const runnerId = await this.deps.getRunnerId();
      for (;;) {
        if (this.stopRequested) return;
        const local = (await this.deps.localStore.due(this.now()))[0];
        const cloudOn = settings.cloudEnabled && !!settings.apiBase && !!settings.runnerKey;
        if (!local && !cloudOn) {
          if (settings.cloudEnabled && !cloudOn) await this.patchState({ lastError: "Cloud sync is on but the API URL or runner key is missing" });
          return;
        }

        const resolved = await this.deps.resolveBrain(settings);
        if (!resolved.brain) {
          const note = resolved.status.note ?? "No brain available";
          const st = await this.state();
          await this.patchState({ lastError: note, noBrainNotified: note });
          if (st.noBrainNotified !== note) await this.deps.notify("Cannot run tasks", note);
          return;
        }
        if ((await this.state()).noBrainNotified) await this.patchState({ noBrainNotified: undefined });

        let job: Job;
        if (local) job = { source: "local", task: local };
        else {
          const api = this.deps.createApi(settings);
          let claim: ClaimResponse | null;
          try {
            claim = await api.claim(runnerId);
          } catch (err) {
            await this.patchState({ lastError: `Cloud claim failed: ${errText(err)}` });
            return;
          }
          if (!claim) return;
          job = { source: "cloud", claim, api, runnerId };
        }

        const result = await this.runJob(job, resolved, settings, this.newId());

        if (result.outcome === "done") await this.patchState({ consecutiveFailures: 0 });
        else if (result.outcome === "failed" || result.outcome === "retry") {
          const n = (await this.state()).consecutiveFailures + 1;
          await this.patchState({ consecutiveFailures: n });
          const max = settings.maxConsecutiveFailures;
          if (max > 0 && n >= max) {
            const reason = `Paused after ${n} failed tasks in a row. Last: ${result.reason ?? result.outcome}`;
            await this.deps.saveSettings({ paused: true });
            await this.patchState({ pausedReason: reason });
            await this.deps.notify("Runs paused", reason);
            return;
          }
        }
        if (this.stopRequested) return;
        if (result.outcome === "paused") {
          await this.deps.notify("Task paused", result.reason ?? "The task needs your attention.");
          return;
        }

        settings = await this.deps.loadSettings();
        if (settings.paused && !pausedAtStart) return;
        const more =
          (await this.deps.localStore.due(this.now())).length > 0 || (settings.cloudEnabled && !!settings.apiBase && !!settings.runnerKey);
        if (!more) return;
        await this.pace(pickDelayMs(settings));
      }
    } catch (err) {
      await this.patchState({ lastError: errText(err) });
      this.log(`run failed: ${errText(err)}`);
    }
  }

  /** One agent session through the whole pipeline. Returns the final (recorded) result. */
  private async runJob(
    job: Job,
    resolved: ResolvedBrain,
    settings: ExtensionSettings,
    sessionId: string,
    onSessionCreated?: () => void,
  ): Promise<TaskRunResult> {
    const brain = resolved.brain!;
    const source: TaskSource = job.source;
    let task: AgentTask;
    let isRetry = false;
    let taskId: string | undefined;
    if (job.source === "local") {
      // Crash marker: persisted before anything can act.
      const marked = await this.deps.localStore.markStarted(job.task.id);
      taskId = marked.id;
      task = { id: marked.id, instructions: marked.instructions, account: marked.account };
      isRetry = marked.attempts > 1 || !!job.task.crashed;
    } else if (job.source === "cloud") {
      const t = job.claim.task;
      taskId = t.id;
      task = { id: t.id, instructions: t.instructions, account: t.account };
      isRetry = t.attempts > 1;
    } else {
      task = { id: sessionId, instructions: job.input.instructions.trim(), account: job.input.account?.trim() || null };
    }

    const info: SessionInfo = {
      sessionId,
      source,
      title: titleOf(task.instructions),
      brain: brain.kind,
      jev: resolved.status.jevActive,
      startedAt: this.now().toISOString(),
    };
    if (taskId) info.taskId = taskId;
    const active: Active = { session: info, run: null, forced: null, said: [], typed: [] };
    this.active = active;
    await this.deps.sessions.create(info);
    onSessionCreated?.();
    this.changed();
    this.log(`session ${sessionId} (${source}${taskId ? ` ${taskId}` : ""}) started with ${brain.kind}`);

    const cleanups: (() => void | Promise<void>)[] = [];
    if (job.source === "cloud") {
      const t = setInterval(() => {
        job.api.heartbeat(job.claim.task.id, job.runnerId).catch((err) => this.log(`heartbeat failed: ${errText(err)}`));
      }, HEARTBEAT_MS);
      cleanups.push(() => clearInterval(t));
    }

    let result: TaskRunResult;
    try {
      await this.deps.prepareTab({ show: job.source === "adhoc", mode: job.source === "adhoc" ? "current-tab" : "own-tab" });
      const sources = await this.mediaSources(job);
      if (sources.length) this.emit(active, { type: "status", text: `Preparing ${sources.length} file(s)` });
      const media = await this.deps.media.materialize(sessionId, sources);
      cleanups.push(() => media.cleanup());
      const config: RunConfig = {
        maxToolCalls: settings.maxToolCalls,
        maxTaskMinutes: settings.maxTaskMinutes,
        jevEnabled: settings.jevEnabled,
        jevThreshold: settings.jevThreshold,
        isRetry,
      };
      if (settings.jevApiKey) config.jevApiKey = settings.jevApiKey;
      // One model setting for both brains (the API brain also reads it from settings).
      if (settings.anthropicModel.trim()) config.model = settings.anthropicModel.trim();
      if (active.forced) throw new Error(active.forced.reason);
      const run = brain.start({ sessionId, task, mediaPaths: media.paths, config, settings, onEvent: (e) => this.onBrainEvent(active, e) });
      active.run = run;
      // stop() or a pause URL may have landed while the brain was starting.
      const forced = active.forced as Active["forced"];
      if (forced) run.abort(forced.reason, forced.outcome);
      result = await this.withSafetyTimer(run, settings, cleanups);
    } catch (err) {
      result = { outcome: "failed", reason: errText(err) };
    }
    if (active.forced) result = { ...result, outcome: active.forced.outcome, reason: active.forced.reason };

    result = await this.postCheck(active, task, result);

    if (job.source === "local") {
      try {
        await this.deps.localStore.finish(job.task.id, result, { retryAfterMinutes: settings.retryAfterMinutes });
      } catch (err) {
        this.log(`recording local result failed: ${errText(err)}`);
      }
    } else if (job.source === "cloud") {
      await this.reportCloud(job, result, settings);
    }

    for (const fn of cleanups) {
      try {
        await fn();
      } catch {
        /* cleanup is best effort */
      }
    }

    const end: AgentEvent = { type: "task_end", outcome: result.outcome };
    if (result.summary) end.summary = result.summary;
    if (result.url) end.url = result.url;
    if (result.reason) end.reason = result.reason;
    this.deps.sessions.append(sessionId, end);
    const patch: Partial<SessionInfo> = { endedAt: this.now().toISOString(), outcome: result.outcome };
    if (result.summary) patch.summary = result.summary;
    if (result.url) patch.url = result.url;
    if (result.reason) patch.reason = result.reason;
    await this.deps.sessions.update(sessionId, patch);
    this.active = null;
    this.changed();
    this.log(`session ${sessionId} ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  }

  /** Verification and failure classification (pipeline steps 4-5). */
  private async postCheck(active: Active, task: AgentTask, result: TaskRunResult): Promise<TaskRunResult> {
    if (result.outcome === "done" && result.url && isXStatusUrl(result.url) && !active.forced) {
      this.emit(active, { type: "status", text: "Verifying the post" });
      let ok = false;
      let detail = "";
      try {
        // Compare against what the agent actually entered, not the whole instructions.
        const expected = active.typed.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), "");
        const v = await this.deps.core.verifyXPost(this.deps.browser, result.url, expected);
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
        this.log(`classifyFailure failed: ${errText(err)}`);
      }
      if (kind === "transient") return { ...result, outcome: "retry" };
    }
    return result;
  }

  private async reportCloud(job: Extract<Job, { source: "cloud" }>, result: TaskRunResult, settings: ExtensionSettings): Promise<void> {
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
      const shot = await this.deps.screenshot();
      const bytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
      const ext = shot.mimeType === "image/png" ? "png" : "jpg";
      body.screenshotId = (await job.api.uploadMedia(new Blob([bytes], { type: shot.mimeType }), `result-${taskId}.${ext}`)).id;
    } catch (err) {
      this.log(`final screenshot skipped: ${errText(err)}`);
    }
    try {
      await job.api.result(taskId, body);
    } catch (err) {
      await this.patchState({ lastError: `Reporting ${taskId} failed: ${errText(err)}` });
    }
  }

  private async mediaSources(job: Job): Promise<MediaSource[]> {
    if (job.source === "local") {
      return (await this.deps.localStore.getMedia(job.task.mediaIds)).map((m) => ({ kind: "blob" as const, name: m.name, blob: m.blob }));
    }
    if (job.source === "cloud") {
      return job.claim.media.map((m) => ({ kind: "url" as const, name: m.filename, url: job.api.mediaUrl(m.id), headers: job.api.authHeaders() }));
    }
    return (job.input.media ?? []).map((m) => ({ kind: "blob" as const, name: m.name, blob: m.blob }));
  }

  private withSafetyTimer(run: BrainRun, settings: ExtensionSettings, cleanups: (() => void)[]): Promise<TaskRunResult> {
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
    const done = run.done.catch((err: unknown): TaskRunResult => ({ outcome: "failed", reason: errText(err) }));
    return Promise.race([done, safety]);
  }

  private onBrainEvent(active: Active, e: AgentEvent): void {
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

  private emit(active: Active, e: AgentEvent): void {
    this.deps.sessions.append(active.session.sessionId, e);
  }

  private async pace(ms: number): Promise<void> {
    if (ms <= 0 || this.stopRequested) return;
    const woke = new Promise<void>((r) => (this.wakePacing = r));
    const slept = this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
    await Promise.race([slept, woke]);
    this.wakePacing = null;
  }

  private begin(): void {
    this.isBusy = true;
    this.stopRequested = false;
    this.keepAliveTimer ??= setInterval(() => {
      try {
        void Promise.resolve(this.deps.keepAlive()).catch(() => {});
      } catch {
        /* ignore */
      }
    }, KEEP_ALIVE_MS);
    this.changed();
  }

  private end(): void {
    this.isBusy = false;
    this.stopRequested = false;
    this.active = null;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.changed();
    if (this.alarmMissed) {
      this.alarmMissed = false;
      setTimeout(() => void this.runDue("alarm"), 0);
    }
  }

  private async patchState(patch: Partial<RunnerState>): Promise<void> {
    const next = { ...(await this.state()), ...patch } as RunnerState;
    for (const k of Object.keys(next) as (keyof RunnerState)[]) if (next[k] === undefined) delete next[k];
    this.stateCache = next;
    await this.storage().set({ [RUNNER_STATE_KEY]: next });
  }

  private changed(): void {
    try {
      this.deps.onStateChange?.();
    } catch {
      /* UI push errors are not the runner's problem */
    }
  }

  private storage(): StorageLike {
    return this.deps.storage ?? (chrome.storage.local as unknown as StorageLike);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private newId(): string {
    return this.deps.newId?.() ?? crypto.randomUUID();
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

function titleOf(instructions: string): string {
  const one = instructions.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
