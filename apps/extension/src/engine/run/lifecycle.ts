/**
 * A session's lifecycle, the same for every job: open it (the task, the
 * session record, its slot), wait for the X turn, run the brain, then finish
 * (checks, recording, cleanup) and give back what it held. A new session runs
 * its first turn (runFirst); an ended conversation its next turn (runTurn).
 */
import { errorMessage, isXTask, MAX_INSTRUCTIONS_CHARS, type ExtensionSettings, type SessionInfo, type TaskRunResult } from "@browsertodo/shared";
import { lastTurnEvents } from "../../continue.js";
import type { BrainStatus } from "../../ui-protocol.js";
import type { Brain } from "../brains.js";
import type { LocalStore } from "../local-store.js";
import type { SessionStore } from "../sessions.js";
import type { ActiveSessions, ForcedStop } from "./active.js";
import { runNextTurn } from "./conversation.js";
import { openTask, startHeartbeat, type FirstJob, type Job, type TurnJob } from "./jobs.js";
import type { ResultRecorder } from "./record.js";
import { X_WAIT_STATUS } from "./scheduling.js";
import { modelOf, runCleanups, typedTextsOf, type ActiveSession, type Cleanup, type TurnRunner } from "./turn.js";

/** The brain a job runs with, and what the side panel says about it. */
export interface RunBrain {
  brain: Brain;
  status: BrainStatus;
}

export interface LaunchOptions {
  slotIndex: number;
  /** A due task run by the loop (counts toward maxParallelTasks). */
  scheduled: boolean;
  /** Called once the session exists (or failed to start). */
  onSessionCreated?: () => void;
}

/** How a session's turn ended: its recorded result, and the runner's stop when it forced one. */
export interface Ended {
  result: TaskRunResult;
  stop: ForcedStop | null;
}

export interface LifecycleDeps {
  live: ActiveSessions;
  turns: TurnRunner;
  recorder: ResultRecorder;
  sessions: SessionStore;
  localStore: LocalStore;
  now(): Date;
  log(message: string): void;
  /** Something the UI shows changed. */
  changed(): void;
}

/** A session title: the instructions on one line, at most this many characters. */
const MAX_TITLE_CHARS = 80;

/** One launch: how its session opens (registering it with activate()), and how its brain runs. */
interface Launch {
  job: Job;
  sessionId: string;
  settings: ExtensionSettings;
  opts: LaunchOptions;
  /** The local task given back if opening fails before the session is active. */
  localTaskId: string | null;
  open(activate: (info: SessionInfo, x: boolean, localTaskId: string | null) => ActiveSession): Promise<ActiveSession>;
  drive(active: ActiveSession, cleanups: Cleanup[]): Promise<TaskRunResult>;
}

export class Lifecycle {
  constructor(private readonly deps: LifecycleDeps) {}

  /** The first turn of a new session through the whole pipeline. */
  runFirst(job: FirstJob, run: RunBrain, settings: ExtensionSettings, sessionId: string, opts: LaunchOptions): Promise<Ended> {
    const { brain, status } = run;
    let opened: Awaited<ReturnType<typeof openTask>>;
    return this.launch({
      job,
      sessionId,
      settings,
      opts,
      localTaskId: job.source === "local" ? job.task.id : null,
      open: async (activate) => {
        opened = await openTask(job, sessionId, this.deps.localStore);
        const { task, taskId } = opened;
        const info: SessionInfo = {
          sessionId,
          source: job.source,
          title: titleOf(task.instructions),
          brain: brain.kind,
          jev: status.jevActive,
          startedAt: this.deps.now().toISOString(),
        };
        const model = modelOf(settings);
        if (model) info.model = model;
        if (taskId) info.taskId = taskId;
        if (job.source === "adhoc") {
          // Kept so the conversation can go on in a fresh session with its full instructions.
          info.instructions = task.instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
          if (task.account) info.account = task.account;
        }
        const active = activate(info, isXTask(task), job.source === "local" ? job.task.id : null);
        await this.deps.sessions.create(info);
        // A one-off run belongs to the tab it was started from, from the start (the side panel shows it there).
        if (job.source === "adhoc" && job.input.tabId !== undefined) await this.deps.turns.bindChat(job.input.tabId, sessionId);
        return active;
      },
      drive: (active, cleanups) => this.deps.turns.runFirst(active, job, brain, opened, settings, cleanups),
    });
  }

