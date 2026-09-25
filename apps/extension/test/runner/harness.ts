/** Shared fakes for the Runner tests: a scripted brain, a harness around a Runner, agent slots. */
import { afterEach, beforeEach, expect, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentEvent, type ClaimResponse, type ExtensionSettings, type ResultInput, type TaskRunResult } from "@browsertodo/shared";
import { installChromeFake, type ChromeFake } from "../chrome-fake.js";
import type { AgentSlot, SlotPool } from "../../src/agent-slots.js";
import { SessionEndedError, type Brain, type BrainContinueOptions, type BrainRun, type BrainStartOptions } from "../../src/engine/brains.js";
import { MemoryKvDb } from "../../src/engine/kv.js";
import { LocalStore } from "../../src/engine/local-store.js";
import type { MediaSource } from "../../src/engine/media-files.js";
import { Runner, type RunnerDeps } from "../../src/engine/runner.js";
import { SessionStore } from "../../src/engine/sessions.js";
import type { BrainStatus } from "../../src/ui-protocol.js";

/** The chrome fake and the fake clock of the current test (reset before each test by setupRunnerTests). */
export const env = { chrome: null as unknown as ChromeFake, clock: 0 };

export function setupRunnerTests(): void {
  beforeEach(() => {
    env.chrome = installChromeFake();
    env.clock = Date.parse("2026-09-24T10:00:00Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

type Script = (opts: BrainStartOptions, ctl: RunCtl) => Promise<TaskRunResult> | TaskRunResult | "hang";

interface RunCtl {
  aborts: { reason: string; outcome: string }[];
  said: string[];
  resolve(r: TaskRunResult): void;
}

type ContinueScript = (opts: BrainContinueOptions, ctl: RunCtl) => Promise<TaskRunResult> | TaskRunResult | "hang" | "ended";

/**
 * A brain whose sessions stay open after a turn, like the real ones: continue()
 * runs continueScript in them; a session that is not open (or "ended") fails
 * with SessionEndedError. Claude Code's sessions end when a turn is aborted.
 */
export class FakeBrain implements Brain {
  readonly starts: BrainStartOptions[] = [];
  readonly continues: BrainContinueOptions[] = [];
  readonly ctls: RunCtl[] = [];
  readonly open = new Set<string>();
  readonly ended: string[] = [];
  script: Script = () => ({ outcome: "done", summary: "ok" });
  continueScript: ContinueScript = () => ({ outcome: "done", summary: "continued" });
  /** Result used when a hanging run is aborted. */
  onAbort: (reason: string, outcome: string) => TaskRunResult = (reason) => ({ outcome: "failed", reason: `aborted: ${reason}` });
  constructor(readonly kind: "claude-code" | "claude-api" = "claude-api") {}

  start(opts: BrainStartOptions): BrainRun {
    this.starts.push(opts);
    this.open.add(opts.sessionId);
    return this.runOf(opts, (ctl) => this.script(opts, ctl));
  }

  continue(opts: BrainContinueOptions): BrainRun {
    this.continues.push(opts);
    if (!this.open.has(opts.sessionId)) return this.runOf(opts, () => "ended");
    return this.runOf(opts, (ctl) => this.continueScript(opts, ctl));
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  async end(sessionId: string): Promise<void> {
    this.ended.push(sessionId);
    this.open.delete(sessionId);
  }

  private runOf(
    opts: { sessionId: string; onEvent(e: AgentEvent): void },
    script: (ctl: RunCtl) => Promise<TaskRunResult> | TaskRunResult | "hang" | "ended",
  ): BrainRun {
    let resolve!: (r: TaskRunResult) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<TaskRunResult>((r, j) => ((resolve = r), (reject = j)));
    const ctl: RunCtl = { aborts: [], said: [], resolve };
    this.ctls.push(ctl);
    void Promise.resolve(script(ctl)).then((r) => {
      if (r === "ended") {
        this.open.delete(opts.sessionId);
        reject(new SessionEndedError());
      } else if (r !== "hang") resolve(r);
    });
    return {
      done,
      sendUserMessage: async (text) => {
        ctl.said.push(text);
        opts.onEvent({ type: "user_message", text });
        return true;
      },
      abort: (reason, outcome) => {
        ctl.aborts.push({ reason, outcome });
        // Stopping Claude Code kills its process; the API history survives.
        if (this.kind === "claude-code") this.open.delete(opts.sessionId);
        resolve(this.onAbort(reason, outcome));
      },
    };
  }
}

export const status = (effective: BrainStatus["effective"], extra: Partial<BrainStatus> = {}): BrainStatus => ({
  effective,
  helper: null,
  hasApiKey: true,
  jevActive: false,
  ...extra,
});

export interface Harness {
  runner: Runner;
  deps: RunnerDeps;
  brain: FakeBrain;
  store: LocalStore;
  sessions: SessionStore;
  settings: ExtensionSettings;
  notifications: { title: string; message: string }[];
  sleeps: number[];
  materialized: { sessionId: string; sources: MediaSource[] }[];
  cleanups: number;
  results: { taskId: string; body: ResultInput }[];
  claims: (ClaimResponse | null)[];
  uploads: string[];
  verify: ReturnType<typeof vi.fn>;
  noBrain: boolean;
  prepared: Parameters<NonNullable<RunnerDeps["prepareTab"]>>[0][];
}

export function harness(overrides: Partial<ExtensionSettings> = {}): Harness {
  const db = new MemoryKvDb();
  let n = 0;
  const now = () => new Date(env.clock);
  const store = new LocalStore({ db, now, newId: () => `t${++n}` });
  const sessions = new SessionStore(db, { now });
  const brain = new FakeBrain();
  const h = {
    brain,
    store,
    sessions,
    settings: { ...DEFAULT_SETTINGS, delayMinSec: 1, delayMaxSec: 2, ...overrides },
    notifications: [],
    sleeps: [],
    materialized: [],
    cleanups: 0,
    results: [],
    claims: [],
    uploads: [],
    verify: vi.fn(async () => ({ ok: true, detail: "found" })),
    noBrain: false,
    prepared: [],
  } as unknown as Harness;
  let sid = 0;
  h.deps = {
    loadSettings: async () => ({ ...h.settings }),
    saveSettings: async (patch) => {
      h.settings = { ...h.settings, ...patch };
      return h.settings;
    },
    getRunnerId: async () => "runner-1",
    createApi: () => ({
      claim: async () => h.claims.shift() ?? null,
      heartbeat: async () => ({}),
      result: async (taskId, body) => {
        h.results.push({ taskId, body });
      },
      uploadMedia: async (_blob, filename) => {
        h.uploads.push(filename);
        return { id: `shot-${h.uploads.length}`, filename, contentType: "image/jpeg", size: 1 };
      },
      mediaUrl: (id) => `https://api.test/v1/media/${id}`,
      authHeaders: () => [{ name: "Authorization", value: "Bearer bt_k" }],
    }),
    localStore: store,
    sessions,
    media: {
      materialize: async (sessionId, sources) => {
        h.materialized.push({ sessionId, sources });
        return { paths: sources.map((s) => `C:\\dl\\${s.name}`), cleanup: async () => void h.cleanups++ };
      },
    },
    resolveBrain: async () => (h.noBrain ? { brain: null, status: status(null, { note: "No brain available: set a key" }) } : { brain: h.brain, status: status(h.brain.kind) }),
    core: {
      verifyXPost: h.verify as never,
      classifyFailure: (reason: string) => (/limit|network|timeout/i.test(reason) ? "transient" : "permanent"),
    },
    browser: { call: async () => ({}) as never },
    prepareTab: async (opts) => void h.prepared.push(opts),
    isAgentTab: async (tabId) => tabId === 7,
    screenshot: async () => ({ base64: btoa("JPG"), mimeType: "image/jpeg" }),
    notify: (title, message) => void h.notifications.push({ title, message }),
    keepAlive: () => env.chrome.runtime.getPlatformInfo(),
    sleep: async (ms) => void h.sleeps.push(ms),
    now,
    newId: () => `s${++sid}`,
  };
  h.runner = new Runner(h.deps);
  return h;
}

export async function runAll(h: Harness, trigger: "alarm" | "manual" = "manual") {
  const r = await h.runner.runDue(trigger);
  await h.runner.idle();
  await h.sessions.flush();
  return r;
}

/** Agent slots for parallel runs: slot i's main tab is 100 + i. */
export class FakePool implements SlotPool {
  readonly slots = new Map<number, AgentSlot>();
  readonly log: string[] = [];
  readonly owner = new Map<number, string>();
  /** The tab a prepare picks: the tab asked for, else the slot's own (100 + index). */
  pick: (index: number, opts: { tabId?: number }) => number = (index, opts) => opts.tabId ?? 100 + index;
  take(index: number, sessionId: string): AgentSlot {
    if (this.owner.has(index)) throw new Error(`slot ${index} is already used by ${this.owner.get(index)}`);
    this.owner.set(index, sessionId);
    this.log.push(`take ${index} ${sessionId}`);
    const known = this.slots.get(index);
    if (known) return known;
    {
      const s: AgentSlot = {
        index,
        prepare: async (opts) => {
          this.log.push(`prepare ${index} ${opts.mode}${opts.tabId !== undefined ? ` tab ${opts.tabId}` : ""}`);
          return this.pick(index, opts);
        },
        browser: { call: vi.fn(async () => ({})) as never },
        isAgentTab: async (tabId) => tabId === 100 + index,
        screenshot: async () => ({ base64: btoa("JPG"), mimeType: "image/jpeg" }),
      };
      this.slots.set(index, s);
      return s;
    }
  }
  release(index: number, sessionId: string): void {
    if (this.owner.get(index) === sessionId) this.owner.delete(index);
    this.log.push(`release ${index} ${sessionId}`);
  }
}

/** A harness with agent slots; the brain hangs until each run is resolved by the test. */
export function parallel(overrides: Partial<ExtensionSettings> = {}) {
  const h = harness({ maxParallelTasks: 2, ...overrides });
  const pool = new FakePool();
  h.deps.slots = pool;
  delete h.deps.prepareTab;
  h.runner = new Runner(h.deps);
  const live = new Set<string>();
  const overlaps: string[][] = [];
  h.brain.script = (o, ctl) => {
    live.add(o.task.id);
    overlaps.push([...live].sort());
    const resolve = ctl.resolve;
    ctl.resolve = (r) => {
      live.delete(o.task.id);
      resolve(r);
    };
    return "hang";
  };
  const startsOf = () => h.brain.starts.map((s) => s.task.id);
  /** Resolves the run of task `id` (and waits for the runner to take it in). */
  const finishTask = async (id: string, r: TaskRunResult = { outcome: "done" }) => {
    const i = h.brain.starts.findIndex((s) => s.task.id === id);
    h.brain.ctls[i]!.resolve(r);
    await vi.waitFor(async () => expect((await h.store.get(id))?.status).not.toBe("running"));
  };
  return { h, pool, live, overlaps, startsOf, finishTask };
}
