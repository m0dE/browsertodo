import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type ClaimResponse,
  type ExtensionSettings,
  type ResultInput,
  type TaskRunResult,
} from "@browsertodo/shared";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { claimFixture } from "./fixtures.js";
import type { Brain, BrainRun, BrainStartOptions } from "../src/engine/brains.js";
import { MemoryKvDb } from "../src/engine/kv.js";
import { LocalStore } from "../src/engine/local-store.js";
import type { MediaSource } from "../src/engine/media-files.js";
import { KEEP_ALIVE_MS, Runner, typedTextsOf, type RunnerDeps } from "../src/engine/runner.js";
import { SessionStore } from "../src/engine/sessions.js";
import type { BrainStatus } from "../src/ui-protocol.js";

type Script = (opts: BrainStartOptions, ctl: RunCtl) => Promise<TaskRunResult> | TaskRunResult | "hang";

interface RunCtl {
  aborts: { reason: string; outcome: string }[];
  said: string[];
  resolve(r: TaskRunResult): void;
}

class FakeBrain implements Brain {
  readonly starts: BrainStartOptions[] = [];
  readonly ctls: RunCtl[] = [];
  script: Script = () => ({ outcome: "done", summary: "ok" });
  /** Result used when a hanging run is aborted. */
  onAbort: (reason: string, outcome: string) => TaskRunResult = (reason) => ({ outcome: "failed", reason: `aborted: ${reason}` });
  constructor(readonly kind: "claude-code" | "claude-api" = "claude-api") {}

  start(opts: BrainStartOptions): BrainRun {
    this.starts.push(opts);
    let resolve!: (r: TaskRunResult) => void;
    const done = new Promise<TaskRunResult>((r) => (resolve = r));
    const ctl: RunCtl = { aborts: [], said: [], resolve };
    this.ctls.push(ctl);
    void Promise.resolve(this.script(opts, ctl)).then((r) => {
      if (r !== "hang") resolve(r);
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
        resolve(this.onAbort(reason, outcome));
      },
    };
  }
}

const status = (effective: BrainStatus["effective"], extra: Partial<BrainStatus> = {}): BrainStatus => ({
  effective,
  helper: null,
  hasApiKey: true,
  jevActive: false,
  ...extra,
});

interface Harness {
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
  prepared: Parameters<RunnerDeps["prepareTab"]>[0][];
}

let chrome: ChromeFake;
let clock: number;

function harness(overrides: Partial<ExtensionSettings> = {}): Harness {
  const db = new MemoryKvDb();
  let n = 0;
  const now = () => new Date(clock);
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
    resolveBrain: async () => (h.noBrain ? { brain: null, status: status(null, { note: "No brain available: set a key" }) } : { brain, status: status("claude-api") }),
    core: {
      verifyXPost: h.verify as never,
      classifyFailure: (reason: string) => (/limit|network|timeout/i.test(reason) ? "transient" : "permanent"),
    },
    browser: { call: async () => ({}) as never },
    prepareTab: async (opts) => void h.prepared.push(opts),
    isAgentTab: async (tabId) => tabId === 7,
    screenshot: async () => ({ base64: btoa("JPG"), mimeType: "image/jpeg" }),
    notify: (title, message) => void h.notifications.push({ title, message }),
    keepAlive: () => chrome.runtime.getPlatformInfo(),
    sleep: async (ms) => void h.sleeps.push(ms),
    now,
    newId: () => `s${++sid}`,
  };
  h.runner = new Runner(h.deps);
  return h;
}

async function runAll(h: Harness, trigger: "alarm" | "manual" = "manual") {
  const r = await h.runner.runDue(trigger);
  await h.runner.idle();
  await h.sessions.flush();
  return r;
}

