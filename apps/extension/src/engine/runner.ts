/**
 * The run pipeline (spec "Run pipeline"): pick due tasks (local first, then
 * cloud claims), resolve the brain, materialize media, run, verify, record,
 * pace. Also runs one-off "do this now" sessions and the follow-up turns of a
 * conversation (message()).
 *
 * Several sessions can run at once, each in its own agent slot (tab): up to
 * maxParallelTasks due tasks, plus one-off runs and conversation turns beside
 * them. X tasks take turns (see run/scheduling.ts).
 *
 * The Runner is the public API, the due loop and the lifecycle of each job;
 * the steps live in run/: jobs.ts (where work comes from), scheduling.ts
 * (slots, X turn, pacing), active.ts (the running sessions and what they
 * hold), turn.ts (a session's first turn, the brain run and its checks),
 * conversation.ts (next turns), record.ts (results), state.ts (persisted
 * state, keep-alive).
 */
import {
  isXTask,
  pauseReasonForUrl,
  pickDelayMs,
  type AgentTask,
  type ExtensionSettings,
  type Screenshot,
  type SessionInfo,
  type StampedAgentEvent,
  type TaskRunResult,
  MAX_INSTRUCTIONS_CHARS,
} from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";
import type { AgentSlot, SlotPool } from "../agent-slots.js";
import { lastTurnEvents } from "../continue.js";
import { errText } from "../errors.js";
import type { BrainStatus } from "../ui-protocol.js";
import type { Brain, CoreApi } from "./brains.js";
import type { StorageLike } from "./kv.js";
import type { LocalStore } from "./local-store.js";
import type { MaterializedMedia, MediaSource } from "./media-files.js";
import type { SessionStore } from "./sessions.js";
import { ActiveSessions } from "./run/active.js";
import { CONTINUE_TEXT, continueRefusal, runNextTurn } from "./run/conversation.js";
import { dueLocal, openTask, startHeartbeat, turnJob, type AdhocJob, type AdhocInput, type FirstJob, type Job, type RunnerApi, type TurnJob } from "./run/jobs.js";
import { ResultRecorder } from "./run/record.js";
import { Pacer, scheduledCap, X_WAIT_STATUS } from "./run/scheduling.js";
import { KeepAlive, RunnerStateStore, type RunnerState } from "./run/state.js";
import { modelOf, runCleanups, TurnRunner, typedTextsOf, type ActiveSession, type Cleanup } from "./run/turn.js";

export interface ResolvedBrain {
  brain: Brain | null;
  status: BrainStatus;
}

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
  /**
   * Agent slots: each running session gets its own tab. Without a pool, one
   * session runs at a time in the tab below (prepareTab, browser, ...).
   */
  slots?: SlotPool;
  /** Single-slot mode: direct driver access (post verification, the API brain). */
  browser?: BrowserCaller;
  /**
   * Single-slot mode: pick the run's agent tab and attach the debugger to it.
   * mode "current-tab": the tab the user is looking at (one-off runs);
   * "own-tab": the reusable agent tab (scheduled runs, and the next turns of a conversation).
   * show: bring the agent tab to the front (runs the user is watching).
   */
  prepareTab?(opts?: { show?: boolean; mode?: "current-tab" | "own-tab" }): Promise<void>;
  isAgentTab?(tabId: number): Promise<boolean>;
  screenshot?(): Promise<Screenshot>;
  notify(title: string, message: string): void | Promise<void>;
  /** Called every KEEP_ALIVE_MS while busy (chrome.runtime.getPlatformInfo). */
  keepAlive(): unknown;
  /** Something the UI shows changed (running sessions, pause, errors). */
  onStateChange?(): void;
  storage?: StorageLike;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  newId?(): string;
  log?(message: string): void;
}

/** How message() delivered the user's text. */
export type MessageMode =
  /** Typed into the turn that is running. */
  | "inject"
  /** A new turn of an ended conversation (in its own agent session when it is still open, else a fresh one with a summary). */
  | "turn"
  /** No conversation given: a new one-off conversation. */
  | "new";

