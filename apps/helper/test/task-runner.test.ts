import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTask, RunConfig } from "@browsertodo/shared";
import { createToolExecutor, type JevLike } from "@browsertodo/core";
import { TaskRunner, type RunTaskParams, type TaskRunnerDeps } from "../src/task-runner.js";
import { ToolRouter, INTERACTIVE_TASK_ID } from "../src/tool-router.js";
import { ScriptedBrain, extractPostText, extractStartUrl } from "../src/brains/scripted.js";
import type { Brain, BrainContext } from "../src/brains/brain.js";
import { UserInput } from "../src/brains/brain.js";
import { buildClaudeArgs, claudeEnv, mapStreamEvent, resolveClaudePath, userMessageLine } from "../src/brains/claude-code.js";
import { FakeX } from "./fake-x.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
const noSleep = async () => {};
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
  const router = new ToolRouter({ getSession: () => runner.session() });
  runner = new TaskRunner({
    runsDir: join(dir, "runs"),
    mcpServerPath: "C:\\helper\\dist\\mcp-server.js",
    pipePath: "\\\\.\\pipe\\browsertodo-test",
    browser: x.caller(),
    envJevKey: "env-key",
    makeJev: () => fakeJev,
    makeBrain: () => (over.brain ? over.brain(router) : new ScriptedBrain((t, n, a) => router.call(t, n, a), { sleep: noSleep, pollMs: 0 })),
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
          env: { BROWSERTODO_PIPE: "\\\\.\\pipe\\browsertodo-test", BROWSERTODO_TASK: "S1", BROWSERTODO_TOOLS: expect.any(String) },
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

  it("rejects a second task while busy; abort is keyed by sessionId", async () => {
    const { runner } = setup(new FakeX(), { brain: () => customBrain(async () => {}, "abort") });
    const first = runner.run(params());
    await expect(runner.run(params({}, { sessionId: "S2" }))).rejects.toThrow("busy");
    expect(runner.abort("S2", "wrong session")).toBe(false);
    runner.abort("S1", "test over");
    expect(await first).toMatchObject({ outcome: "failed", reason: "test over" });
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
    expect(r).toMatchObject({ outcome: "failed", reason: "task time limit of 0.001 minutes reached" });
  });

  it("fails when the agent exits without a result, or with the last Claude error", async () => {
    expect(await setup(new FakeX(), { brain: () => customBrain(async () => {}) }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: "agent exited without reporting a result",
    });
    const limited = customBrain(async (ctx) => ctx.emit({ type: "error", text: "Claude Code: Claude AI usage limit reached" }));
    expect(await setup(new FakeX(), { brain: () => limited }).runner.run(params())).toMatchObject({
      outcome: "failed",
      reason: "Claude Code: Claude AI usage limit reached",
    });
  });

  it("reports brain crashes", async () => {
    const { runner } = setup(new FakeX(), { brain: () => ({ run: async () => Promise.reject(new Error("spawn ENOENT")) }) });
    expect(await runner.run(params())).toMatchObject({ outcome: "failed", reason: "agent error: spawn ENOENT" });
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
    const slow = { call: async (m: any, p: any) => (m === "browser.readPage" ? await gate : undefined, x.handle(m, p)) };
    const { runner, events } = setup(x, { browser: slow as any });
    const run = runner.run(params());
    await new Promise((r) => setTimeout(r, 20));
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
    expect(r).toMatchObject({ outcome: "failed", reason: "tool call limit exceeded (3 calls)" });
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

describe("ToolRouter", () => {
  it("routes by task id, refuses unknown tasks and tools, and serves the interactive executor", async () => {
    const x = new FakeX();
    const interactiveExec = createToolExecutor({ browser: x.caller(), jev: null, jevThreshold: 0.8, onEvent: () => {}, mediaPaths: [] });
    const router = new ToolRouter({
      getSession: () => null,
      getInteractive: () => ({ allowedTools: new Set(["read_page", "task_complete"]), executor: interactiveExec }),
    });
    expect((await router.call("S9", "read_page", {})).text).toMatch(/No running task S9/);
    expect((await router.call(INTERACTIVE_TASK_ID, "read_page", {})).text).toContain("URL:");
    expect((await router.call(INTERACTIVE_TASK_ID, "click", { index: 1 })).text).toMatch(/not available in the interactive terminal/);
    // task_* in interactive mode: the executor has no onTaskEnd
    expect((await router.call(INTERACTIVE_TASK_ID, "task_complete", { summary: "x" })).text).toMatch(/no task to end in the interactive terminal/);
    expect(router.allowedTools(INTERACTIVE_TASK_ID)).toEqual(["read_page", "task_complete"]);
  });
});

describe("UserInput", () => {
  it("queues until subscribed, and refuses after close", () => {
    const input = new UserInput();
    expect(input.push("a")).toBe(true);
    const got: string[] = [];
    input.onMessage((t) => got.push(t));
    input.push("b");
    let closed = 0;
    input.onClose(() => closed++);
    input.close();
    input.close();
    expect(input.push("c")).toBe(false);
    expect(got).toEqual(["a", "b"]);
    expect(closed).toBe(1);
  });
});

describe("ScriptedBrain helpers", () => {
  it("extracts the post text and the start URL", () => {
    expect(extractPostText("Go to the site. Post: hi there ")).toBe("hi there");
    expect(extractPostText("just this")).toBe("just this");
    expect(extractStartUrl("Open http://localhost:8787/compose. Post: see https://ex.com")).toBe("http://localhost:8787/compose");
    expect(extractStartUrl("Post: see https://ex.com")).toBeNull();
    expect(extractStartUrl("no url")).toBeNull();
  });
});

describe("ClaudeCodeBrain helpers", () => {
  it("builds the exact claude arguments (stream-json in and out, prompt on stdin)", () => {
    expect(
      buildClaudeArgs({
        systemPrompt: "rules",
        mcpConfigPath: "C:\\run\\mcp-config.json",
        allowedTools: ["mcp__browsertodo__click", "mcp__browsertodo__task_complete"],
        model: "sonnet",
      }),
    ).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      "C:\\run\\mcp-config.json",
      "--allowedTools",
      "mcp__browsertodo__click,mcp__browsertodo__task_complete",
      "--append-system-prompt",
      "rules",
      "--no-session-persistence",
      "--model",
      "sonnet",
    ]);
    expect(userMessageLine('say "hi"\nnow')).toBe('{"type":"user","message":{"role":"user","content":"say \\"hi\\"\\nnow"}}\n');
  });

  it("maps stream-json events to AgentEvents (no tool events)", () => {
    expect(
      mapStreamEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "Opening the composer." }, { type: "tool_use", id: "x", name: "mcp__browsertodo__act", input: {} }] },
      }),
    ).toEqual([{ type: "assistant_text", text: "Opening the composer." }]);
    expect(mapStreamEvent({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: false, result: "done" })).toEqual([]);
    expect(mapStreamEvent({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|123" })).toEqual([
      { type: "error", text: "Claude Code: Claude AI usage limit reached|123" },
    ]);
    expect(mapStreamEvent({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([{ type: "error", text: "Claude Code: error_max_turns" }]);
    expect(mapStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5" })).toEqual([{ type: "status", text: "Claude Code started (claude-sonnet-5)" }]);
  });

  it("resolves claude from the override, then PATH (.exe only on Windows), then ~/.local/bin", () => {
    expect(resolveClaudePath({ BROWSERTODO_CLAUDE_PATH: "D:\\c.exe" })).toBe("D:\\c.exe");
    const exe = process.platform === "win32" ? "C:\\bin\\claude.exe" : "/bin/claude";
    expect(resolveClaudePath({}, { where: () => `C:\\bin\\claude\r\n${exe}\r\n`, exists: (p) => p === exe })).toBe(exe);
    const fallback = join("C:\\Users\\me", ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    expect(
      resolveClaudePath({ USERPROFILE: "C:\\Users\\me" }, { where: () => { throw new Error("none"); }, exists: (p) => p === fallback }),
    ).toBe(fallback);
    expect(resolveClaudePath({ USERPROFILE: "C:\\x" }, { where: () => "", exists: () => false })).toBeNull();
  });

  it("strips nested-session variables from the child env", () => {
    const env = claudeEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_CHILD_SESSION: "1", BROWSERTODO_BRAIN: "scripted" });
    expect(env).toEqual({ PATH: "p" });
  });
});
