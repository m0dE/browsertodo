import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@browsertodo/shared";
import { ClaudeCodeBrain, buildClaudeArgs } from "../src/brains/claude-code.js";
import { claudeEnv, resolveClaudePath } from "../src/claude-process.js";
import { UserInput, type BrainContext } from "../src/brains/brain.js";
import { SelfTestCache, parseSelfTestOutput, runSelfTest, selfTestArgs } from "../src/self-test.js";

const SUPPORT = join(dirname(fileURLToPath(import.meta.url)), "support");
const FAKE = join(SUPPORT, "fake-claude.mjs");

let dir: string;
const saved = { CLAUDECODE: process.env.CLAUDECODE, CHILD: process.env.CLAUDE_CODE_CHILD_SESSION };
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bt-claude-")));
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env.FAKE_CLAUDE_SLOW_MS;
  delete process.env.FAKE_CLAUDE_PARTIAL;
  for (const [k, v] of [["CLAUDECODE", saved.CLAUDECODE], ["CLAUDE_CODE_CHILD_SESSION", saved.CHILD]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function ctx(signal: AbortSignal, log: Record<string, any>[], events: AgentEvent[], input = new UserInput()): BrainContext {
  return {
    taskId: "S1",
    prompt: 'Line one\nLine "two" with \\ backslash and trailing \\',
    systemPrompt: "rules & <stuff> | %PATH%",
    mcpConfigPath: join(dir, "mcp-config.json"),
    allowedTools: ["mcp__browsertodo__read_page", "mcp__browsertodo__task_complete"],
    signal,
    log: (e) => log.push(e),
    emit: (e) => events.push(e),
    input,
  };
}

const brain = () => new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE] });