interface StartOptions {
  slotIndex: number;
  /** A due task run by the loop (counts toward maxParallelTasks). */
  scheduled: boolean;
  /** Called once the session exists (or failed to start). */
  onSessionCreated?: () => void;
}

export class Runner {
  /** Sessions running right now, and the slots, X turn and local tasks they hold. */
  private readonly live: ActiveSessions;
  /** Every job in flight (the due loop's and one-off ones). */
  private readonly jobs = new Set<Promise<unknown>>();
  private loopPromise: Promise<void> | null = null;
  private stopRequested = false;
  /** An alarm fired while the due loop ran: check again once it ends. */
  private alarmMissed = false;
  /** Conversations whose next turn is starting. */
  private readonly startingTurns = new Set<string>();
  private reservations = 0;
  /** Serializes the consecutive-failure bookkeeping of parallel jobs. */
  private accounting: Promise<unknown> = Promise.resolve();
  private readonly pacer: Pacer;
  private readonly keepAlive: KeepAlive;
  private readonly runnerState: RunnerStateStore;
  private readonly turns: TurnRunner;
  private readonly recorder: ResultRecorder;

  constructor(private readonly deps: RunnerDeps) {
    const log = (m: string) => this.log(m);
    this.live = new ActiveSessions(deps.slots, () => this.singleSlot());
    this.pacer = new Pacer(deps.sleep);
    this.keepAlive = new KeepAlive(() => deps.keepAlive());
    this.runnerState = new RunnerStateStore(() => deps.storage ?? (chrome.storage.local as unknown as StorageLike));
    this.turns = new TurnRunner({ sessions: deps.sessions, localStore: deps.localStore, media: deps.media, core: deps.core, log });
    this.recorder = new ResultRecorder({
      localStore: deps.localStore,
      sessions: deps.sessions,
      patchState: (p) => this.runnerState.patch(p),
      now: () => this.now(),
      log,
    });
  }

  get busy(): boolean {
    return this.loopPromise !== null || this.jobs.size > 0 || this.keepAlive.held;
  }

  /** The session started last among those running, if any. */
  get running(): SessionInfo | null {
    return this.live.last()?.session ?? null;
  }

  /** Every session running right now, oldest first. */
  get runningSessions(): SessionInfo[] {
    return this.live.all().map((a) => a.session);
  }

  /** Resolves when the due loop and every job have finished. */
  async idle(): Promise<void> {
    while (this.loopPromise || this.jobs.size) {
      await Promise.allSettled([this.loopPromise, ...this.jobs]);
    }
  }

  state(): Promise<RunnerState> {
    return this.runnerState.get();
  }