beforeEach(() => {
  chrome = installChromeFake();
  clock = Date.parse("2026-09-24T10:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Runner: local tasks", () => {
  it("runs a due local task: crash marker first, media paths, done recorded, session stored", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "Post hello", account: "@me", media: [{ name: "a.png", type: "image/png", dataBase64: btoa("A") }] });
    h.brain.script = async (opts) => {
      // The crash marker is persisted before the brain starts.
      expect(await h.store.get(t.id)).toMatchObject({ status: "running", attempts: 1 });
      opts.onEvent({ type: "assistant_text", text: "working" });
      opts.onEvent({ type: "task_end", outcome: "done", summary: "brain's own" });
      return { outcome: "done", summary: "posted" };
    };
    expect(await runAll(h)).toEqual({ started: true });

    const start = h.brain.starts[0]!;
    expect(start.task).toEqual({ id: t.id, instructions: "Post hello", account: "@me" });
    expect(start.mediaPaths).toEqual(["C:\\dl\\a.png"]);
    // Scheduled runs use the agent's own tab, in the background.
    expect(h.prepared).toEqual([{ show: false, mode: "own-tab" }]);
    expect(start.config).toMatchObject({ isRetry: false, maxToolCalls: 60, jevEnabled: true, model: "claude-sonnet-5" });
    expect(h.materialized[0]!.sources[0]).toMatchObject({ kind: "blob", name: "a.png" });
    expect(h.cleanups).toBe(1);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", resultSummary: "posted" });

    const [session] = await h.sessions.list();
    expect(session).toMatchObject({ source: "local", taskId: t.id, brain: "claude-api", outcome: "done", summary: "posted" });
    const events = await h.sessions.eventsOf(session!.sessionId);
    // The brain's task_end is replaced by the runner's single final one.
    expect(events.filter((e) => e.type === "task_end")).toEqual([expect.objectContaining({ outcome: "done", summary: "posted" })]);
    expect(events.map((e) => e.type)).toEqual(["status", "assistant_text", "task_end"]);
    expect(h.runner.busy).toBe(false);
    expect(h.runner.running).toBeNull();
    expect((await h.runner.state()).lastRunAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("permanent failure is recorded as failed", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "failed", reason: "button not found" });
    await runAll(h);
    expect(await h.store.get(t.id)).toMatchObject({ status: "failed", failReason: "button not found" });
  });

  it("a transient failure becomes retry with retryAfterMinutes", async () => {
    const h = harness({ retryAfterMinutes: 7 });
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "failed", reason: "usage limit reached" });
    await runAll(h);
    expect(await h.store.get(t.id)).toMatchObject({
      status: "pending",
      failReason: "usage limit reached",
      retryAfter: new Date(clock + 7 * 60_000).toISOString(),
    });
    const [s] = await h.sessions.list();
    expect(s!.outcome).toBe("retry");
  });

  it("a second attempt runs with isRetry", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    h.brain.script = () => ({ outcome: "retry", reason: "network" });
    await runAll(h);
    clock += 11 * 60_000;
    h.brain.script = () => ({ outcome: "done" });
    await runAll(h);
    expect(h.brain.starts.map((s) => s.config.isRetry)).toEqual([false, true]);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("pauses the session when the agent tab hits a login URL", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "x" });
    await h.store.add({ instructions: "second" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    await h.runner.onTabUpdated(99, { url: "https://x.com/i/flow/login" }); // not the agent tab
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    await h.runner.onTabUpdated(7, { url: "https://x.com/i/flow/login" });
    await h.runner.idle();
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: "X is asking to log in", outcome: "paused" }]);
    expect(await h.store.get(t.id)).toMatchObject({ status: "paused", pauseReason: "X is asking to log in" });
    expect(h.notifications).toEqual([{ title: "Task paused", message: "X is asking to log in" }]);
    // The run stops after a pause: the second task was not started.
    expect(h.brain.starts).toHaveLength(1);
  });

  it("verifies X posts: verified stays done, unverified becomes retry", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "Post on X from @me. Post: hello world, this is the post body" });
    h.brain.script = (opts) => {
      // What the agent typed is what must be on the post page, not the instructions.
      opts.onEvent({ type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "open composer" }, { goal: "type", text: "hi" }] } });
      opts.onEvent({ type: "tool_call", id: "2", name: "mcp__browsertodo__type", args: { index: 3, text: "hello world, this is the post body" } });
      return { outcome: "done", url: "https://x.com/me/status/123" };
    };
    await runAll(h);
    expect(h.verify).toHaveBeenCalledWith(h.deps.browser, "https://x.com/me/status/123", "hello world, this is the post body");
    expect(await h.store.get(a.id)).toMatchObject({ status: "done" });

    h.brain.script = () => ({ outcome: "done", url: "https://x.com/me/status/123" });
    const b = await h.store.add({ instructions: "Post: second" });
    h.verify.mockResolvedValueOnce({ ok: false, detail: "text not found" });
    await runAll(h);
    expect(await h.store.get(b.id)).toMatchObject({ status: "pending", failReason: "could not verify the post: text not found" });

    // Non-X URLs are not verified.
    h.verify.mockClear();
    await h.store.add({ instructions: "other" });
    h.brain.script = () => ({ outcome: "done", url: "https://example.com/done" });
    await runAll(h);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("pauses scheduled runs after maxConsecutiveFailures failed tasks in a row", async () => {
    const h = harness({ maxConsecutiveFailures: 2 });
    await h.store.add({ instructions: "a" });
    clock += 1;
    await h.store.add({ instructions: "b" });
    clock += 1;
    const c = await h.store.add({ instructions: "c" });
    h.brain.script = () => ({ outcome: "failed", reason: "button not found" });
    await runAll(h);
    expect(h.brain.starts).toHaveLength(2);
    expect(h.settings.paused).toBe(true);
    const st = await h.runner.state();
    expect(st.pausedReason).toMatch(/Paused after 2 failed tasks in a row. Last: button not found/);
    expect(h.notifications.map((n) => n.title)).toEqual(["Runs paused"]);
    expect(await h.store.get(c.id)).toMatchObject({ status: "pending" });
    // Alarm runs are skipped while paused.
    expect(await h.runner.runDue("alarm")).toEqual({ started: false, detail: "Scheduled runs are paused" });
    // Resume clears the reason and the counter.
    await h.runner.resumeSchedule();
    expect(h.settings.paused).toBe(false);
    expect(await h.runner.state()).toMatchObject({ consecutiveFailures: 0 });
    expect((await h.runner.state()).pausedReason).toBeUndefined();
  });

  it("a done resets the consecutive failure counter", async () => {
    const h = harness({ maxConsecutiveFailures: 2 });
    for (const x of ["a", "b", "c"]) {
      await h.store.add({ instructions: x });
      clock += 1;
    }
    const outcomes: TaskRunResult[] = [{ outcome: "failed", reason: "x" }, { outcome: "done" }, { outcome: "failed", reason: "y" }];
    h.brain.script = () => outcomes.shift()!;
    await runAll(h);
    expect(h.brain.starts).toHaveLength(3);
    expect(h.settings.paused).toBe(false);
    expect((await h.runner.state()).consecutiveFailures).toBe(1);
  });

  it("recovers a crashed running task and runs it again with isRetry", async () => {
    const h = harness({ maxTaskMinutes: 10 });
    const t = await h.store.add({ instructions: "x" });
    await h.store.markStarted(t.id); // attempt 1 "crashed"
    clock += 13 * 60_000;
    expect(await h.runner.recover()).toBe(1);
    await runAll(h);
    expect(h.brain.starts[0]!.config.isRetry).toBe(true);
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2, crashed: false });
  });

  it("paces between tasks but not after the last one", async () => {
    const h = harness({ delayMinSec: 5, delayMaxSec: 5 });
    await h.store.add({ instructions: "a" });
    clock += 1;
    await h.store.add({ instructions: "b" });
    await runAll(h);
    expect(h.brain.starts).toHaveLength(2);
    expect(h.sleeps).toEqual([5000]);
  });

  it("no usable brain: stops, sets lastError, notifies once", async () => {
    const h = harness();
    h.noBrain = true;
    await h.store.add({ instructions: "a" });
    await runAll(h);
    await runAll(h);
    expect(h.brain.starts).toHaveLength(0);
    expect((await h.runner.state()).lastError).toBe("No brain available: set a key");
    expect(h.notifications).toEqual([{ title: "Cannot run tasks", message: "No brain available: set a key" }]);
  });

  it("stop() ends the session as paused and ends the run", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    await h.store.add({ instructions: "b" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(h.runner.stop()).toBe(true);
    await h.runner.idle();
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: "stopped by user", outcome: "paused" }]);
    expect(await h.store.get(a.id)).toMatchObject({ status: "paused", pauseReason: "stopped by user" });
    expect(h.brain.starts).toHaveLength(1);
    expect(h.runner.stop()).toBe(false);
  });

  it("the debugger infobar Cancel fails the session", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    h.runner.onDebuggerCanceled();
    await h.runner.idle();
    expect(await h.store.get(a.id)).toMatchObject({ status: "failed", failReason: "debugger detached by user" });
  });

  it("refuses a second run while one is active", async () => {
    const h = harness();
    await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(await h.runner.runDue("manual")).toEqual({ started: false, detail: "A task is already running" });
    await expect(h.runner.runAdhoc({ instructions: "x" })).rejects.toThrow(/already running/);
    h.runner.stop();
    await h.runner.idle();
  });

  it("an alarm that fires during a run triggers one more due check afterwards", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k" });
    await h.store.add({ instructions: "a" });
    // The first claim (end of the first run) finds nothing; the task shows up later.
    h.claims.push(null, claimFixture("late"));
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect((await h.runner.runDue("alarm")).started).toBe(false);
    h.brain.script = () => ({ outcome: "done" });
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await vi.waitFor(() => expect(h.brain.starts.map((s) => s.task.id)).toEqual(["t1", "late"]));
    await h.runner.idle();
  });

  it("keeps the service worker alive every 20 s while busy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = harness();
    await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(chrome.runtime.platformInfoCalls).toBe(3);
    h.runner.stop();
    await h.runner.idle();
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(chrome.runtime.platformInfoCalls).toBe(3);
  });

  it("a preparation error (e.g. media) is recorded without starting the brain", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    h.deps.media.materialize = async () => {
      throw new Error("Writing a.png failed: disk full");
    };
    await runAll(h);
    expect(h.brain.starts).toHaveLength(0);
    expect(await h.store.get(a.id)).toMatchObject({ status: "failed", failReason: "Writing a.png failed: disk full" });
  });
});