describe("ClaudeCodeBrain process handling (fake claude)", () => {
  it("passes the exact args, sends the prompt as the first stream-json message, maps events, and exits when all turns are done", async () => {
    process.env.CLAUDECODE = "1"; // must not leak into the child
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = ctx(new AbortController().signal, log, events);
    await brain().run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet" }));
    expect(init.cwd).toBe(dir);
    expect(init.nested).toBeNull();
    expect(init.child).toBeNull();
    expect(log.find((e) => e.type === "claude_stdout")).toEqual({ type: "claude_stdout", text: "not json" });
    expect(events).toEqual([
      { type: "status", text: "Claude Code started (sonnet)" },
      { type: "assistant_text", text: `got: ${c.prompt}` },
    ]);
    expect(c.input.closed).toBe(true);
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("streams text deltas in batches, then the final text with the same id; the run log keeps only the final text", async () => {
    process.env.FAKE_CLAUDE_PARTIAL = "1";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = { ...ctx(new AbortController().signal, log, events), prompt: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty" };
    await brain().run(c);
    const deltas = events.filter((e) => e.type === "assistant_text_delta") as Extract<AgentEvent, { type: "assistant_text_delta" }>[];
    const final = events.find((e) => e.type === "assistant_text") as Extract<AgentEvent, { type: "assistant_text" }>;
    expect(final).toEqual({ type: "assistant_text", text: `got: ${c.prompt}`, id: "msg_fake_1:0" });
    // 22 word deltas over >100 ms arrive batched: more than one, far fewer than 22.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThan(15);
    expect(deltas.every((d) => d.id === "msg_fake_1:0")).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe(final.text);
    expect(events.indexOf(final)).toBe(events.length - 1);
    expect(log.some((e) => e.type === "claude" && e.event.type === "stream_event")).toBe(false);
    expect(log.some((e) => e.type === "claude" && e.event.type === "assistant")).toBe(true);
  });

  it("runs the model chosen in the extension (ctx.model) instead of its default", async () => {
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const c = { ...ctx(new AbortController().signal, log, events), model: "claude-opus-5-5" };
    await brain().run(c);
    const init = log.find((e) => e.type === "claude" && e.event.type === "system")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "claude-opus-5-5" }));
    expect(log.find((e) => e.type === "claude_start")).toMatchObject({ model: "claude-opus-5-5" });
    expect(events[0]).toEqual({ type: "status", text: "Claude Code started (claude-opus-5-5)" });
  });

  it("injects user messages mid-turn into the same session", async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = "150";
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const input = new UserInput();
    const run = brain().run(ctx(new AbortController().signal, log, events, input));
    // Claude Code is up (its init line came) and still answering the first message.
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude")).toBe(true));
    expect(input.push("also add a hashtag")).toBe(true);
    await run;
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe("got: Message from the human (they are watching this run): also add a hashtag");
  });

  it("closing the input (task_* called) ends stdin so claude exits", async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = "300";
    const log: Record<string, any>[] = [];
    const input = new UserInput();
    const run = brain().run(ctx(new AbortController().signal, log, [], input));
    setTimeout(() => input.close(), 20);
    await run;
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("persistent: keeps stdin open after the turn (idle), sends follow-ups as-is, exits when the input closes", async () => {
    const log: Record<string, any>[] = [];
    const events: AgentEvent[] = [];
    const input = new UserInput();
    let idle = 0;
    const c = { ...ctx(new AbortController().signal, log, events, input), idle: () => idle++ };
    const persistent = new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE], persistent: true });
    expect(persistent.persistent).toBe(true);
    const run = persistent.run(c);
    await vi.waitFor(() => expect(idle).toBe(1), { timeout: 10_000 });
    expect(input.closed).toBe(false);
    input.push("Next message from the user: like it", "followup");
    await vi.waitFor(() => expect(idle).toBe(2), { timeout: 10_000 });
    input.close();
    await run;
    const texts = events.filter((e) => e.type === "assistant_text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual([`got: ${c.prompt}`, "got: Next message from the user: like it"]);
    // Claude Code repeats its init event every turn; "started" shows once.
    expect(events.filter((e) => e.type === "status")).toEqual([{ type: "status", text: "Claude Code started (sonnet)" }]);
    expect(log.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("kills the process tree on abort", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    const log: Record<string, any>[] = [];
    const ac = new AbortController();
    const run = brain().run(ctx(ac.signal, log, []));
    await vi.waitFor(() => expect(log.some((e) => e.type === "claude")).toBe(true), { timeout: 10_000 });
    ac.abort(new Error("time limit"));
    await run;
    expect(log.some((e) => e.type === "claude_kill")).toBe(true);
    expect(log.at(-1)?.type).toBe("claude_exit");
  });

  it("rejects when claude cannot be started", async () => {
    await expect(
      new ClaudeCodeBrain({ claudePath: join(dir, "missing.exe"), model: "sonnet" }).run(ctx(new AbortController().signal, [], [])),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("self-test", () => {
  const script = (body: string) => {
    const p = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    return p;
  };

  it("uses a one-turn headless call with no tools or settings", () => {
    expect(selfTestArgs()).toEqual(["-p", "Reply with exactly: OK", "--output-format", "json", "--tools", "", "--setting-sources", "", "--no-session-persistence", "--model", "haiku"]);
  });

  it("parses json output", () => {
    expect(parseSelfTestOutput('{"type":"result","subtype":"success","is_error":false,"result":"OK"}', "", 0)).toEqual({ ok: true });
    expect(parseSelfTestOutput('{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}', "", 1)).toEqual({
      ok: false,
      error: "Claude Code error: Invalid API key · Please run /login",
    });
    expect(parseSelfTestOutput("", "boom", 3)).toEqual({ ok: false, error: "Claude Code exited with code 3: boom" });
  });

  it("runs a fake claude: ok, error, and timeout", async () => {
    const ok = script(`process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "OK", args: process.argv.slice(2) }))`);
    const r = await runSelfTest({ claudePath: process.execPath, prefixArgs: [ok] });
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe("number");
    const bad = script(`process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" })); process.exit(1)`);
    expect(await runSelfTest({ claudePath: process.execPath, prefixArgs: [bad] })).toMatchObject({ ok: false, error: "Claude Code error: Not logged in" });
    const hang = script(`setInterval(() => {}, 1000)`);
    expect(await runSelfTest({ claudePath: process.execPath, prefixArgs: [hang], timeoutMs: 300 })).toMatchObject({
      ok: false,
      error: "Self-test timed out after 0 s",
    });
  });

  it("caches in memory and on disk; scripted is always ok; missing claude fails", async () => {
    let runs = 0;
    const cacheFile = join(dir, "selftest.json");
    const run = async () => (runs++, { ok: true, ms: 5, at: new Date().toISOString() });
    const a = new SelfTestCache({ brain: "claude", claudePath: "C:\\claude.exe", cacheFile, run });
    await a.get();
    await a.get();
    expect(runs).toBe(1);
    const b = new SelfTestCache({ brain: "claude", claudePath: "C:\\claude.exe", cacheFile, run });
    expect(b.cached?.ok).toBe(true);
    await b.get();
    expect(runs).toBe(1);
    await b.get(true);
    expect(runs).toBe(2);
    // a different claude path does not reuse the cache
    expect(new SelfTestCache({ brain: "claude", claudePath: "D:\\other.exe", cacheFile, run }).cached).toBeUndefined();
    expect((await new SelfTestCache({ brain: "scripted", claudePath: null, cacheFile }).get()).ok).toBe(true);
    expect(await new SelfTestCache({ brain: "claude", claudePath: null, cacheFile: null }).get()).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
  });
});

describe("Claude Code executable", () => {
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
