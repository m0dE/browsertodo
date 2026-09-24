import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type ClaimResponse,
  type ExtensionSettings,
  type HelperInfo,
  type HelperMethods,
  type ResultInput,
  type TaskRunResult,
} from "@browsertodo/shared";
import { Coordinator, type CoordinatorDeps, type RunState } from "../src/coordinator.js";
import { claimFixture } from "./fixtures.js";

const INFO: HelperInfo = { version: "0.1.0", jevAvailable: false, claudePath: null, logDir: "C:\\logs" };

interface Harness {
  deps: CoordinatorDeps;
  settings: ExtensionSettings;
  queue: (ClaimResponse | null)[];
  results: { taskId: string; body: ResultInput }[];
  heartbeats: string[];
  uploads: string[];
  notifications: { title: string; message: string }[];
  helperCalls: { method: string; params: unknown }[];
  state: RunState;
  /** Resolvers for each runTask call, in order. */
  runs: { claim: ClaimResponse; resolve: (r: TaskRunResult) => void; reject: (e: Error) => void }[];
  autoResult: ((claim: ClaimResponse) => TaskRunResult) | null;
  disconnect: (reason: string) => void;
  sleeps: number[];
  helperFails: boolean;
}

function harness(overrides: Partial<ExtensionSettings> = {}): Harness {
  const h = {
    settings: { ...DEFAULT_SETTINGS, apiBase: "https://api.test", runnerKey: "bt_k", ...overrides },
    queue: [],
    results: [],
    heartbeats: [],
    uploads: [],
    notifications: [],
    helperCalls: [],
    state: { running: false, currentTaskId: null, lastRunAt: null, lastError: null },
    runs: [],
    autoResult: (c: ClaimResponse) => ({ outcome: "done", summary: `did ${c.task.id}`, url: `https://x.com/me/status/${c.task.id}` }),
    sleeps: [],
    helperFails: false,
  } as unknown as Harness;
  const disconnectListeners = new Set<(r: string) => void>();
  h.disconnect = (reason) => {
    for (const fn of [...disconnectListeners]) fn(reason);
  };
  h.deps = {
    loadSettings: async () => h.settings,
    getRunnerId: async () => "runner-1",
    createApi: () => ({
      claim: async () => h.queue.shift() ?? null,
      heartbeat: async (taskId: string) => {
        h.heartbeats.push(taskId);
        return { leaseExpiresAt: "x" };
      },
      result: async (taskId: string, body: ResultInput) => {
        h.results.push({ taskId, body });
      },
      uploadMedia: async (_blob: Blob, filename: string) => {
        h.uploads.push(filename);
        return { id: `media-${h.uploads.length}`, filename, contentType: "image/jpeg", size: 1 };
      },
    }),
    helper: {
      connect: async () => {
        if (h.helperFails) throw new Error("Specified native messaging host not found.");
        return INFO;
      },
      call: (async (method: keyof HelperMethods, params: unknown) => {
        h.helperCalls.push({ method, params });
        if (method === "helper.runTask") {
          const { claim } = params as HelperMethods["helper.runTask"]["params"];
          if (h.autoResult) return h.autoResult(claim);
          return new Promise<TaskRunResult>((resolve, reject) => h.runs.push({ claim, resolve, reject }));
        }
        return { ok: true };
      }) as CoordinatorDeps["helper"]["call"],
      onDisconnect: (fn: (r: string) => void) => {
        disconnectListeners.add(fn);
        return () => disconnectListeners.delete(fn);
      },
    },
    prepareTab: async () => {},
    isAgentTab: async (tabId: number) => tabId === 7,
    screenshot: async () => ({ base64: "AAAA", mimeType: "image/jpeg" as const }),
    notify: (title: string, message: string) => {
      h.notifications.push({ title, message });
    },
    saveState: async (patch: Partial<RunState>) => {
      Object.assign(h.state, patch);
    },
    sleep: async (ms: number) => {
      h.sleeps.push(ms);
    },
    now: () => new Date("2026-09-23T10:00:00.000Z"),
  };
  return h;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Coordinator.run", () => {
  it("runs tasks until the API returns 204, with a random delay between tasks", async () => {
    const h = harness({ delayMinSec: 60, delayMaxSec: 60, pauseRetryMinutes: 20 });
    h.queue.push(claimFixture("t1"), claimFixture("t2"));
    const c = new Coordinator(h.deps);
    await c.run("alarm");

    const runTasks = h.helperCalls.filter((x) => x.method === "helper.runTask");
    expect(runTasks).toHaveLength(2);
    expect(runTasks[0]!.params).toEqual({
      claim: claimFixture("t1"),
      config: { apiBase: "https://api.test", runnerKey: "bt_k", maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8 },
    });
    expect(h.results).toEqual([
      {
        taskId: "t1",
        body: {
          runnerId: "runner-1",
          outcome: "done",
          summary: "did t1",
          url: "https://x.com/me/status/t1",
          screenshotId: "media-1",
          retryAfterMinutes: 20,
        },
      },
      {
        taskId: "t2",
        body: {
          runnerId: "runner-1",
          outcome: "done",
          summary: "did t2",
          url: "https://x.com/me/status/t2",
          screenshotId: "media-2",
          retryAfterMinutes: 20,
        },
      },
    ]);
    expect(h.uploads).toEqual(["result-t1.jpg", "result-t2.jpg"]);
    expect(h.sleeps).toEqual([60_000, 60_000]);
    expect(h.state).toEqual({ running: false, currentTaskId: null, lastRunAt: "2026-09-23T10:00:00.000Z", lastError: null });
  });

  it("skips scheduled runs while paused but lets Run now through", async () => {
    const h = harness({ paused: true });
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    await c.run("alarm");
    expect(h.helperCalls).toEqual([]);
    expect(h.queue).toHaveLength(1);
    await c.run("manual");
    expect(h.results).toHaveLength(1);
  });

  it("skips when the API is not configured and records the error", async () => {
    const h = harness({ apiBase: "", runnerKey: "" });
    const c = new Coordinator(h.deps);
    await c.run("manual");
    expect(h.helperCalls).toEqual([]);
    expect(h.state.lastError).toMatch(/API base URL and runner key/);
  });

  it("skips a second run while one is active", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const first = c.run("alarm");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(c.running).toBe(true);
    await c.run("manual");
    expect(h.helperCalls.filter((x) => x.method === "helper.runTask")).toHaveLength(1);
    h.runs[0]!.resolve({ outcome: "done", summary: "ok" });
    await first;
    expect(c.running).toBe(false);
  });

  it("notifies and stops when the helper is not connected", async () => {
    const h = harness();
    h.helperFails = true;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    await c.run("alarm");
    expect(h.notifications).toEqual([{ title: "Helper not connected", message: expect.stringContaining("native messaging host not found") }]);
    expect(h.queue).toHaveLength(1);
    expect(h.state.lastError).toMatch(/Helper not connected/);
  });

  it("stops the run and notifies on a paused outcome", async () => {
    const h = harness({ pauseRetryMinutes: 30 });
    h.autoResult = () => ({ outcome: "paused", reason: "X is asking to log in" });
    h.queue.push(claimFixture("t1"), claimFixture("t2"));
    const c = new Coordinator(h.deps);
    await c.run("alarm");
    expect(h.results).toHaveLength(1);
    expect(h.results[0]!.body).toMatchObject({ outcome: "paused", reason: "X is asking to log in", retryAfterMinutes: 30 });
    expect(h.queue).toHaveLength(1);
    expect(h.notifications).toEqual([{ title: "Task paused", message: "X is asking to log in" }]);
    expect(h.sleeps).toEqual([]);
  });

  it("forces a pause when the agent tab hits a pause URL", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));

    await c.onTabUpdated(8, { url: "https://x.com/i/flow/login" }); // not the agent tab
    await c.onTabUpdated(7, { url: "https://x.com/home" }); // fine
    expect(h.helperCalls.filter((x) => x.method === "helper.forcePause")).toEqual([]);
    await c.onTabUpdated(7, { url: "https://x.com/i/flow/login?redirect=1" });
    expect(h.helperCalls.filter((x) => x.method === "helper.forcePause")).toEqual([
      { method: "helper.forcePause", params: { taskId: "t1", reason: "X is asking to log in" } },
    ]);
    // Even if the helper reported something else, the forced pause wins.
    h.runs[0]!.resolve({ outcome: "failed", reason: "aborted" });
    await done;
    expect(h.results[0]!.body).toMatchObject({ outcome: "paused", reason: "X is asking to log in" });
  });

  it("reports failed when runTask rejects", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    h.runs[0]!.reject(new Error("busy"));
    await done;
    expect(h.results[0]!.body).toMatchObject({ outcome: "failed", reason: "busy" });
  });

  it("reports 'helper disconnected' when the port drops mid-task and ends the run", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"), claimFixture("t2"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    h.disconnect("Native host has exited.");
    await done;
    expect(h.results).toEqual([{ taskId: "t1", body: expect.objectContaining({ outcome: "failed", reason: "helper disconnected" }) }]);
    expect(h.queue).toHaveLength(1);
    expect(h.state.lastError).toMatch(/helper disconnected/i);
  });

  it("fails the task when the agent tab cannot be prepared", async () => {
    const h = harness();
    h.deps.prepareTab = async () => {
      throw new Error("Cannot attach to this target");
    };
    h.queue.push(claimFixture("t1"));
    await new Coordinator(h.deps).run("alarm");
    expect(h.helperCalls.filter((x) => x.method === "helper.runTask")).toEqual([]);
    expect(h.results[0]!.body).toMatchObject({ outcome: "failed", reason: "Cannot attach to this target" });
  });

  it("still reports the result when the screenshot fails", async () => {
    const h = harness();
    h.deps.screenshot = async () => {
      throw new Error("no tab");
    };
    h.queue.push(claimFixture("t1"));
    await new Coordinator(h.deps).run("alarm");
    expect(h.results[0]!.body).toMatchObject({ outcome: "done" });
    expect(h.results[0]!.body.screenshotId).toBeUndefined();
  });

  it("aborts the task via the helper when the debugger is detached by the user", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    await c.onDebuggerCanceled();
    expect(h.helperCalls).toContainEqual({ method: "helper.abortTask", params: { taskId: "t1", reason: "debugger detached by user" } });
    h.runs[0]!.resolve({ outcome: "failed", reason: "debugger detached by user" });
    await done;
  });
});

