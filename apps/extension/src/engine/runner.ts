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
 * The Runner is the public API; the work lives in run/: due-loop.ts (the
 * due loop), failure-policy.ts (failures in a row, pausing), lifecycle.ts
 * (a session from open to finish), jobs.ts (where work comes from),
 * scheduling.ts (slots, X turn, pacing), active.ts (the running sessions,
 * what they hold, stopping them), turn.ts (a session's first turn, the brain
 * run and its checks), conversation.ts (next turns), record.ts (results),
 * state.ts (persisted state, keep-alive), deadline.ts (how long a run may take).
 */
import { errorMessage, pauseReasonForUrl, SCREEN_HELP_TEXT, type ExtensionSettings, type SessionInfo, type Sleep } from "@browsertodo/shared";
import type { SlotPool } from "../agent-slots.js";
import { callSafely } from "../listeners.js";
import type { TabChatsLike } from "../tab-chats.js";
import type { BrainStatus, MessageMode } from "../ui-protocol.js";
import { NO_AI } from "./brain-resolver.js";
import type { Brain, CoreApi } from "./brains.js";
import type { StorageLike } from "./kv.js";
import type { LocalStore } from "./local-store.js";
import type { MaterializedMedia, MediaSource } from "./media-files.js";
import type { SessionStore } from "./sessions.js";
import { ActiveSessions, pauseUrlStop, stopOf } from "./run/active.js";
import { CONTINUE_TEXT, continueRefusal } from "./run/conversation.js";
import { DueLoop } from "./run/due-loop.js";
import { FailurePolicy } from "./run/failure-policy.js";
import { turnJob, type AdhocInput, type AdhocJob, type RunnerApi, type TurnJob } from "./run/jobs.js";
import { Lifecycle, type RunBrain } from "./run/lifecycle.js";
import { ResultRecorder } from "./run/record.js";
import { KeepAlive, RunnerStateStore, type RunnerState } from "./run/state.js";
import { TurnRunner } from "./run/turn.js";

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
  /**
   * The signed-in account's task queue (claim/heartbeat/result with the
   * session token), or null when signed out. When there is one it replaces
   * the runner-key cloud sync.
   */
  accountApi?(): Promise<RunnerApi | null>;
  localStore: LocalStore;
  sessions: SessionStore;
  /** A browser tab's address and title (no tabId: the tab the user is looking at); see TurnDeps.pageOf. */
  pageOf?(tabId?: number): Promise<{ url: string; title: string } | null>;
  media: { materialize(sessionId: string, sources: MediaSource[]): Promise<MaterializedMedia> };
  /** Resolves the brain for these settings; may (re)connect the helper. */
  resolveBrain(settings: ExtensionSettings): Promise<ResolvedBrain>;
  core: Pick<CoreApi, "verifyXPost" | "classifyFailure">;
  /** Agent slots: each running session gets its own tab. */
  slots: SlotPool;
  /**
   * Which browser tab each conversation belongs to (TabChats). A one-off run
   * started from a tab is bound to it, and a conversation's next turns act there.
   */
  tabChats?: TabChatsLike;
  notify(title: string, message: string): void | Promise<void>;
  /** Called every KEEP_ALIVE_MS while busy (chrome.runtime.getPlatformInfo). */
  keepAlive(): unknown;
  /** Something the UI shows changed (running sessions, pause, errors). */
  onStateChange?(): void;
  storage?: StorageLike;
  sleep?: Sleep;
  now?(): Date;
  newId?(): string;
  log?(message: string): void;
}

export class Runner {
  /** Sessions running right now, and the slots, X turn and local tasks they hold. */
  private readonly live: ActiveSessions;
  /** Every job in flight (the due loop's and one-off ones). */
  private readonly jobs = new Set<Promise<unknown>>();
  /** Conversations whose next turn is starting. */
  private readonly startingTurns = new Set<string>();
  private reservations = 0;
  private readonly keepAlive: KeepAlive;
  private readonly runnerState: RunnerStateStore;
  private readonly turns: TurnRunner;
  private readonly lifecycle: Lifecycle;
  private readonly policy: FailurePolicy;
  private readonly dueLoop: DueLoop;

