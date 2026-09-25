import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperErrorCode, type AgentEvent, type AgentTask, type RunConfig } from "@browsertodo/shared";
import { agentError, classifyFailure, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT, type JevLike } from "@browsertodo/core";
import { TaskRunner, type RunTaskParams, type TaskRunnerDeps } from "../src/task-runner.js";
import { ToolRouter } from "../src/tool-router.js";
import { INTERACTIVE_TASK_ID } from "../src/mcp-tools.js";
import { ScriptedBrain } from "../src/brains/scripted.js";
import type { Brain, BrainContext } from "../src/brains/brain.js";
import { FakeX } from "./fake-x.js";
import { noSleep } from "../../../packages/core/test/helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
const fakeJev: JevLike = { decide: async () => ({ operation: "blocked", index: null, confidence: 0 }) };

function params(over: Partial<AgentTask> = {}, rest: Partial<RunTaskParams> = {}): RunTaskParams {
  return {
    sessionId: "S1",
    task: { id: "T1", instructions: "Post: hello from browsertodo", account: null, ...over },
    mediaPaths: [],
    config: CONFIG,
    ...rest,
  };
}

function setup(x: FakeX, over: Partial<TaskRunnerDeps> & { brain?: (router: ToolRouter) => Brain } = {}) {
  let runner!: TaskRunner;
  const events: { sessionId: string; event: AgentEvent }[] = [];
  const router = new ToolRouter({ getSession: (id) => runner.session(id) });
  runner = new TaskRunner({
    runsDir: join(dir, "runs"),
    mcpServerPath: "C:\\helper\\dist\\mcp-server.js",
    pipePath: "\\\\.\\pipe\\browsertodo-test",
    browser: x.caller(),
    envJevKey: "env-key",
    makeJev: () => fakeJev,
    makeBrain: () => (over.brain ? over.brain(router) : new ScriptedBrain((t, n, a) => router.call(t, n, a), { sleep: noSleep })),
    notify: (sessionId, event) => events.push({ sessionId, event }),
    sleep: noSleep,
    ...over,
  });
  return { runner, router, events };
}

/** A brain that runs `steps` then waits until aborted (or until its input closes, like Claude Code). */
function customBrain(steps: (ctx: BrainContext) => Promise<void>, hang: "abort" | "input" | false = false): Brain {
  return {
    run: async (ctx) => {
      await steps(ctx);
      if (hang === "abort") await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
      if (hang === "input") await new Promise<void>((r) => ctx.input.onClose(r));
    },
  };
}