/** Flush microtasks without moving fake time (vi.waitFor would advance it). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
}

describe("Coordinator timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends a heartbeat every 2 minutes while a task runs", async () => {
    const h = harness();
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await until(() => h.runs.length === 1);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.heartbeats).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.heartbeats).toEqual(["t1"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.heartbeats).toEqual(["t1", "t1"]);
    h.runs[0]!.resolve({ outcome: "done" });
    await done;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.heartbeats).toHaveLength(2);
  });

  it("aborts after maxTaskMinutes + 2 and fails if the helper never answers", async () => {
    const h = harness({ maxTaskMinutes: 3 });
    h.autoResult = null;
    h.queue.push(claimFixture("t1"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await until(() => h.runs.length === 1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(h.helperCalls.filter((x) => x.method === "helper.abortTask")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.helperCalls.filter((x) => x.method === "helper.abortTask")).toEqual([
      { method: "helper.abortTask", params: { taskId: "t1", reason: "no result after 5 minutes" } },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(h.results[0]!.body).toMatchObject({ outcome: "failed", reason: "no result after 5 minutes" });
  });

  it("uses real sleeps between tasks by default", async () => {
    const h = harness({ delayMinSec: 2, delayMaxSec: 2 });
    delete (h.deps as Partial<CoordinatorDeps>).sleep;
    h.queue.push(claimFixture("t1"), claimFixture("t2"));
    const c = new Coordinator(h.deps);
    const done = c.run("alarm");
    await until(() => h.results.length === 1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_001);
    await done;
    expect(h.results).toHaveLength(2);
  });
});