describe("Runner: cloud tasks", () => {
  it("claims after local tasks, downloads media with the runner key, reports retry with retryAfterMinutes and a screenshot", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k", retryAfterMinutes: 12 });
    const local = await h.store.add({ instructions: "local first" });
    const claim = claimFixture("c1", { attempts: 2 });
    claim.media = [{ id: "m1", filename: "clip.mp4", contentType: "video/mp4", size: 3 }];
    h.claims.push(claim);
    const order: string[] = [];
    h.brain.script = (opts) => {
      order.push(opts.task.id);
      return opts.task.id === "c1" ? { outcome: "failed", reason: "network error" } : { outcome: "done" };
    };
    await runAll(h);
    expect(order).toEqual([local.id, "c1"]);
    const cloudStart = h.brain.starts[1]!;
    expect(cloudStart.config.isRetry).toBe(true);
    expect(h.materialized[1]!.sources).toEqual([
      { kind: "url", name: "clip.mp4", url: "https://api.test/v1/media/m1", headers: [{ name: "Authorization", value: "Bearer bt_k" }] },
    ]);
    expect(h.results).toEqual([
      {
        taskId: "c1",
        body: { runnerId: "runner-1", outcome: "retry", reason: "network error", retryAfterMinutes: 12, screenshotId: "shot-1" },
      },
    ]);
    const s = (await h.sessions.list()).find((x) => x.source === "cloud");
    expect(s).toMatchObject({ taskId: "c1", outcome: "retry" });
  });

  it("paused cloud tasks use pauseRetryMinutes", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k", pauseRetryMinutes: 30 });
    h.claims.push(claimFixture("c2"));
    h.brain.script = () => ({ outcome: "paused", reason: "2FA" });
    await runAll(h);
    expect(h.results[0]!.body).toMatchObject({ outcome: "paused", reason: "2FA", retryAfterMinutes: 30 });
  });

  it("cloud sync on but not configured: nothing runs, lastError explains", async () => {
    const h = harness({ cloudEnabled: true });
    await runAll(h);
    expect((await h.runner.state()).lastError).toMatch(/API URL or runner key is missing/);
  });
});