describe("TaskRunner with ScriptedBrain", () => {
  it("posts, switching account and attaching media, completes with the post URL, and emits events", async () => {
    const x = new FakeX({ account: "alice" });
    const { runner, events } = setup(x);
    const media = "C:\\Downloads\\browsertodo-media\\S1\\cat.png";
    const result = await runner.run(
      params({ account: "@bob", instructions: "Open https://x.com/compose/post and publish. Post: gm from bob" }, { mediaPaths: [media] }),
    );
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/bob/status/1000", summary: "Posted: gm from bob" });
    expect(x.posts).toEqual([{ account: "bob", text: "gm from bob", files: [media], url: "https://x.com/bob/status/1000" }]);
    expect(runner.busy).toBe(false);
    expect(existsSync(result.logPath!)).toBe(true);
    const logged = readFileSync(result.logPath!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(logged.some((e) => e.type === "tool_call" && e.name === "switch_x_account")).toBe(true);
    // helper.event notifications: tool events from the executor, then task_end
    expect(events.every((e) => e.sessionId === "S1")).toBe(true);
    expect(events.filter((e) => e.event.type === "tool_call").map((e) => (e.event as { name: string }).name)).toContain("upload");
    expect(events.at(-1)!.event).toEqual({ type: "task_end", outcome: "done", summary: "Posted: gm from bob", url: "https://x.com/bob/status/1000" });
    // Jev (the fake always refuses) left both picks to the brain, which chose from act's candidates; the count comes before task_end.
    expect(events.at(-2)!.event).toEqual({
      type: "status",
      text: "Jev chose 0 of 2 element picks (clicks and typing); Claude chose 2",
      picks: { jev: 0, claude: 2 },
    });
  });

  it("with Jev on: the MCP server describes the tools for Jev, and the router reports it", async () => {
    const x = new FakeX();
    let seen: BrainContext | undefined;
    const { runner, router } = setup(x, { brain: () => customBrain(async (ctx) => void (seen = ctx), "abort") });
    const done = runner.run(params());
    await vi.waitFor(() => expect(seen).toBeDefined());
    const cfg = JSON.parse(readFileSync(seen!.mcpConfigPath, "utf8"));
    expect(cfg.mcpServers.browsertodo.env.BROWSERTODO_JEV).toBe("1");
    expect(router.jev("S1")).toBe(true);
    expect(seen!.systemPrompt).toMatch(/Jev picks the element of every act step/);
    expect(seen!.systemPrompt).not.toMatch(/each naming the element index/);
    runner.abort("S1", "test over");
    await done;
  });

  it("writes the MCP config; act replaces click and type even when Jev is off", async () => {
    const x = new FakeX();
    let seen: BrainContext | undefined;
    const { runner } = setup(x, { brain: () => customBrain(async (ctx) => void (seen = ctx)) });
    await runner.run(params({}, { config: { ...CONFIG, jevEnabled: false } }));
    const cfg = JSON.parse(readFileSync(seen!.mcpConfigPath, "utf8"));
    expect(cfg).toEqual({
      mcpServers: {
        browsertodo: {
          command: process.execPath,
          args: ["C:\\helper\\dist\\mcp-server.js"],
          env: { BROWSERTODO_PIPE: "\\\\.\\pipe\\browsertodo-test", BROWSERTODO_TASK: "S1", BROWSERTODO_TOOLS: expect.any(String), BROWSERTODO_JEV: "0" },
        },
      },
    });
    const tools = cfg.mcpServers.browsertodo.env.BROWSERTODO_TOOLS.split(",");
    expect(tools).toContain("act");
    expect(tools).not.toContain("click");
    expect(tools).not.toContain("type");
    expect(seen!.allowedTools).toContain("mcp__browsertodo__task_complete");
    expect(seen!.allowedTools).toContain("mcp__browsertodo__act");
    expect(seen!.systemPrompt).toMatch(/each naming the element index/);
    expect(seen!.prompt).toContain("Post: hello from browsertodo");
  });

  it("uses Jev when enabled with a key from the config or the environment", async () => {
    const x = new FakeX();
    const seen: string[][] = [];
    const keys: string[] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.allowedTools));
    const makeJev = (k: string) => (keys.push(k), fakeJev);
    await setup(x, { brain, makeJev }).runner.run(params());
    await setup(x, { brain, makeJev }).runner.run(params({}, { config: { ...CONFIG, jevApiKey: "cfg-key" } }));
    await setup(x, { brain, makeJev, envJevKey: null }).runner.run(params());
    for (const s of seen) expect(s).toContain("mcp__browsertodo__act");
    // Only the runs with a key created a Jev client.
    expect(keys).toEqual(["env-key", "cfg-key"]);
  });

  it("passes the extension's model (config.model) to the brain, none when unset", async () => {
    const seen: (string | undefined)[] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.model));
    await setup(new FakeX(), { brain }).runner.run(params({}, { config: { ...CONFIG, model: " claude-opus-5-5 " } }));
    await setup(new FakeX(), { brain }).runner.run(params());
    expect(seen).toEqual(["claude-opus-5-5", undefined]);
  });

  it("uses the retry prompt when isRetry", async () => {
    let seen: BrainContext | undefined;
    await setup(new FakeX(), { brain: () => customBrain(async (ctx) => void (seen = ctx)) }).runner.run(
      params({ account: "@bob" }, { config: { ...CONFIG, isRetry: true } }),
    );
    expect(seen!.prompt).toMatch(/this is a retry/);
    expect(seen!.prompt).toContain("https://x.com/bob");
  });

  it("pauses on a login page", async () => {
    const x = new FakeX({ url: "https://x.com/i/flow/login" });
    const r = await setup(x).runner.run(params());
    expect(r).toMatchObject({ outcome: "paused", reason: "X is asking to log in" });
  });

  it("pauses when the account cannot be switched to", async () => {
    const x = new FakeX({ accounts: ["alice"] });
    const r = await setup(x).runner.run(params({ account: "@zed" }));
    expect(r.outcome).toBe("paused");
    expect(r.reason).toMatch(/Could not switch to @zed/);
    expect(x.posts).toHaveLength(0);
  });

  it("runs several sessions at once, one turn per session; abort is keyed by sessionId", async () => {
    const { runner } = setup(new FakeX(), { brain: () => customBrain(async () => {}, "abort") });
    const first = runner.run(params());
    const second = runner.run(params({}, { sessionId: "S2" }));
    expect(runner.openSessions.sort()).toEqual(["S1", "S2"]);
    await expect(runner.run(params())).rejects.toMatchObject({ code: HelperErrorCode.busy });
    expect(runner.abort("S3", "wrong session")).toBe(false);
    runner.abort("S1", "test over");
    expect(await first).toMatchObject({ outcome: "failed", reason: "test over" });
    expect(runner.openSessions).toEqual(["S2"]);
    runner.abort("S2", "done too");
    expect(await second).toMatchObject({ outcome: "failed", reason: "done too" });
    expect(runner.busy).toBe(false);
  });

  it("each session's browser calls carry its session id, so the extension acts in that session's tab", async () => {
    const x = new FakeX({ account: "alice" });
    const seen: { method: string; sessionId?: string }[] = [];
    const inner = x.caller();
    const browser = { call: (method: any, p: any) => (seen.push({ method, sessionId: p?.sessionId }), inner.call(method, p)) } as typeof inner;
    const { runner } = setup(x, { browser });
    await Promise.all([runner.run(params()), runner.run(params({ instructions: "Post: from two" }, { sessionId: "S2" }))]);
    expect(seen.length).toBeGreaterThan(4);
    expect(new Set(seen.map((c) => c.sessionId))).toEqual(new Set(["S1", "S2"]));
  });

  it("single-turn brains end with their turn: continueSession says the session ended", async () => {
    const { runner } = setup(new FakeX());
    expect(await runner.run(params())).toMatchObject({ outcome: "done" });
    expect(runner.openSessions).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "again", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });

  it("refuses the reserved interactive session id", async () => {
    await expect(setup(new FakeX()).runner.run(params({}, { sessionId: INTERACTIVE_TASK_ID }))).rejects.toThrow(/reserved/);
  });

  it("forcePause wins over a task_* result", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          await router.call(ctx.taskId, "task_complete", { summary: "done" });
          setTimeout(() => runner.forcePause(ctx.taskId, "login page appeared"), 10);
        }, "abort"),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "paused", reason: "login page appeared" });
  });

  it("fails at the time limit", async () => {
    const { runner } = setup(new FakeX(), { brain: () => customBrain(async () => {}, "abort") });
    const r = await runner.run(params({}, { config: { ...CONFIG, maxTaskMinutes: 0.001 } }));
    expect(r).toMatchObject({ outcome: "failed", reason: "Task time limit of 0.001 minutes reached" });
  });

  it("fails when the agent exits without a result, or with the last Claude error", async () => {
    expect(await setup(new FakeX(), { brain: () => customBrain(async () => {}) }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: EXITED_WITHOUT_RESULT,
    });
    const limited = customBrain(async (ctx) => ctx.emit({ type: "error", text: "Claude Code: Claude AI usage limit reached" }));
    expect(await setup(new FakeX(), { brain: () => limited }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: "Claude Code: Claude AI usage limit reached",
    });
  });

  it("reports brain crashes", async () => {
    const { runner } = setup(new FakeX(), { brain: () => ({ run: async () => Promise.reject(new Error("spawn ENOENT")) }) });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: agentError("spawn ENOENT") });
  });

  it("closes the brain's input after a task_* call, then aborts after the grace period", async () => {
    let aborted = false;
    let inputClosed = false;
    const { runner } = setup(new FakeX(), {
      finishGraceMs: 30,
      brain: (router) =>
        customBrain(async (ctx) => {
          ctx.input.onClose(() => (inputClosed = true));
          await router.call(ctx.taskId, "task_fail", { reason: "cannot" });
          ctx.signal.addEventListener("abort", () => (aborted = true));
        }, "abort"),
    });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(inputClosed).toBe(true);
    expect(aborted).toBe(true);
  });

  it("delivers user messages to the brain and emits user_message", async () => {
    const got: string[] = [];
    let router!: ToolRouter;
    const { runner, events } = setup(new FakeX(), {
      brain: (r) => {
        router = r;
        return customBrain(async (ctx) => {
          ctx.input.onMessage((t) => {
            got.push(t);
            void router.call(ctx.taskId, "task_complete", { summary: `heard ${t}` });
          });
        }, "input");
      },
    });
    const run = runner.run(params());
    expect(runner.sendUserMessage("nope", "hi")).toBe(false);
    expect(runner.sendUserMessage("S1", "stop after this")).toBe(true);
    expect(await run).toMatchObject({ outcome: "done", summary: "heard stop after this" });
    expect(got).toEqual(["stop after this"]);
    expect(events.some((e) => e.event.type === "user_message")).toBe(true);
    expect(runner.sendUserMessage("S1", "too late")).toBe(false);
  });

  it("the scripted brain acknowledges user messages", async () => {
    const x = new FakeX();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = false;
    const slow = { call: async (m: any, p: any) => (m === "browser.readPage" ? ((reading = true), await gate) : undefined, x.handle(m, p)) };
    const { runner, events } = setup(x, { browser: slow as any });
    const run = runner.run(params());
    // The brain is running (waiting for the page) when the message arrives.
    await vi.waitFor(() => expect(reading).toBe(true));
    expect(runner.sendUserMessage("S1", "hello brain")).toBe(true);
    release();
    await run;
    expect(events.some((e) => e.event.type === "assistant_text" && e.event.text === "Scripted brain received: hello brain")).toBe(true);
  });

  it("enforces the tool call limit: errors past the max, abort at max + 5", async () => {
    const texts: (string | undefined)[] = [];
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 20 && !ctx.signal.aborted; i++) texts.push((await router.call(ctx.taskId, "read_page", {})).text);
        }),
    });
    const r = await runner.run(params({}, { config: { ...CONFIG, maxToolCalls: 3 } }));
    expect(texts.slice(0, 3).every((t) => t?.startsWith("URL:"))).toBe(true);
    expect(texts[3]).toBe("Tool call limit of 3 reached. Call task_fail now with a short reason.");
    expect(texts).toHaveLength(8);
    expect(r).toMatchObject({ outcome: "failed", reason: "Tool call limit exceeded (3 calls)" });
  });

  it("still accepts task_fail past the tool call limit", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 4; i++) await router.call(ctx.taskId, "read_page", {});
          await router.call(ctx.taskId, "task_fail", { reason: "too many steps" });
        }),
    });
    expect(await runner.run(params({}, { config: { ...CONFIG, maxToolCalls: 3 } }))).toMatchObject({ outcome: "failed", reason: "too many steps" });
  });

  it("saves screenshots beside the log", async () => {
    const { runner } = setup(new FakeX(), {
      brain: (router) =>
        customBrain(async (ctx) => {
          await router.call(ctx.taskId, "screenshot", {});
          await router.call(ctx.taskId, "task_complete", { summary: "ok" });
        }),
    });
    const r = await runner.run(params());
    expect(readdirSync(join(r.logPath!, ".."))).toContain("screenshot-001.jpg");
  });
});