  constructor(private readonly deps: RunnerDeps) {
    const log = (m: string) => this.log(m);
    const now = () => this.now();
    const changed = () => this.changed();
    this.live = new ActiveSessions(deps.slots);
    this.keepAlive = new KeepAlive(() => deps.keepAlive());
    this.runnerState = new RunnerStateStore(() => deps.storage ?? chrome.storage.local);
    this.turns = new TurnRunner({
      sessions: deps.sessions,
      localStore: deps.localStore,
      media: deps.media,
      core: deps.core,
      log,
      ...(deps.tabChats ? { tabChats: deps.tabChats } : {}),
      ...(deps.pageOf ? { pageOf: deps.pageOf } : {}),
    });
    const recorder = new ResultRecorder({
      localStore: deps.localStore,
      sessions: deps.sessions,
      patchState: (p) => this.runnerState.patch(p),
      now,
      log,
    });
    this.lifecycle = new Lifecycle({
      live: this.live,
      turns: this.turns,
      recorder,
      sessions: deps.sessions,
      localStore: deps.localStore,
      now,
      log,
      changed,
    });
    this.policy = new FailurePolicy({
      state: this.runnerState,
      loadSettings: deps.loadSettings,
      saveSettings: deps.saveSettings,
      notify: deps.notify,
      stopping: () => this.dueLoop.stopping,
    });
    this.dueLoop = new DueLoop({
      live: this.live,
      lifecycle: this.lifecycle,
      policy: this.policy,
      state: this.runnerState,
      localStore: deps.localStore,
      loadSettings: deps.loadSettings,
      getRunnerId: deps.getRunnerId,
      createApi: deps.createApi,
      ...(deps.accountApi ? { accountApi: deps.accountApi } : {}),
      resolveBrain: deps.resolveBrain,
      notify: deps.notify,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      now,
      newId: () => this.newId(),
      log,
      changed,
      hold: () => this.hold(),
      drop: () => this.drop(),
      track: (job) => this.track(job),
    });
  }

  get busy(): boolean {
    return this.dueLoop.current !== null || this.jobs.size > 0 || this.keepAlive.held;
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
    while (this.dueLoop.current || this.jobs.size) {
      await Promise.allSettled([this.dueLoop.current, ...this.jobs]);
    }
  }

  state(): Promise<RunnerState> {
    return this.runnerState.get();
  }

