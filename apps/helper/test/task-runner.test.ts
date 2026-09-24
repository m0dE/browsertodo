import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimResponse, RunConfig, Task } from "@browsertodo/shared";
import { TaskRunner, type TaskRunnerDeps } from "../src/task-runner.js";
import { ToolRouter } from "../src/tool-router.js";
import { ScriptedBrain, extractPostText, extractStartUrl } from "../src/brains/scripted.js";
import type { Brain, BrainContext } from "../src/brains/brain.js";
import { buildClaudeArgs, claudeEnv, resolveClaudePath } from "../src/brains/claude-code.js";
import { downloadMedia, sanitizeFilename } from "../src/media.js";
import { buildSystemPrompt, buildTaskPrompt } from "../src/system-prompt.js";
import { FakeX } from "./fake-x.js";
import { makeTask } from "./fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const claimOf = (task: Task, media: ClaimResponse["media"] = []): ClaimResponse => ({ task, media, leaseExpiresAt: task.leaseExpiresAt! });

const CONFIG: RunConfig = { apiBase: "http://api.test", runnerKey: "rk", maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8 };

const noSleep = async () => {};

function setup(x: FakeX, over: Partial<TaskRunnerDeps> & { brain?: (router: ToolRouter) => Brain } = {}) {
  let runner!: TaskRunner;
  const router = new ToolRouter({ browser: x.caller(), getSession: () => runner.session(), sleep: noSleep, switchConfirmTimeoutMs: 50 });
  runner = new TaskRunner({
    runsDir: join(dir, "runs"),
    mcpServerPath: "C:\\helper\\dist\\mcp-server.js",
    pipePath: "\\\\.\\pipe\\browsertodo-test",
    jevAvailable: true,
    makeBrain: () => (over.brain ? over.brain(router) : new ScriptedBrain((t, n, a) => router.call(t, n, a), { sleep: noSleep, pollMs: 0 })),
    download: async ({ media, dir: mediaDir }) =>
      media.map((m) => {
        const p = join(mediaDir, m.filename);
        writeFileSync(p, "img");
        return p;
      }),
    ...over,
  });
  return { runner, router };
}

/** A brain that runs `steps` then waits until aborted. */
function customBrain(steps: (ctx: BrainContext) => Promise<void>, hang = false): Brain {
  return {
    run: async (ctx) => {
      await steps(ctx);
      if (hang) await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
    },
  };
}

