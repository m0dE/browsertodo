import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ExtensionSettings, type HelperInfo, type SessionInfo } from "@browsertodo/shared";
import { installChromeFake } from "./chrome-fake.js";
import { resolveBrain } from "../src/engine/brain-resolver.js";
import { MemoryKvDb } from "../src/engine/kv.js";
import { LocalStore } from "../src/engine/local-store.js";
import type { AdhocInput } from "../src/engine/run/jobs.js";
import type { RunnerState } from "../src/engine/run/state.js";
import { SessionStore } from "../src/engine/sessions.js";
import { UiHub } from "../src/engine/ui-hub.js";
import { UiRouter, type RouterRunner, type UiRouterDeps } from "../src/engine/ui-router.js";
import { applySettingsPatch } from "../src/settings-store.js";
import { UI_PORT_NAME, type UiPush, type UiRequest, type UiResponse } from "../src/ui-protocol.js";

const INFO: HelperInfo = { version: "2", jevAvailable: false, claudePath: "C:\\claude.exe", logDir: "L", selfTest: { ok: true, ms: 1, at: "x" } };

function setup() {
  const db = new MemoryKvDb();
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-secret", runnerKey: "bt_secret" };
  const rstate: RunnerState = { consecutiveFailures: 0, lastRunAt: "2026-09-24T09:00:00.000Z" };
  const running: SessionInfo | null = null;
  const runner = {
    running,
    runningSessions: [] as SessionInfo[],
    state: vi.fn(async () => ({ ...rstate })),
    runDue: vi.fn(async () => ({ started: true })),
    runAdhoc: vi.fn(async (_i: AdhocInput) => ({ sessionId: "adhoc-1" })),
    continueSession: vi.fn(async (_id: string, _note?: string) => ({ sessionId: "cont-1" })),
    message: vi.fn(async (sessionId: string | undefined, _text: string) => ({ sessionId: sessionId ?? "new-1", mode: sessionId ? ("turn" as const) : ("new" as const) })),
    newChat: vi.fn(async (_id?: string) => ({ ok: true })),
    stop: vi.fn(() => true),
    say: vi.fn(async () => true),
    pauseSchedule: vi.fn(async () => {
      settings = { ...settings, paused: true };
    }),
    resumeSchedule: vi.fn(async () => {
      settings = { ...settings, paused: false };
    }),
  } satisfies RouterRunner;
  const helper = {
    info: null as HelperInfo | null,
    lastError: "Specified native messaging host not found." as string | null,
    connect: vi.fn(async (_t?: number, _o?: { selfTest?: boolean }) => {
      helper.info = INFO;
      helper.lastError = null;
      return INFO;
    }),
    call: vi.fn(async (method: string, _p?: unknown, _o?: unknown): Promise<any> => (method === "helper.runLog" ? { text: "{\"type\":\"task_start\"}\n", truncated: false } : { text: "log lines" })),
  };
  const localStore = new LocalStore({ db });
  const sessions = new SessionStore(db);
  const vault = { unlock: vi.fn(async () => {}), lock: vi.fn(async () => {}), list: vi.fn(async () => ({ locked: true, sites: [] })), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const deps: UiRouterDeps = {
    loadSettings: async () => settings,
    saveSettingsPatch: async (patch) => (settings = applySettingsPatch(settings, patch)),
    runner,
    showAgent: async () => false,
    localStore,
    sessions,
    openConversations: () => ["S-open"],
    helper,
    brainStatus: (s) => resolveBrain({ settings: s, helper: helper.info, helperError: helper.lastError }),
    nextRunAt: async () => "2026-09-24T10:15:00.000Z",
    testClaude: async () => ({ ok: true, detail: "Key accepted" }),
    testJev: async () => ({ ok: false, detail: "No Jev key set" }),
    testCloud: async () => ({ ok: true, detail: "Connected" }),
    vault,
  };
  const router = new UiRouter(deps);
  const req = async <T = any>(r: UiRequest | { type: string; [k: string]: unknown }): Promise<T> => {
    const res = (await router.handle(r as UiRequest)) as UiResponse<T>;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  return { router, deps, runner, helper, localStore, sessions, vault, req, get settings() { return settings; } };
}

beforeEach(() => {
  installChromeFake();
});

describe("UiRouter", () => {
  it("state.get: redacted settings, brain status, run state", async () => {
    const t = setup();
    const s = await t.req({ type: "state.get" });
    expect(s.settings.anthropicApiKey).toBe("set");
    expect(s.settings.runnerKey).toBe("set");
    expect(s.settings.jevApiKey).toBe("");
    expect(s.brain).toMatchObject({ effective: "claude-api", hasApiKey: true, helper: null, helperError: "Specified native messaging host not found." });
    expect(s).toMatchObject({ running: null, paused: false, lastRunAt: "2026-09-24T09:00:00.000Z", nextRunAt: "2026-09-24T10:15:00.000Z" });
  });

  it("settings.save: partial update, secrets kept when omitted or 'set', cleared with ''", async () => {
    const t = setup();
    let s = await t.req({ type: "settings.save", settings: { intervalMinutes: 30, anthropicApiKey: "set", jevApiKey: "jk-new" } });
    expect(t.settings).toMatchObject({ intervalMinutes: 30, anthropicApiKey: "sk-secret", jevApiKey: "jk-new", runnerKey: "bt_secret" });
    expect(s.settings.jevApiKey).toBe("set");
    s = await t.req({ type: "settings.save", settings: { runnerKey: "", brain: "claude-code" } });
    expect(t.settings).toMatchObject({ runnerKey: "", brain: "claude-code", anthropicApiKey: "sk-secret" });
    expect(s.brain.effective).toBeNull();
  });

  it("settings tests pass through", async () => {
    const t = setup();
    expect(await t.req({ type: "settings.testClaude" })).toEqual({ ok: true, detail: "Key accepted" });
    expect(await t.req({ type: "settings.testJev" })).toEqual({ ok: false, detail: "No Jev key set" });
    expect(await t.req({ type: "settings.testCloud" })).toEqual({ ok: true, detail: "Connected" });
  });

  it("helper.connect connects with the self-test and returns state, even when it fails", async () => {
    const t = setup();
    const s = await t.req({ type: "helper.connect" });
    expect(t.helper.connect).toHaveBeenCalledWith(undefined, { selfTest: true });
    expect(s.brain).toMatchObject({ effective: "claude-code", helper: INFO });
    t.helper.connect.mockRejectedValueOnce(new Error("nope"));
    await expect(t.req({ type: "helper.connect" })).resolves.toHaveProperty("brain");
  });

  it("run.* requests go to the runner", async () => {
    const t = setup();
    expect(await t.req({ type: "run.adhoc", instructions: "do", account: "@a", media: [{ name: "f.txt", type: "text/plain", dataBase64: btoa("hi") }] })).toEqual({ sessionId: "adhoc-1" });
    const input = t.runner.runAdhoc.mock.calls[0]![0];
    expect(input).toMatchObject({ instructions: "do", account: "@a" });
    expect(await input.media![0]!.blob.text()).toBe("hi");
    expect(await t.req({ type: "run.due" })).toEqual({ started: true });
    expect(t.runner.runDue).toHaveBeenCalledWith("manual");
    expect(await t.req({ type: "run.stop" })).toEqual({ ok: true });
    expect(await t.req({ type: "run.say", text: "hello" })).toEqual({ ok: true });
    expect(t.runner.say).toHaveBeenCalledWith("hello", undefined);
    // One session of several: stop and say take its id.
    await t.req({ type: "run.stop", sessionId: "S2" });
    expect(t.runner.stop).toHaveBeenLastCalledWith("S2");
    await t.req({ type: "run.say", text: "hi", sessionId: "S2" });
    expect(t.runner.say).toHaveBeenLastCalledWith("hi", "S2");
  });

  it("run.continue passes the session id and the trimmed note; errors come back as { ok: false }", async () => {
    const t = setup();
    expect(await t.req({ type: "run.continue", sessionId: "s-old", text: "  it's typed already, just post  " })).toEqual({ sessionId: "cont-1" });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", "it's typed already, just post");
    await t.req({ type: "run.continue", sessionId: "s-old", text: "   " });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", undefined);
    await t.req({ type: "run.continue", sessionId: "s-old" });
    expect(t.runner.continueSession).toHaveBeenLastCalledWith("s-old", undefined);
    expect(await t.router.handle({ type: "run.continue" } as never)).toEqual({ ok: false, error: "sessionId is required" });
    t.runner.continueSession.mockRejectedValueOnce(new Error("Cloud tasks continue from the queue; use Retry on the server"));
    expect(await t.router.handle({ type: "run.continue", sessionId: "c" })).toEqual({
      ok: false,
      error: "Cloud tasks continue from the queue; use Retry on the server",
    });
  });

  it("run.adhoc errors come back as { ok: false, error }", async () => {
    const t = setup();
    t.runner.runAdhoc.mockRejectedValueOnce(new Error("A task is already running"));
    expect(await t.router.handle({ type: "run.adhoc", instructions: "x" })).toEqual({ ok: false, error: "A task is already running" });
  });

  it("schedule.pause / resume return state", async () => {
    const t = setup();
    expect((await t.req({ type: "schedule.pause" })).paused).toBe(true);
    expect((await t.req({ type: "schedule.resume" })).paused).toBe(false);
  });

  it("tasks.* manage the local list", async () => {
    const t = setup();
    const { task } = await t.req({ type: "tasks.add", instructions: "post it", account: "@me", repeat: { dailyAt: ["09:00"] }, media: [{ name: "a.png", type: "image/png", dataBase64: btoa("x") }] });
    expect(task).toMatchObject({ instructions: "post it", account: "@me", status: "pending" });
    const { tasks } = await t.req({ type: "tasks.list" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].media).toEqual([{ id: expect.any(String), name: "a.png", type: "image/png", size: 1 }]);
    expect((await t.req({ type: "tasks.update", id: task.id, patch: { instructions: "edited", repeat: null } })).task).toMatchObject({ instructions: "edited", repeat: null });
    expect((await t.req({ type: "tasks.retry", id: task.id })).task).toMatchObject({ status: "pending", notBefore: null });
    expect(await t.req({ type: "tasks.delete", id: task.id })).toEqual({ ok: true });
    expect(await t.req({ type: "tasks.delete", id: task.id })).toEqual({ ok: false });
    expect(await t.router.handle({ type: "tasks.add", instructions: "" })).toEqual({ ok: false, error: "Instructions are empty" });
  });

  it("sessions.list / sessions.events", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "s1", source: "adhoc", title: "x", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    t.sessions.append("s1", { type: "status", text: "hi" });
    expect((await t.req({ type: "sessions.list", limit: 5 })).sessions.map((s: SessionInfo) => s.sessionId)).toEqual(["s1"]);
    const ev = await t.req({ type: "sessions.events", sessionId: "s1" });
    expect(ev.session.sessionId).toBe("s1");
    expect(ev.events).toEqual([expect.objectContaining({ type: "status", text: "hi", sessionId: "s1" })]);
    expect(await t.router.handle({ type: "sessions.events", sessionId: "nope" })).toEqual({ ok: false, error: "No session nope" });
  });

  it("run.message goes to the runner with the conversation (none: a new one); run.newChat too", async () => {
    const t = setup();
    expect(await t.req({ type: "run.message", sessionId: "S1", text: "now like it" })).toEqual({ sessionId: "S1", mode: "turn" });
    expect(t.runner.message).toHaveBeenLastCalledWith("S1", "now like it");
    expect(await t.req({ type: "run.message", text: "post gm" })).toEqual({ sessionId: "new-1", mode: "new" });
    expect(t.runner.message).toHaveBeenLastCalledWith(undefined, "post gm");
    expect(await t.req({ type: "run.message", sessionId: "", text: "x" })).toMatchObject({ mode: "new" });
    t.runner.message.mockRejectedValueOnce(new Error("The message is empty"));
    expect(await t.router.handle({ type: "run.message", sessionId: "S1", text: " " })).toEqual({ ok: false, error: "The message is empty" });
    expect(await t.req({ type: "run.newChat", sessionId: "S1" })).toEqual({ ok: true });
    expect(t.runner.newChat).toHaveBeenLastCalledWith("S1");
    await t.req({ type: "run.newChat" });
    expect(t.runner.newChat).toHaveBeenLastCalledWith(undefined);
  });

  it("state lists the conversations whose agent session is still open", async () => {
    const t = setup();
    expect((await t.req({ type: "state.get" })).openConversations).toEqual(["S-open"]);
  });

  it("session.log fetches a Claude Code session's run log from the helper", async () => {
    const t = setup();
    await t.sessions.create({ sessionId: "cc", source: "adhoc", title: "x", brain: "claude-code", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    await t.sessions.update("cc", { endedAt: "2026-09-24T10:01:00Z", outcome: "done", logPath: "C:\\bt\\runs\\cc-1\\log.jsonl" });
    expect(await t.router.handle({ type: "session.log", sessionId: "cc" })).toEqual({ ok: false, error: "The helper is not connected" });
    t.helper.info = INFO;
    expect(await t.req({ type: "session.log", sessionId: "cc" })).toEqual({ path: "C:\\bt\\runs\\cc-1\\log.jsonl", text: '{"type":"task_start"}\n', truncated: false });
    expect(t.helper.call).toHaveBeenLastCalledWith("helper.runLog", { path: "C:\\bt\\runs\\cc-1\\log.jsonl" }, { timeoutMs: 15_000 });
    await t.sessions.create({ sessionId: "api", source: "adhoc", title: "x", brain: "claude-api", jev: false, startedAt: "2026-09-24T10:00:00Z" });
    expect(await t.router.handle({ type: "session.log", sessionId: "api" })).toEqual({ ok: false, error: "This session has no run log (only Claude Code sessions do)" });
    expect(await t.router.handle({ type: "session.log", sessionId: "nope" })).toEqual({ ok: false, error: "No session nope" });
  });

  it("extra requests: helper.getLog and vault.*", async () => {
    const t = setup();
    expect(await t.req({ type: "helper.getLog", lines: 50 })).toEqual({ text: "" });
    t.helper.info = INFO;
    expect(await t.req({ type: "helper.getLog", lines: 50 })).toEqual({ text: "log lines" });
    expect(await t.req({ type: "vault.list" })).toEqual({ locked: true, sites: [] });
    expect(await t.req({ type: "vault.set", site: "a.com", username: "u", password: "p" })).toEqual({ ok: true });
  });

  it("unknown requests are errors", async () => {
    const t = setup();
    expect(await t.router.handle({ type: "nope" } as never)).toEqual({ ok: false, error: "Unknown request type: nope" });
  });
});

describe("UiHub", () => {
  function port(name = UI_PORT_NAME) {
    const posted: UiPush[] = [];
    const disc: (() => void)[] = [];
    return { name, posted, postMessage: (m: unknown) => posted.push(m as UiPush), onDisconnect: { addListener: (fn: () => void) => disc.push(fn) }, close: () => disc.forEach((f) => f()) };
  }

  it("sends state on attach, pushes events, coalesces state pushes, forgets closed ports", async () => {
    const getState = vi.fn(async () => ({ paused: false }) as never);
    const hub = new UiHub(getState, { stateDelayMs: 5 });
    const p = port();
    expect(hub.attach(port("other"))).toBe(false);
    expect(hub.attach(p)).toBe(true);
    await vi.waitFor(() => expect(p.posted).toEqual([{ type: "state", state: { paused: false } }]));
    hub.push({ type: "tasks.changed" });
    hub.event({ type: "status", text: "x", ts: "t", sessionId: "s" });
    hub.pushState();
    hub.pushState();
    hub.pushState();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.posted.map((m) => m.type)).toEqual(["state", "tasks.changed", "event", "state"]);
    p.close();
    expect(hub.size).toBe(0);
  });
});