describe("Runner: adhoc sessions", () => {
  it("runs a one-off task as a session only, with media and user messages", async () => {
    const h = harness();
    let events: AgentEvent[] = [];
    h.brain.script = (_opts, ctl) => {
      void (async () => {
        await vi.waitFor(() => expect(ctl.said).toEqual(["also add a hashtag"]));
        ctl.resolve({ outcome: "done", summary: "did it" });
      })();
      return "hang";
    };
    const { sessionId } = await h.runner.runAdhoc({ instructions: "  Like the top post  ", account: "@me", media: [{ name: "x.png", blob: new Blob(["x"]) }] });
    expect(await h.sessions.get(sessionId)).toMatchObject({ source: "adhoc", title: "Like the top post", brain: "claude-api" });
    expect(h.runner.running?.sessionId).toBe(sessionId);
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(await h.runner.say("also add a hashtag")).toBe(true);
    await h.runner.idle();
    await h.sessions.flush();
    events = await h.sessions.eventsOf(sessionId);
    // One user_message: the brain's echo is dropped.
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "done", summary: "did it" });
    expect(h.brain.starts[0]!.task).toEqual({ id: sessionId, instructions: "Like the top post", account: "@me" });
    expect(h.brain.starts[0]!.mediaPaths).toEqual(["C:\\dl\\x.png"]);
    // One-off runs act on the tab the user is looking at.
    expect(h.prepared).toEqual([{ show: true, mode: "current-tab" }]);
    expect(await h.store.list()).toEqual([]);
    expect(await h.runner.say("late")).toBe(false);
  });

  it("fails fast with the brain note when nothing is usable", async () => {
    const h = harness();
    h.noBrain = true;
    await expect(h.runner.runAdhoc({ instructions: "x" })).rejects.toThrow("No brain available: set a key");
    expect(h.runner.busy).toBe(false);
    await expect(h.runner.runAdhoc({ instructions: " " })).rejects.toThrow(/empty/);
  });

  it("adhoc failures do not count toward the consecutive failure pause", async () => {
    const h = harness({ maxConsecutiveFailures: 1 });
    h.brain.script = () => ({ outcome: "failed", reason: "nope" });
    await h.runner.runAdhoc({ instructions: "x" });
    await h.runner.idle();
    expect(h.settings.paused).toBe(false);
  });
});