  /** Runs everything due now: local tasks, then cloud claims, several at once. Returns at once. */
  async runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }> {
    if (this.loopPromise) {
      if (trigger === "alarm") this.alarmMissed = true;
      return { started: false, detail: "A task is already running" };
    }
    this.hold();
    let settings: ExtensionSettings;
    try {
      settings = await this.deps.loadSettings();
    } catch (err) {
      this.drop();
      return { started: false, detail: errText(err) };
    }
    if (settings.paused && trigger === "alarm") {
      this.drop();
      return { started: false, detail: "Scheduled runs are paused" };
    }
    if (this.loopPromise) {
      this.drop();
      return { started: false, detail: "A task is already running" };
    }
    this.stopRequested = false;
    this.loopPromise = this.loop(settings).finally(() => {
      this.loopPromise = null;
      this.drop();
      if (this.alarmMissed) {
        this.alarmMissed = false;
        setTimeout(() => void this.runDue("alarm"), 0);
      }
    });
    return { started: true };
  }

  /** Starts a one-off task now: a new conversation. Resolves once its session exists. */
  async runAdhoc(input: AdhocInput): Promise<{ sessionId: string }> {
    if (!input.instructions?.trim()) throw new Error("Instructions are empty");
    return this.startOne(null, async () => ({ source: "adhoc", input }));
  }

  /**
   * The user's message in a conversation (the side panel's box).
   * - The conversation's turn is running: typed into it ("inject").
   * - It ended: the next turn ("turn"; see run/conversation.ts).
   * - No conversation: a new one-off conversation ("new").
   */
  async message(sessionId: string | null | undefined, text: string): Promise<{ sessionId: string; mode: MessageMode }> {
    const t = text.trim();
    if (!t) throw new Error("The message is empty");
    if (!sessionId) return { ...(await this.runAdhoc({ instructions: t })), mode: "new" };
    if (this.live.has(sessionId)) {
      if (!(await this.say(t, sessionId))) throw new Error("The agent did not take the message");
      return { sessionId, mode: "inject" };
    }
    if (this.startingTurns.has(sessionId)) throw new Error("That conversation is already starting its next turn");
    this.startingTurns.add(sessionId);
    try {
      await this.startOne(sessionId, () => turnJob(this.deps, sessionId, t));
    } finally {
      this.startingTurns.delete(sessionId);
    }
    return { sessionId, mode: "turn" };
  }

  /**
   * "Continue" for a run that ended paused, failed or retry (e.g. stopped by
   * the user): the next turn of that conversation, with the note as the
   * user's message (or CONTINUE_TEXT). Cloud runs continue from the server's
   * queue instead.
   */
  async continueSession(sessionId: string, note?: string): Promise<{ sessionId: string }> {
    const from = await this.deps.sessions.get(sessionId);
    const refusal = continueRefusal(from, sessionId, this.live.has(sessionId));
    if (refusal) throw new Error(refusal);
    const { sessionId: id } = await this.message(sessionId, note?.trim() || CONTINUE_TEXT);
    return { sessionId: id };
  }

  /**
   * New chat: the conversation is over. Its kept-open agent session is closed
   * (a running turn is left alone; the UI just stops targeting it).
   */
  async newChat(sessionId?: string | null): Promise<{ ok: boolean }> {
    if (!sessionId || this.live.has(sessionId)) return { ok: true };
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false };
    this.live.slots.forget(sessionId);
    try {
      const { brain } = await this.deps.resolveBrain(await this.deps.loadSettings());
      if (brain?.kind === session.brain) await brain.end?.(sessionId);
    } catch (err) {
      this.log(`ending the agent session of ${sessionId} failed: ${errText(err)}`);
    }
    return { ok: true };
  }

  /**
   * Stops a session (reported as paused "stopped by user"): the one given, or
   * every running session and the due loop.
   */
  stop(sessionId?: string): boolean {
    if (sessionId) {
      const a = this.live.get(sessionId);
      if (!a) return false;
      this.live.force(a, "paused", "stopped by user");
      return true;
    }
    if (!this.busy) return false;
    this.stopRequested = true;
    this.pacer.interrupt();
    for (const a of this.live.all()) this.live.force(a, "paused", "stopped by user");
    this.live.ended.notify();
    this.live.xTurn.wake();
    return true;
  }

  /** Types into a running session (default: the one started last). */
  async say(text: string, sessionId?: string): Promise<boolean> {
    const a = sessionId ? this.live.get(sessionId) : this.live.last();
    const t = text.trim();
    if (!a?.run || !t) return false;
    a.said.push(t);
    this.turns.emit(a, { type: "user_message", text: t });
    return a.run.sendUserMessage(t);
  }

  async pauseSchedule(reason?: string): Promise<void> {
    await this.deps.saveSettings({ paused: true });
    await this.runnerState.patch({ pausedReason: reason });
    this.changed();
  }

  async resumeSchedule(): Promise<void> {
    await this.deps.saveSettings({ paused: false });
    await this.runnerState.patch({ pausedReason: undefined, consecutiveFailures: 0 });
    this.changed();
  }

  /** Startup crash recovery for local tasks. */
  async recover(): Promise<number> {
    const settings = await this.deps.loadSettings();
    const n = await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes);
    if (n) this.log(`recovered ${n} interrupted local task(s)`);
    return n;
  }

  /** chrome.tabs.onUpdated: pause the session whose agent tab hit a pause URL. */
  async onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void> {
    if (!changeInfo.url) return;
    const reason = pauseReasonForUrl(changeInfo.url);
    if (!reason) return;
    for (const a of this.live.all()) {
      if (a.forced || !(await a.slot.isAgentTab(tabId))) continue;
      if (a.forced || this.live.get(a.session.sessionId) !== a) continue;
      this.turns.emit(a, { type: "status", text: `Pausing: ${reason}` });
      this.live.force(a, "paused", reason);
    }
  }

  /** The user closed the debugger infobar (it ends debugging of every tab): stop every session. */
  onDebuggerCanceled(): void {
    for (const a of this.live.all()) this.live.force(a, "failed", "debugger detached by user");
  }

  // --- starting jobs -------------------------------------------------------------

  /**
   * Runs one job now, beside whatever else runs (not the due loop). Resolves
   * once its session exists (or is reopened). conversation: the session whose
   * next turn this is (it prefers the slot it used).
   */
  private async startOne(conversation: string | null, makeJob: () => Promise<AdhocJob | TurnJob>): Promise<{ sessionId: string }> {
    // Reserved before anything async, so two quick starts never share a slot.
    const reservation = `starting:${++this.reservations}`;
    const slotIndex = this.live.slots.reserve(reservation, conversation === null ? undefined : this.live.slots.lastOf(conversation));
    if (slotIndex === null) {
      throw new Error(
        this.live.slots.count === 1 ? "A task is already running. Stop it or wait for it to finish." : `${this.live.size} tasks are running. Stop one or wait for one to finish.`,
      );
    }
    this.hold();
    let settings: ExtensionSettings;
    let resolved: ResolvedBrain;
    let job: AdhocJob | TurnJob;
    try {
      job = await makeJob();
      settings = await this.deps.loadSettings();
      resolved = await this.deps.resolveBrain(settings);
      if (!resolved.brain) throw new Error(resolved.status.note ?? "No brain available");
    } catch (err) {
      this.live.slots.unassign(slotIndex);
      this.drop();
      throw err;
    }
    const sessionId = job.source === "turn" ? job.from.sessionId : this.newId();
    this.live.slots.assign(slotIndex, sessionId);
    let created!: () => void;
    const sessionReady = new Promise<void>((r) => (created = r));
    const opts: StartOptions = { slotIndex, scheduled: false, onSessionCreated: created };
    const run = job.source === "turn" ? this.runTurn(job, resolved, settings, opts) : this.runJob(job, resolved, settings, sessionId, opts);
    const tracked: Promise<unknown> = run
      .catch((err) => this.log(`${job.source} run failed: ${errText(err)}`))
      .finally(() => {
        created();
        this.jobs.delete(tracked);
        this.drop();
      });
    this.jobs.add(tracked);
    await sessionReady;
    return { sessionId };
  }

  /** The due loop: starts due tasks while there is room, pacing between starts. */
  private async loop(initial: ExtensionSettings): Promise<void> {
    let settings = initial;
    const pausedAtStart = settings.paused;
    await this.runnerState.patch({ lastRunAt: this.now().toISOString(), lastError: undefined });
    this.changed();
    const scheduled = new Set<Promise<unknown>>();
    let halted = false;
    let started = 0;
    let paced = false;
    let cloudEmpty = false;
    try {
      await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes);
      const runnerId = await this.deps.getRunnerId();
      for (;;) {
        if (this.stopRequested || halted) break;
        if (started) settings = await this.deps.loadSettings();
        if (settings.paused && !pausedAtStart) break;
        const cloudOn = settings.cloudEnabled && !!settings.apiBase && !!settings.runnerKey;
        const { startable, blocked } = await dueLocal(this.deps.localStore, this.now(), this.live.localRunning, !this.live.xTurn.free);
        const cloudReady = cloudOn && !cloudEmpty && this.live.xTurn.free;
        if (!startable.length && !cloudReady) {
          if (!started && settings.cloudEnabled && !cloudOn) {
            await this.runnerState.patch({ lastError: "Cloud sync is on but the API URL or runner key is missing" });
          }
          // Due tasks wait for the X task running beside the loop (a one-off run) to finish.
          const waitFor = scheduled.size > 0 || (blocked > 0 && this.live.size > 0) || (cloudOn && !cloudEmpty && !this.live.xTurn.free);
          if (!waitFor) break;
          await this.live.ended.wait();
          continue;
        }
        if (scheduled.size >= scheduledCap(settings, !!this.deps.slots) || this.live.slots.free() === null) {
          await this.live.ended.wait();
          continue;
        }

        const resolved = await this.deps.resolveBrain(settings);
        if (!resolved.brain) {
          const note = resolved.status.note ?? "No brain available";
          const st = await this.runnerState.get();
          await this.runnerState.patch({ lastError: note, noBrainNotified: note });
          if (st.noBrainNotified !== note) await this.deps.notify("Cannot run tasks", note);
          break;
        }
        if ((await this.runnerState.get()).noBrainNotified) await this.runnerState.patch({ noBrainNotified: undefined });

        // The random pause goes between task starts; then look again (things change while it waits).
        if (started > 0 && !paced) {
          if (!this.stopRequested) await this.pacer.pause(pickDelayMs(settings));
          paced = true;
          continue;
        }

        let job: FirstJob | null = null;
        if (startable[0]) job = { source: "local", task: startable[0] };
        else {
          const api = this.deps.createApi(settings);
          try {
            const claim = await api.claim(runnerId);
            if (claim) job = { source: "cloud", claim, api, runnerId };
            else cloudEmpty = true;
          } catch (err) {
            await this.runnerState.patch({ lastError: `Cloud claim failed: ${errText(err)}` });
            cloudEmpty = true;
          }
        }
        if (!job) continue;
        if (this.stopRequested) {
          // A claimed cloud task goes back to the queue on its own when its lease runs out.
          break;
        }

        const sessionId = this.newId();
        const slotIndex = this.live.slots.reserve(sessionId);
        if (slotIndex === null) continue;
        const task = job.source === "local" ? job.task : job.claim.task;
        // Taken now, so the next pick sees it (a cloud X task claimed meanwhile waits in its run).
        if (isXTask(task)) this.live.xTurn.tryTake(sessionId);
        if (job.source === "local") this.live.localRunning.add(job.task.id);
        started++;
        paced = false;
        this.hold();
        const tracked: Promise<unknown> = this.runJob(job, resolved, settings, sessionId, { slotIndex, scheduled: true })
          .then((result) => this.afterScheduled(result, settings))
          .then((halt) => {
            if (halt) halted = true;
          })
          .catch((err) => this.log(`${job.source} run failed: ${errText(err)}`))
          .finally(() => {
            scheduled.delete(tracked);
            this.jobs.delete(tracked);
            this.drop();
            this.live.ended.notify();
          });
        scheduled.add(tracked);
        this.jobs.add(tracked);
      }
      while (scheduled.size) await Promise.allSettled([...scheduled]);
    } catch (err) {
      await this.runnerState.patch({ lastError: errText(err) });
      this.log(`run failed: ${errText(err)}`);
      while (scheduled.size) await Promise.allSettled([...scheduled]);
    }
  }

  /** Failure counting and pausing after a scheduled run. True: start no more tasks in this run. */
  private afterScheduled(result: TaskRunResult, settings: ExtensionSettings): Promise<boolean> {
    const next = this.accounting.then(async () => {
      if (result.outcome === "done") await this.runnerState.patch({ consecutiveFailures: 0 });
      else if (result.outcome === "failed" || result.outcome === "retry") {
        const n = (await this.runnerState.get()).consecutiveFailures + 1;
        await this.runnerState.patch({ consecutiveFailures: n });
        const max = settings.maxConsecutiveFailures;
        if (max > 0 && n >= max && !(await this.deps.loadSettings()).paused) {
          const reason = `Paused after ${n} failed tasks in a row. Last: ${result.reason ?? result.outcome}`;
          await this.deps.saveSettings({ paused: true });
          await this.runnerState.patch({ pausedReason: reason });
          await this.deps.notify("Runs paused", reason);
          return true;
        }
        if (max > 0 && n >= max) return true;
      }
      // The user stopped it: nothing to tell them, and the other tasks go on.
      if (result.outcome === "paused" && result.reason === "stopped by user") return this.stopRequested;
      if (result.outcome === "paused") {
        if (!this.stopRequested) await this.deps.notify("Task paused", result.reason ?? "The task needs your attention.");
        return true;
      }
      return false;
    });
    this.accounting = next.catch(() => {});
    return next;
  }

  // --- running sessions ------------------------------------------------------------

  /** The first turn of a new session through the whole pipeline. Returns the final (recorded) result. */
  private async runJob(job: FirstJob, resolved: ResolvedBrain, settings: ExtensionSettings, sessionId: string, opts: StartOptions): Promise<TaskRunResult> {
    const brain = resolved.brain!;
    let task: AgentTask;
    let isRetry: boolean;
    let taskId: string | undefined;
    let active: ActiveSession | null = null;
    try {
      ({ task, taskId, isRetry } = await openTask(job, sessionId, this.deps.localStore));
      const info: SessionInfo = {
        sessionId,
        source: job.source,
        title: titleOf(task.instructions),
        brain: brain.kind,
        jev: resolved.status.jevActive,
        startedAt: this.now().toISOString(),
      };
      const model = modelOf(settings);
      if (model) info.model = model;
      if (taskId) info.taskId = taskId;
      if (job.source === "adhoc") {
        // Kept so the conversation can go on in a fresh session with its full instructions.
        info.instructions = task.instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
        if (task.account) info.account = task.account;
      }
      active = this.live.activate(info, opts.slotIndex, isXTask(task), opts.scheduled, job.source === "local" ? job.task.id : null);
      await this.deps.sessions.create(info);
    } catch (err) {
      // Nothing ran: give the slot (and the X turn) back.
      if (active) this.live.deactivate(active);
      else this.live.abandon(opts.slotIndex, sessionId, job.source === "local" ? job.task.id : null);
      opts.onSessionCreated?.();
      throw err;
    }
    opts.onSessionCreated?.();
    this.changed();
    this.log(`session ${sessionId} (${job.source}${taskId ? ` ${taskId}` : ""}) started with ${brain.kind} in slot ${opts.slotIndex}`);

    const cleanups: Cleanup[] = [];
    if (job.source === "cloud") cleanups.push(startHeartbeat(job, (m) => this.log(m)));
    let result: TaskRunResult;
    try {
      await this.waitForX(active);
      result = await this.turns.runFirst(active, job, brain, { task, isRetry }, settings, cleanups);
    } catch (err) {
      result = { outcome: "failed", reason: errText(err) };
    }
    return this.finish(active, job, result, settings, cleanups);
  }

  /** The next turn of an ended conversation, appended to its session (see run/conversation.ts). */
  private async runTurn(job: TurnJob, resolved: ResolvedBrain, settings: ExtensionSettings, opts: StartOptions): Promise<TaskRunResult> {
    const brain = resolved.brain!;
    const { from, text } = job;
    const sessionId = from.sessionId;
    let active: ActiveSession | null = null;
    let events: StampedAgentEvent[];
    let patch: Partial<SessionInfo>;
    try {
      events = await this.deps.sessions.eventsOf(sessionId);
      patch = {
        brain: brain.kind,
        jev: resolved.status.jevActive,
        startedAt: this.now().toISOString(),
        turns: (from.turns ?? 1) + 1,
        firstStartedAt: from.firstStartedAt ?? from.startedAt,
      };
      const model = modelOf(settings);
      if (model) patch.model = model;
      const info = (await this.deps.sessions.reopen(sessionId, patch)) ?? { ...from, ...patch };
      const x = isXTask(job.first) || isXTask({ instructions: text });
      active = this.live.activate(info, opts.slotIndex, x, false, null);
      active.said.push(text);
      // The last turn stopped midway: what it typed may still be in the page, and may be what gets posted.
      if (from.outcome !== "done") for (const e of lastTurnEvents(events)) active.typed.push(...typedTextsOf(e));
      if (job.task) {
        active.localTaskId = job.task.id;
        await this.deps.localStore.markStarted(job.task.id);
      }
    } catch (err) {
      if (active) this.live.deactivate(active);
      else this.live.slots.unassign(opts.slotIndex);
      opts.onSessionCreated?.();
      throw err;
    }
    // The user's message opens the turn in the thread.
    this.turns.emit(active, { type: "user_message", text });
    opts.onSessionCreated?.();
    this.changed();
    this.log(`session ${sessionId} turn ${patch.turns} with ${brain.kind} in slot ${opts.slotIndex}`);

    const cleanups: Cleanup[] = [];
    let result: TaskRunResult;
    try {
      await this.waitForX(active);
      result = await runNextTurn(this.turns, this.deps.localStore, active, job, brain, events, settings, cleanups);
    } catch (err) {
      result = { outcome: "failed", reason: errText(err) };
    }
    return this.finish(active, job, result, settings, cleanups);
  }

  /** Verification, classification, recording, cleanup and the session's end (pipeline steps 4-5). */
  private async finish(active: ActiveSession, job: Job, raw: TaskRunResult, settings: ExtensionSettings, cleanups: Cleanup[]): Promise<TaskRunResult> {
    const sessionId = active.session.sessionId;
    let result = raw;
    try {
      if (active.forced) result = { ...result, outcome: active.forced.outcome, reason: active.forced.reason };
      result = await this.turns.check(active, result);
      await this.recorder.recordTask(active, job, result, settings);
      await runCleanups(cleanups);
      await this.recorder.endSession(sessionId, result);
    } finally {
      this.live.deactivate(active);
      this.changed();
    }
    this.log(`session ${sessionId} ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  }

  /** X tasks take turns: wait (interruptible by stop) until no other X task runs. */
  private async waitForX(active: ActiveSession): Promise<void> {
    if (!active.x) return;
    const id = active.session.sessionId;
    if (this.live.xTurn.heldByOther(id)) {
      this.turns.emit(active, { type: "status", text: X_WAIT_STATUS });
      await this.live.xTurn.waitFor(id, () => active.forced !== null);
      if (active.forced) throw new Error(active.forced.reason);
      // Its turn starts now.
      const startedAt = this.now().toISOString();
      active.session = { ...active.session, startedAt };
      await this.deps.sessions.update(id, { startedAt });
    }
    this.live.xTurn.take(id);
  }

  /** Single-slot mode: the tab behind prepareTab/browser/... */
  private singleSlot(): AgentSlot {
    const d = this.deps;
    return {
      index: 0,
      prepare: async (opts) => d.prepareTab?.(opts),
      browser: d.browser ?? { call: () => Promise.reject(new Error("no browser")) },
      isAgentTab: async (tabId) => (d.isAgentTab ? d.isAgentTab(tabId) : false),
      screenshot: () => (d.screenshot ? d.screenshot() : Promise.reject(new Error("no screenshot"))),
    };
  }

  // --- keep-alive and small helpers ------------------------------------------------

  /** Something runs: keep the service worker alive. */
  private hold(): void {
    this.keepAlive.hold();
    this.changed();
  }

  private drop(): void {
    if (this.keepAlive.release()) this.stopRequested = false;
    this.changed();
  }

  private changed(): void {
    try {
      this.deps.onStateChange?.();
    } catch {
      /* UI push errors are not the runner's problem */
    }
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

/** A session title: the instructions on one line, at most 80 characters. */
function titleOf(instructions: string): string {
  const one = instructions.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}
