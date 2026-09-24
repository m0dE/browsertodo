import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentEvent, type HelperNotifications, type TaskRunResult } from "@browsertodo/shared";
import type { AgentSession, ApiAgentOptions } from "@browsertodo/core";
import { ApiBrain, ClaudeCodeBrain, type BrainStartOptions, type HelperLike } from "../src/engine/brains.js";

function opts(events: AgentEvent[], extra: Partial<BrainStartOptions> = {}): BrainStartOptions {
  return {
    sessionId: "s1",
    task: { id: "t1", instructions: "do it", account: null },
    mediaPaths: ["C:\\a.png"],
    config: { maxToolCalls: 10, maxTaskMinutes: 5, jevEnabled: true, jevThreshold: 0.8, isRetry: false },
    settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "jk" },
    onEvent: (e) => events.push(e),
    ...extra,
  };
}

function fakeHelper() {
  const calls: { method: string; params: any }[] = [];
  const notif = new Map<string, Set<(p: any) => void>>();
  const disc = new Set<(r: string) => void>();
  let finish!: (r: TaskRunResult) => void;
  let fail!: (e: Error) => void;
  const helper: HelperLike = {
    call: ((method: string, params: any) => {
      calls.push({ method, params });
      if (method === "helper.runTask") return new Promise((res, rej) => ((finish = res), (fail = rej)));
      if (method === "helper.sendUserMessage") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    }) as HelperLike["call"],
    onNotification: ((m: string, fn: (p: any) => void) => {
      if (!notif.has(m)) notif.set(m, new Set());
      notif.get(m)!.add(fn);
      return () => notif.get(m)!.delete(fn);
    }) as HelperLike["onNotification"],
    onDisconnect: (fn) => {
      disc.add(fn);
      return () => disc.delete(fn);
    },
  };
  return {
    helper,
    calls,
    finish: (r: TaskRunResult) => finish(r),
    fail: (e: Error) => fail(e),
    notify: <N extends keyof HelperNotifications>(m: N, p: HelperNotifications[N]) => notif.get(m)?.forEach((fn) => fn(p)),
    disconnect: (r: string) => disc.forEach((fn) => fn(r)),
    listenerCount: () => [...notif.values()].reduce((n, s) => n + s.size, 0) + disc.size,
  };
}

describe("ClaudeCodeBrain", () => {
  it("runs helper.runTask with sessionId and media paths, forwards only its session's events", async () => {
    const f = fakeHelper();
    const events: AgentEvent[] = [];
    const run = new ClaudeCodeBrain(f.helper).start(opts(events));
    expect(f.calls[0]).toEqual({
      method: "helper.runTask",
      params: { sessionId: "s1", task: { id: "t1", instructions: "do it", account: null }, mediaPaths: ["C:\\a.png"], config: expect.objectContaining({ isRetry: false }) },
    });
    f.notify("helper.event", { sessionId: "s1", event: { type: "status", text: "mine" } });
    f.notify("helper.event", { sessionId: "other", event: { type: "status", text: "not mine" } });
    expect(events).toEqual([{ type: "status", text: "mine" }]);

    expect(await run.sendUserMessage("hi")).toBe(true);
    expect(f.calls[1]).toEqual({ method: "helper.sendUserMessage", params: { sessionId: "s1", text: "hi" } });
    run.abort("login page", "paused");
    run.abort("stuck", "failed");
    expect(f.calls.slice(2)).toEqual([
      { method: "helper.forcePause", params: { sessionId: "s1", reason: "login page" } },
      { method: "helper.abortTask", params: { sessionId: "s1", reason: "stuck" } },
    ]);
    f.finish({ outcome: "done", summary: "ok" });
    expect(await run.done).toEqual({ outcome: "done", summary: "ok" });
    expect(f.listenerCount()).toBe(0);
  });

  it("a helper disconnect ends the run as retry", async () => {
    const f = fakeHelper();
    const run = new ClaudeCodeBrain(f.helper).start(opts([]));
    f.disconnect("Native host has exited.");
    expect(await run.done).toEqual({ outcome: "retry", reason: "helper disconnected: Native host has exited." });
  });

  it("a runTask error ends the run as retry", async () => {
    const f = fakeHelper();
    const run = new ClaudeCodeBrain(f.helper).start(opts([]));
    f.fail(new Error("boom"));
    expect(await run.done).toEqual({ outcome: "retry", reason: "helper error: boom" });
  });
});

describe("ApiBrain", () => {
  it("starts core.startApiAgent with the key, model, browser and a Jev client", async () => {
    const jev = { decide: vi.fn() };
    let got: ApiAgentOptions | null = null;
    const session: AgentSession = {
      sessionId: "s1",
      sendUserMessage: vi.fn(),
      abort: vi.fn(),
      done: Promise.resolve({ outcome: "done" }),
    };
    const core = {
      createJev: vi.fn(() => jev),
      startApiAgent: vi.fn((o: ApiAgentOptions) => ((got = o), session)),
    };
    const browser = { call: vi.fn() as never };
    const run = new ApiBrain({ core, browser }).start(opts([]));
    expect(core.createJev).toHaveBeenCalledWith("jk", undefined);
    expect(got).toMatchObject({ sessionId: "s1", apiKey: "sk", model: DEFAULT_SETTINGS.anthropicModel, jev, browser, mediaPaths: ["C:\\a.png"] });
    expect(await run.sendUserMessage("more")).toBe(true);
    expect(session.sendUserMessage).toHaveBeenCalledWith("more");
    run.abort("login", "paused");
    expect(session.abort).toHaveBeenCalledWith("login", "paused");
    expect(await run.done).toEqual({ outcome: "done" });
  });

  it("no Jev without a key or when disabled", () => {
    const core = { createJev: vi.fn(), startApiAgent: vi.fn(() => ({ sessionId: "s", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) })) };
    const brain = new ApiBrain({ core, browser: { call: vi.fn() as never } });
    brain.start(opts([], { settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "" } }));
    brain.start(opts([], { settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk", jevApiKey: "jk", jevEnabled: false } }));
    expect(core.createJev).not.toHaveBeenCalled();
    expect((core.startApiAgent.mock.calls as unknown as [ApiAgentOptions][]).map((c) => c[0].jev)).toEqual([null, null]);
  });

  it("a throwing startApiAgent becomes a failed run", async () => {
    const core = {
      createJev: vi.fn(),
      startApiAgent: vi.fn(() => {
        throw new Error("not implemented");
      }),
    };
    const run = new ApiBrain({ core, browser: { call: vi.fn() as never } }).start(opts([]));
    expect(await run.done).toEqual({ outcome: "failed", reason: "Could not start the Claude API agent: not implemented" });
  });
});