/**
 * Like headless Claude Code with stdin kept open: every message (the prompt,
 * then each follow-up) is answered with task_complete; it exits when its input
 * closes or it is aborted.
 */
function chatBrain(router: ToolRouter, opts: { ignoreClose?: boolean } = {}): Brain {
  return {
    persistent: true,
    run: async (ctx) => {
      const answer = (text: string) => void router.call(ctx.taskId, "task_complete", { summary: `did: ${text.slice(-40)}` });
      answer(ctx.task!.instructions);
      ctx.input.onMessage((text) => answer(text));
      await new Promise<void>((resolve) => {
        if (!opts.ignoreClose) ctx.input.onClose(resolve);
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

describe("TaskRunner: kept-open sessions (persistent brain)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function chatSetup(over: Partial<TaskRunnerDeps> = {}, brainOpts: { ignoreClose?: boolean } = {}) {
    const changes: string[][] = [];
    const t = setup(new FakeX(), { brain: (router) => chatBrain(router, brainOpts), onSessionsChanged: (open) => changes.push(open), ...over });
    return { ...t, changes };
  }

  it("stays open after task_*; continueSession runs the next turn in the same session", async () => {
    const { runner, events, changes } = chatSetup();
    expect(await runner.run(params())).toMatchObject({ outcome: "done", summary: "did: Post: hello from browsertodo" });
    expect(runner.openSessions).toEqual(["S1"]);
    expect(runner.busy).toBe(false);
    expect(changes).toEqual([["S1"]]);

    const next = await runner.continueSession({ sessionId: "S1", text: "now like it", config: CONFIG });
    expect(next).toMatchObject({ outcome: "done", summary: expect.stringContaining("now like it") });
    const mine = events.filter((e) => e.sessionId === "S1").map((e) => e.event);
    // The follow-up shows as the user's message, then its own task_end.
    const i = mine.findIndex((e) => e.type === "user_message");
    expect(mine[i]).toEqual({ type: "user_message", text: "now like it" });
    expect(mine.filter((e) => e.type === "task_end")).toHaveLength(2);
    expect(mine.slice(i).some((e) => e.type === "task_end")).toBe(true);
  });

  it("endSession closes it: continueSession then says 'session ended'", async () => {
    const { runner, changes } = chatSetup();
    await runner.run(params());
    expect(runner.endSession("S1")).toBe(true);
    await wait(10);
    expect(runner.openSessions).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "again", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
    expect(runner.endSession("S1")).toBe(false);
  });

  it("an agent that ignores the close is killed after abortWaitMs", async () => {
    const { runner } = chatSetup({ abortWaitMs: 30 }, { ignoreClose: true });
    await runner.run(params());
    runner.endSession("S1");
    await wait(5);
    expect(runner.openSessions).toEqual(["S1"]);
    await wait(80);
    expect(runner.openSessions).toEqual([]);
  });

  it("closes an idle session after idleSessionMs", async () => {
    const { runner } = chatSetup({ idleSessionMs: 40 });
    await runner.run(params());
    expect(runner.openSessions).toEqual(["S1"]);
    await wait(120);
    expect(runner.openSessions).toEqual([]);
  });

  it("keeps at most maxSessions open: a new run closes the oldest idle one", async () => {
    const { runner } = chatSetup({ maxSessions: 2 });
    await runner.run(params({}, { sessionId: "A" }));
    await wait(2);
    await runner.run(params({}, { sessionId: "B" }));
    await runner.run(params({}, { sessionId: "C" }));
    await wait(10);
    expect(runner.openSessions.sort()).toEqual(["B", "C"]);
    await expect(runner.continueSession({ sessionId: "A", text: "x", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });

  it("a turn that goes idle without a task_* call fails as ended without a result, which is retried later", async () => {
    const idleBrain: Brain = {
      persistent: true,
      run: async (ctx) => {
        ctx.idle?.();
        await new Promise<void>((r) => ctx.input.onClose(r));
      },
    };
    const { runner } = setup(new FakeX(), { brain: () => idleBrain });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: ENDED_WITHOUT_RESULT });
    expect(classifyFailure(ENDED_WITHOUT_RESULT)).toBe("transient");
    runner.endSession("S1");
  });

  it("an aborted turn ends the session", async () => {
    const { runner } = setup(new FakeX(), { brain: () => ({ persistent: true, run: (ctx) => new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true })) }) });
    const run = runner.run(params());
    await wait(5);
    runner.forcePause("S1", "stopped by user");
    expect(await run).toEqual(expect.objectContaining({ outcome: "paused", reason: "stopped by user" }));
    expect(runner.openSessions).toEqual([]);
    await expect(runner.continueSession({ sessionId: "S1", text: "go on", config: CONFIG })).rejects.toMatchObject({ code: HelperErrorCode.sessionEnded });
  });
});