describe("TaskRunner with ScriptedBrain", () => {
  it("posts, switching account and attaching media, and completes with the post URL", async () => {
    const x = new FakeX({ account: "alice" });
    const { runner } = setup(x);
    const task = makeTask({ account: "@bob", instructions: "Open https://x.com/compose/post and publish. Post: gm from bob", mediaIds: ["m1"] });
    const result = await runner.run(claimOf(task, [{ id: "m1", filename: "cat.png", contentType: "image/png", size: 3 }]), CONFIG);
    expect(result).toMatchObject({ outcome: "done", url: "https://x.com/bob/status/1000", summary: "Posted: gm from bob" });
    expect(x.posts).toHaveLength(1);
    expect(x.posts[0]).toMatchObject({ account: "bob", text: "gm from bob" });
    expect(x.posts[0]!.files[0]).toMatch(/media[\\/]cat\.png$/);
    expect(runner.busy).toBe(false);
    // run folder with log + MCP config
    expect(existsSync(result.logPath!)).toBe(true);
    const events = readFileSync(result.logPath!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "done" });
    expect(events.some((e) => e.type === "tool_call" && e.name === "switch_x_account")).toBe(true);
  });

  it("writes the MCP config and drops act when Jev is off", async () => {
    const x = new FakeX();
    let seen: BrainContext | undefined;
    const { runner } = setup(x, { brain: () => customBrain(async (ctx) => void (seen = ctx)) });
    await runner.run(claimOf(makeTask()), { ...CONFIG, jevEnabled: false });
    const cfg = JSON.parse(readFileSync(seen!.mcpConfigPath, "utf8"));
    expect(cfg).toEqual({
      mcpServers: {
        browsertodo: {
          command: process.execPath,
          args: ["C:\\helper\\dist\\mcp-server.js"],
          env: { BROWSERTODO_PIPE: "\\\\.\\pipe\\browsertodo-test", BROWSERTODO_TASK: "01TASK", BROWSERTODO_TOOLS: expect.any(String) },
        },
      },
    });
    expect(cfg.mcpServers.browsertodo.env.BROWSERTODO_TOOLS.split(",")).not.toContain("act");
    expect(seen!.allowedTools).toContain("mcp__browsertodo__task_complete");
    expect(seen!.allowedTools).not.toContain("mcp__browsertodo__act");
    expect(seen!.systemPrompt).not.toContain("mcp__browsertodo__act");
    expect(seen!.prompt).toContain("Post: hello from browsertodo");
  });

  it("offers act only when Jev is enabled and a key exists", async () => {
    const x = new FakeX();
    const seen: string[][] = [];
    const brain = () => customBrain(async (ctx) => void seen.push(ctx.allowedTools));
    await setup(x, { brain }).runner.run(claimOf(makeTask()), CONFIG);
    await setup(x, { brain, jevAvailable: false }).runner.run(claimOf(makeTask()), CONFIG);
    expect(seen[0]).toContain("mcp__browsertodo__act");
    expect(seen[1]).not.toContain("mcp__browsertodo__act");
  });

  it("pauses on a login page", async () => {
    const x = new FakeX({ url: "https://x.com/i/flow/login" });
    const { runner } = setup(x);
    const r = await runner.run(claimOf(makeTask()), CONFIG);
    expect(r).toMatchObject({ outcome: "paused", reason: "X is asking to log in" });
  });

  it("pauses when the account cannot be switched to", async () => {
    const x = new FakeX({ accounts: ["alice"] });
    const r = await setup(x).runner.run(claimOf(makeTask({ account: "@zed" })), CONFIG);
    expect(r.outcome).toBe("paused");
    expect(r.reason).toMatch(/Could not switch to @zed/);
    expect(x.posts).toHaveLength(0);
  });

  it("rejects a second task while busy", async () => {
    const x = new FakeX();
    const { runner } = setup(x, { brain: () => customBrain(async () => {}, true) });
    const first = runner.run(claimOf(makeTask()), CONFIG);
    await expect(runner.run(claimOf(makeTask({ id: "02" })), CONFIG)).rejects.toThrow("busy");
    runner.abort("01TASK", "test over");
    expect(await first).toMatchObject({ outcome: "failed", reason: "test over" });
  });

  it("forcePause wins over a task_* result", async () => {
    const x = new FakeX();
    let router!: ToolRouter;
    const { runner } = setup(x, {
      brain: (r) => {
        router = r;
        return customBrain(async (ctx) => {
          await router.call(ctx.taskId, "task_complete", { summary: "done" });
          setTimeout(() => runner.forcePause(ctx.taskId, "login page appeared"), 10);
        }, true);
      },
    });
    const r = await runner.run(claimOf(makeTask()), CONFIG);
    expect(r).toMatchObject({ outcome: "paused", reason: "login page appeared" });
  });

  it("fails at the time limit", async () => {
    const x = new FakeX();
    const { runner } = setup(x, { brain: () => customBrain(async () => {}, true) });
    const r = await runner.run(claimOf(makeTask()), { ...CONFIG, maxTaskMinutes: 0.001 });
    expect(r).toMatchObject({ outcome: "failed", reason: "timed out after 0.001 minutes" });
  });

  it("fails when the agent exits without a result", async () => {
    const x = new FakeX();
    const { runner } = setup(x, { brain: () => customBrain(async () => {}) });
    expect(await runner.run(claimOf(makeTask()), CONFIG)).toMatchObject({ outcome: "failed", reason: "agent exited without reporting a result" });
  });

  it("reports brain crashes", async () => {
    const x = new FakeX();
    const { runner } = setup(x, { brain: () => ({ run: async () => Promise.reject(new Error("spawn ENOENT")) }) });
    expect(await runner.run(claimOf(makeTask()), CONFIG)).toMatchObject({ outcome: "failed", reason: "agent error: spawn ENOENT" });
  });

  it("fails when media cannot be downloaded", async () => {
    const x = new FakeX();
    const { runner } = setup(x, {
      download: async () => {
        throw new Error("media m1 download failed: HTTP 404");
      },
    });
    const r = await runner.run(claimOf(makeTask(), [{ id: "m1", filename: "a.png", contentType: "image/png", size: 1 }]), CONFIG);
    expect(r).toMatchObject({ outcome: "failed", reason: "media download failed: media m1 download failed: HTTP 404" });
  });

  it("aborts the agent 20 s (grace) after the first task_* call", async () => {
    const x = new FakeX();
    let router!: ToolRouter;
    let aborted = false;
    const { runner } = setup(x, {
      finishGraceMs: 30,
      brain: (r) => {
        router = r;
        return customBrain(async (ctx) => {
          await router.call(ctx.taskId, "task_fail", { reason: "cannot" });
          ctx.signal.addEventListener("abort", () => (aborted = true));
        }, true);
      },
    });
    expect(await runner.run(claimOf(makeTask()), CONFIG)).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(aborted).toBe(true);
  });

  it("enforces the tool call limit: errors past the max, abort at max + 5", async () => {
    const x = new FakeX();
    const texts: (string | undefined)[] = [];
    const { runner } = setup(x, {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 20 && !ctx.signal.aborted; i++) texts.push((await router.call(ctx.taskId, "read_page", {})).text);
        }),
    });
    const r = await runner.run(claimOf(makeTask()), { ...CONFIG, maxToolCalls: 3 });
    expect(texts.slice(0, 3).every((t) => t?.startsWith("URL:"))).toBe(true);
    expect(texts[3]).toBe("Tool call limit of 3 reached. Call task_fail now with a short reason.");
    expect(texts).toHaveLength(8);
    expect(r).toMatchObject({ outcome: "failed", reason: "tool call limit exceeded (3 calls)" });
  });

  it("still accepts task_fail past the tool call limit", async () => {
    const x = new FakeX();
    const { runner } = setup(x, {
      brain: (router) =>
        customBrain(async (ctx) => {
          for (let i = 0; i < 4; i++) await router.call(ctx.taskId, "read_page", {});
          await router.call(ctx.taskId, "task_fail", { reason: "too many steps" });
        }),
    });
    expect(await runner.run(claimOf(makeTask()), { ...CONFIG, maxToolCalls: 3 })).toMatchObject({ outcome: "failed", reason: "too many steps" });
  });

  it("saves screenshots beside the log", async () => {
    const x = new FakeX();
    const { runner } = setup(x, {
      brain: (router) =>
        customBrain(async (ctx) => {
          await router.call(ctx.taskId, "screenshot", {});
          await router.call(ctx.taskId, "task_complete", { summary: "ok" });
        }),
    });
    const r = await runner.run(claimOf(makeTask()), CONFIG);
    const runDir = join(r.logPath!, "..");
    expect(readdirSync(runDir)).toContain("screenshot-001.jpg");
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

describe("ClaudeCodeBrain", () => {
  it("builds the exact claude arguments", () => {
    expect(
      buildClaudeArgs({
        prompt: "do it",
        systemPrompt: "rules",
        mcpConfigPath: "C:\\run\\mcp-config.json",
        allowedTools: ["mcp__browsertodo__click", "mcp__browsertodo__task_complete"],
        model: "sonnet",
      }),
    ).toEqual([
      "-p",
      "do it",
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
    const env = claudeEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", BROWSERTODO_BRAIN: "scripted" });
    expect(env).toEqual({ PATH: "p" });
  });
});

describe("media", () => {
  it("sanitizes filenames and keeps the extension", () => {
    expect(sanitizeFilename("cat.png", "m1")).toBe("cat.png");
    expect(sanitizeFilename("..\\..\\evil:name?.JPG", "m1")).toBe("evil_name_.JPG");
    expect(sanitizeFilename("con.png", "m1")).toBe("m1_con.png");
    expect(sanitizeFilename(".png", "m1")).toBe("m1.png");
  });

  it("downloads with the runner key and reports HTTP errors", async () => {
    const seen: [string, any][] = [];
    const fetchImpl = (async (url: string, init: any) => {
      seen.push([url, init]);
      if (url.endsWith("/bad")) return new Response("no", { status: 404 });
      return new Response("PNGDATA", { status: 200 });
    }) as unknown as typeof fetch;
    const media = [
      { id: "m1", filename: "a.png", contentType: "image/png", size: 7 },
      { id: "m2", filename: "a.png", contentType: "image/png", size: 7 },
    ];
    const paths = await downloadMedia({ apiBase: "http://api.test/", runnerKey: "rk", media, dir, fetchImpl });
    expect(seen[0]![0]).toBe("http://api.test/v1/media/m1");
    expect(seen[0]![1].headers.Authorization).toBe("Bearer rk");
    expect(paths[0]).toBe(join(dir, "a.png"));
    expect(paths[1]).toBe(join(dir, "a-m2.png"));
    expect(readFileSync(paths[0]!, "utf8")).toBe("PNGDATA");
    await expect(
      downloadMedia({ apiBase: "http://api.test", runnerKey: "rk", media: [{ id: "bad", filename: "x.png", contentType: "", size: 0 }], dir, fetchImpl }),
    ).rejects.toThrow("media bad download failed: HTTP 404");
  });
});

describe("prompts", () => {
  it("lists tools and the key rules", () => {
    const withJev = buildSystemPrompt({ allowedTools: ["act", "click", "task_complete"] });
    expect(withJev).toContain("mcp__browsertodo__act");
    expect(withJev).toMatch(/Prefer act/);
    expect(withJev).toMatch(/untrusted/);
    expect(withJev).toMatch(/Never type a password for X/);
    const noJev = buildSystemPrompt({ allowedTools: ["click"] });
    expect(noJev).not.toMatch(/Prefer act/);
  });

  it("includes instructions, account and absolute media paths", () => {
    const p = buildTaskPrompt(makeTask({ account: "@bob" }), ["C:\\runs\\m\\a.png"]);
    expect(p).toContain("Account: @bob");
    expect(p).toContain("Post: hello from browsertodo");
    expect(p).toContain("- C:\\runs\\m\\a.png");
  });
});