describe("Runner: continue a stopped run", () => {
  const POST = "Cats are the best coworkers: they nap through every meeting.";

  /** A run that opens X, types the post, then waits until stopped. */
  function typeThenHang(opts: BrainStartOptions): "hang" {
    opts.onEvent({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/home" } });
    opts.onEvent({ type: "tool_result", id: "1", name: "navigate", text: "Opened https://x.com/home\nmore lines" });
    opts.onEvent({ type: "tool_call", id: "2", name: "mcp__browsertodo__type", args: { index: 12, text: POST } });
    opts.onEvent({ type: "tool_result", id: "2", name: "type", text: "typed 61 chars" });
    opts.onEvent({ type: "assistant_text", text: "The post is typed; now I'll press Post." });
    return "hang";
  }

  async function stopAfterStart(h: Harness, n: number) {
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(n));
    h.runner.stop();
    await h.runner.idle();
    await h.sessions.flush();
  }

  it("continues a one-off run stopped by the user: done steps, note, no double post, isRetry, same agent tab", async () => {
    const h = harness();
    h.brain.script = typeThenHang;
    const first = await h.runner.runAdhoc({ instructions: "Make a post on X about cats", account: "@me" });
    await stopAfterStart(h, 1);
    expect(await h.sessions.get(first.sessionId)).toMatchObject({ outcome: "paused", reason: "stopped by user", instructions: "Make a post on X about cats", account: "@me" });

    h.brain.script = () => ({ outcome: "done", summary: "posted", url: "https://x.com/me/status/123" });
    const next = await h.runner.continueSession(first.sessionId, "  just press Post  ");
    expect(next.sessionId).not.toBe(first.sessionId);
    await h.runner.idle();
    await h.sessions.flush();

    const start = h.brain.starts[1]!;
    const text = start.task.instructions;
    expect(text.startsWith("Make a post on X about cats\n")).toBe(true);
    expect(text).toContain("Continuing a stopped run");
    expect(text).toContain("reason: stopped by user");
    expect(text).toContain("- navigate x.com/home → Opened https://x.com/home");
    expect(text).toContain(`- type #12 "${POST}" → typed 61 chars`);
    expect(text).toContain(`Its last message: "The post is typed; now I'll press Post."`);
    expect(text).toContain("The user adds: just press Post");
    expect(text).toMatch(/first look at the current page/i);
    expect(text).toMatch(/do not type it again/);
    expect(text).toMatch(/Never post twice/);
    expect(start.task.account).toBe("@me");
    expect(start.config.isRetry).toBe(true);
    // The first run used the user's tab; the continuation keeps using that agent tab.
    expect(h.prepared).toEqual([
      { show: true, mode: "current-tab" },
      { show: true, mode: "own-tab" },
    ]);
    // The post is verified against the text typed in the stopped run.
    expect(h.verify).toHaveBeenCalledWith(expect.anything(), "https://x.com/me/status/123", POST);
    expect(await h.sessions.get(next.sessionId)).toMatchObject({
      source: "adhoc",
      title: "Continue: Make a post on X about cats",
      continuedFrom: first.sessionId,
      // The original instructions, so a continuation can be continued again.
      instructions: "Make a post on X about cats",
      outcome: "done",
    });
    expect(await h.store.list()).toEqual([]);
  });

  it("continues a local task as the same task: attempts keep counting, status recorded", async () => {
    const h = harness();
    const t = await h.store.add({ instructions: "Post hello", media: [{ name: "a.png", type: "image/png", dataBase64: btoa("A") }] });
    h.brain.script = typeThenHang;
    await h.runner.runDue("manual");
    await stopAfterStart(h, 1);
    expect(await h.store.get(t.id)).toMatchObject({ status: "paused", attempts: 1 });
    const [old] = await h.sessions.list();

    h.brain.script = async (opts) => {
      expect(await h.store.get(t.id)).toMatchObject({ status: "running", attempts: 2 });
      expect(opts.task.id).toBe(t.id);
      return { outcome: "done", summary: "posted" };
    };
    const next = await h.runner.continueSession(old!.sessionId);
    await h.runner.idle();
    await h.sessions.flush();

    const start = h.brain.starts[1]!;
    expect(start.config.isRetry).toBe(true);
    expect(start.task.instructions).toContain("Continuing a stopped run");
    expect(start.task.instructions).not.toContain("The user adds");
    expect(start.mediaPaths).toEqual(["C:\\dl\\a.png"]);
    expect(h.prepared[1]).toEqual({ show: true, mode: "own-tab" });
    expect(await h.store.get(t.id)).toMatchObject({ status: "done", attempts: 2, resultSummary: "posted" });
    expect(await h.sessions.get(next.sessionId)).toMatchObject({ source: "local", taskId: t.id, title: "Continue: Post hello", continuedFrom: old!.sessionId });
    // Local runs read their instructions from the task, not the session.
    expect((await h.sessions.get(next.sessionId))!.instructions).toBeUndefined();
  });

  it("refuses runs that cannot be continued, without getting busy", async () => {
    const h = harness();
    const done = await h.runner.runAdhoc({ instructions: "x" });
    await h.runner.idle();
    await h.sessions.flush();
    await expect(h.runner.continueSession(done.sessionId)).rejects.toThrow(/already finished/);
    await expect(h.runner.continueSession("nope")).rejects.toThrow(/No session nope/);
    await h.sessions.create({ sessionId: "c1", source: "cloud", taskId: "ct", title: "cloud", brain: "claude-api", jev: false, startedAt: "x", endedAt: "y", outcome: "paused" });
    await expect(h.runner.continueSession("c1")).rejects.toThrow("Cloud tasks continue from the queue; use Retry on the server");
    await h.sessions.create({ sessionId: "l1", source: "local", taskId: "gone", title: "l", brain: "claude-api", jev: false, startedAt: "x", endedAt: "y", outcome: "failed" });
    await expect(h.runner.continueSession("l1")).rejects.toThrow(/no longer exists/);
    expect(h.runner.busy).toBe(false);

    // A running session, and anything while a run is active.
    h.brain.script = () => "hang";
    const live = await h.runner.runAdhoc({ instructions: "y" });
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(2));
    await expect(h.runner.continueSession(live.sessionId)).rejects.toThrow(/already running/);
    h.runner.stop();
    await h.runner.idle();
    await h.sessions.create({ sessionId: "r1", source: "adhoc", title: "r", brain: "claude-api", jev: false, startedAt: "x" });
    await expect(h.runner.continueSession("r1")).rejects.toThrow(/not ended/);
    expect(h.brain.starts).toHaveLength(2);
  });
});

describe("typedTextsOf", () => {
  it("collects text from type, paste and act steps only", () => {
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "type", args: { index: 1, text: "a" } })).toEqual(["a"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "mcp__browsertodo__paste", args: { text: "b" } })).toEqual(["b"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "act", args: { steps: [{ goal: "x" }, { goal: "y", text: "c" }] } })).toEqual(["c"]);
    expect(typedTextsOf({ type: "tool_call", id: "1", name: "click", args: { index: 1 } })).toEqual([]);
    expect(typedTextsOf({ type: "assistant_text", text: "d" })).toEqual([]);
  });
});