  /** The next turn of an ended conversation, appended to its session (see conversation.ts). */
  runTurn(job: TurnJob, run: RunBrain, settings: ExtensionSettings, opts: LaunchOptions): Promise<Ended> {
    const { brain, status } = run;
    const { from, text } = job;
    const sessionId = from.sessionId;
    let events: Awaited<ReturnType<SessionStore["eventsOf"]>>;
    return this.launch({
      job,
      sessionId,
      settings,
      opts,
      localTaskId: null,
      open: async (activate) => {
        events = await this.deps.sessions.eventsOf(sessionId);
        const patch: Partial<SessionInfo> = {
          brain: brain.kind,
          jev: status.jevActive,
          startedAt: this.deps.now().toISOString(),
          turns: (from.turns ?? 1) + 1,
          firstStartedAt: from.firstStartedAt ?? from.startedAt,
        };
        const model = modelOf(settings);
        if (model) patch.model = model;
        const info = (await this.deps.sessions.reopen(sessionId, patch)) ?? { ...from, ...patch };
        const x = isXTask(job.first) || isXTask({ instructions: text });
        const active = activate(info, x, job.task?.id ?? null);
        // The last turn stopped midway: what it typed may still be in the page, and may be what gets posted.
        if (from.outcome !== "done") for (const e of lastTurnEvents(events)) active.typed.push(...typedTextsOf(e));
        if (job.task) await this.deps.localStore.markStarted(job.task.id);
        // Sent from a tab: the conversation goes on there (bound before the turn looks up its tab).
        if (job.tabId !== undefined) await this.deps.turns.bindChat(job.tabId, sessionId);
        // The user's message opens the turn in the thread.
        this.deps.turns.emit(active, { type: "user_message", text });
        return active;
      },
      drive: (active, cleanups) => runNextTurn(this.deps.turns, this.deps.localStore, active, job, brain, events, settings, cleanups),
    });
  }

  /** open, then (once the session exists) the X turn, the brain's run and finish(). */
  private async launch(l: Launch): Promise<Ended> {
    const { live } = this.deps;
    const { job, sessionId, opts } = l;
    let active: ActiveSession | null = null;
    try {
      active = await l.open((info, x, localTaskId) => (active = live.activate(info, opts.slotIndex, x, opts.scheduled, localTaskId)));
    } catch (err) {
      // Nothing ran: give the slot (and the X turn, and the local task) back.
      if (active) live.deactivate(active);
      else live.abandon(opts.slotIndex, sessionId, l.localTaskId);
      opts.onSessionCreated?.();
      throw err;
    }
    opts.onSessionCreated?.();
    this.deps.changed();
    this.deps.log(`session ${sessionId} ${describe(job, active.session)} with ${active.session.brain} in slot ${opts.slotIndex}`);

    const cleanups: Cleanup[] = [];
    if (job.source === "cloud") cleanups.push(startHeartbeat(job, (m) => this.deps.log(m)));
    let result: TaskRunResult;
    try {
      await this.waitForX(active);
      result = await l.drive(active, cleanups);
    } catch (err) {
      result = { outcome: "failed", reason: errorMessage(err) };
    }
    return this.finish(active, job, result, l.settings, cleanups);
  }

  /** Verification, classification, recording, cleanup and the session's end (pipeline steps 4-5). */
  private async finish(active: ActiveSession, job: Job, raw: TaskRunResult, settings: ExtensionSettings, cleanups: Cleanup[]): Promise<Ended> {
    const sessionId = active.session.sessionId;
    const stop = active.forced;
    let result = stop ? { ...raw, outcome: stop.outcome, reason: stop.reason } : raw;
    try {
      result = await this.deps.turns.check(active, result);
      await this.deps.recorder.recordTask(active, job, result, settings);
      await runCleanups(cleanups);
      await this.deps.recorder.endSession(sessionId, result);
    } finally {
      this.deps.live.deactivate(active);
      this.deps.changed();
    }
    this.deps.log(`session ${sessionId} ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return { result, stop };
  }

  /** X tasks take turns: wait (interruptible by stop) until no other X task runs. */
  private async waitForX(active: ActiveSession): Promise<void> {
    if (!active.x) return;
    const { xTurn } = this.deps.live;
    const id = active.session.sessionId;
    if (xTurn.heldByOther(id)) {
      this.deps.turns.emit(active, { type: "status", text: X_WAIT_STATUS });
      await xTurn.waitFor(id, () => active.forced !== null);
      if (active.forced) throw new Error(active.forced.reason);
      // Its turn starts now.
      const startedAt = this.deps.now().toISOString();
      active.session = { ...active.session, startedAt };
      await this.deps.sessions.update(id, { startedAt });
    }
    xTurn.take(id);
  }
}

function titleOf(instructions: string): string {
  const one = instructions.replace(/\s+/g, " ").trim();
  return one.length > MAX_TITLE_CHARS ? `${one.slice(0, MAX_TITLE_CHARS - 1)}…` : one;
}

/** How the log names a launch. */
function describe(job: Job, session: SessionInfo): string {
  return job.source === "turn" ? `turn ${session.turns}` : `(${job.source}${session.taskId ? ` ${session.taskId}` : ""}) started`;
}