  /** Runs everything due now: local tasks, then cloud claims, several at once. Returns at once. */
  runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }> {
    return this.dueLoop.start(trigger);
  }

  /** Starts a one-off task now: a new conversation. Resolves once its session exists. */
  async runAdhoc(input: AdhocInput): Promise<{ sessionId: string }> {
    if (!input.instructions?.trim() && !input.screen) throw new Error("Instructions are empty");
    return this.startOne(null, async () => ({ source: "adhoc", input }));
  }

  /**
   * The user's message in a conversation (the side panel's box).
   * - The conversation's turn is running: typed into it ("inject").
   * - It ended: the next turn ("turn"; see run/conversation.ts).
   * - No conversation: a new one-off conversation ("new"), in tabId when given.
   * tabId: the browser tab the message was sent from; once it is taken, the conversation belongs to that tab.
   * screen: an empty message in Chat, "look at the page and do what is
   * needed" (SCREEN_HELP_TEXT): a new conversation starts with it, an ended
   * one goes on with "look at the page now and continue". A running turn is
   * already looking: it takes typed messages only.
   */
  async message(
    sessionId: string | null | undefined,
    text: string,
    opts: { tabId?: number; screen?: boolean } = {},
  ): Promise<{ sessionId: string; mode: MessageMode }> {
    const screen = !!opts.screen && !text.trim();
    const t = screen ? SCREEN_HELP_TEXT : text.trim();
    if (!t) throw new Error("The message is empty");
    const tab = opts.tabId === undefined ? {} : { tabId: opts.tabId };
    if (!sessionId) {
      const input: AdhocInput = { instructions: t, ...tab, ...(screen ? { screen } : {}) };
      return { ...(await this.runAdhoc(input)), mode: "new" };
    }
    if (this.live.has(sessionId)) {
      if (screen) throw new Error("The agent is working on this page already; type a message, or Stop it first");
      if (!(await this.say(t, sessionId))) throw new Error("The agent did not take the message");
      if (opts.tabId !== undefined) await this.turns.bindChat(opts.tabId, sessionId);
      return { sessionId, mode: "inject" };
    }
    if (this.startingTurns.has(sessionId)) throw new Error("That conversation is already starting its next turn");
    this.startingTurns.add(sessionId);
    try {
      await this.startOne(sessionId, () => turnJob(this.deps, sessionId, t, { screen, ...tab }));
    } finally {
      this.startingTurns.delete(sessionId);
    }
    return { sessionId, mode: "turn" };
  }

  /**
   * "Continue" for a run that ended paused, failed or retry (e.g. stopped by
   * the user): the next turn of that conversation, with the note as the
   * user's message (or CONTINUE_TEXT). Cloud runs continue from the server's
   * queue instead. tabId: continued from that browser tab (see message()).
   */
  async continueSession(sessionId: string, note?: string, opts: { tabId?: number } = {}): Promise<{ sessionId: string }> {
    const from = await this.deps.sessions.get(sessionId);
    const refusal = continueRefusal(from, sessionId, this.live.has(sessionId));
    if (refusal) throw new Error(refusal);
    const { sessionId: id } = await this.message(sessionId, note?.trim() || CONTINUE_TEXT, opts);
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
      this.log(`ending the agent session of ${sessionId} failed: ${errorMessage(err)}`);
    }
    return { ok: true };
  }

  /** Stops a session (it ends paused): the one given, or every running session and the due loop. */
  stop(sessionId?: string): boolean {
    if (sessionId) {
      const a = this.live.get(sessionId);
      if (!a) return false;
      this.live.force(a, stopOf("user-stop"));
      return true;
    }
    if (!this.busy) return false;
    this.dueLoop.stop();
    this.live.forceAll(stopOf("user-stop"));
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
    await this.policy.pause(reason);
    this.changed();
  }

  async resumeSchedule(): Promise<void> {
    await this.policy.resume();
    this.changed();
  }

  /** Startup crash recovery for local tasks. */
  async recover(): Promise<number> {
    const settings = await this.deps.loadSettings();
    const n = await this.deps.localStore.recoverCrashed(settings.maxTaskMinutes, this.live.localRunning);
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
      // It may have ended or been stopped while the tab was checked.
      if (a.forced || this.live.get(a.session.sessionId) !== a) continue;
      this.turns.emit(a, { type: "status", text: `Pausing: ${reason}` });
      this.live.force(a, pauseUrlStop(reason));
    }
  }

  /** The browser tab of a conversation was closed: its running turn stops (paused), the session stays in the Activity Log. */
  onChatTabClosed(sessionId: string): boolean {
    const a = this.live.get(sessionId);
    if (!a || a.forced) return false;
    this.turns.emit(a, { type: "status", text: "Stopping: the tab was closed" });
    this.live.force(a, stopOf("tab-closed"));
    return true;
  }

  /** The user closed the debugger infobar (it ends debugging of every tab): stop every session. */
  onDebuggerCanceled(): void {
    this.live.forceAll(stopOf("debugger-canceled"));
  }

  /**
   * Runs one job now, beside whatever else runs (not the due loop). Resolves
   * once its session exists (or is reopened). conversation: the session whose
   * next turn this is (it prefers the slot it used).
   */
  private async startOne(conversation: string | null, makeJob: () => Promise<AdhocJob | TurnJob>): Promise<{ sessionId: string }> {
    const { slots } = this.live;
    // Reserved before anything async, so two quick starts never share a slot.
    const reservation = `starting:${++this.reservations}`;
    const slotIndex = slots.reserve(reservation, conversation === null ? undefined : slots.lastOf(conversation));
    if (slotIndex === null) {
      throw new Error(slots.count === 1 ? "A task is already running. Stop it or wait for it to finish." : `${this.live.size} tasks are running. Stop one or wait for one to finish.`);
    }
    this.hold();
    let settings: ExtensionSettings;
    let run: RunBrain;
    let job: AdhocJob | TurnJob;
    try {
      job = await makeJob();
      settings = await this.deps.loadSettings();
      const { brain, status } = await this.deps.resolveBrain(settings);
      if (!brain) throw new Error(status.note ?? NO_AI);
      run = { brain, status };
    } catch (err) {
      slots.unassign(slotIndex);
      this.drop();
      throw err;
    }
    const sessionId = job.source === "turn" ? job.from.sessionId : this.newId();
    slots.assign(slotIndex, sessionId);
    let created!: () => void;
    const sessionReady = new Promise<void>((r) => (created = r));
    const opts = { slotIndex, scheduled: false, onSessionCreated: created };
    const ended = job.source === "turn" ? this.lifecycle.runTurn(job, run, settings, opts) : this.lifecycle.runFirst(job, run, settings, sessionId, opts);
    const source = job.source;
    void this.track(ended.catch((err) => this.log(`${source} run failed: ${errorMessage(err)}`))).finally(created);
    await sessionReady;
    return { sessionId };
  }

  /** A job in flight: idle() waits for it; when it settles it gives back the hold taken for it. */
  private track<T>(job: Promise<T>): Promise<T | void> {
    const tracked: Promise<T | void> = job.finally(() => {
      this.jobs.delete(tracked);
      this.drop();
    });
    this.jobs.add(tracked);
    return tracked;
  }

  /** Something runs: keep the service worker alive. */
  private hold(): void {
    this.keepAlive.hold();
    this.changed();
  }

  private drop(): void {
    this.keepAlive.release();
    this.changed();
  }

  private changed(): void {
    callSafely(this.deps.onStateChange);
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
