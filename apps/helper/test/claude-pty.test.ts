import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunConfig } from "@browsertodo/shared";
import type { JevLike } from "@browsertodo/core";
import { FOLLOW_UP_PREFIX, FOLLOW_UP_PROMPT, IDLE_TURN_REASON, TaskRunner, taskTitle, type TaskRunnerDeps } from "../src/task-runner.js";
import { ToolRouter } from "../src/tool-router.js";
import { buildInteractiveArgs, ClaudePtyBrain, NUDGE, typedLine, type ClaudePtyOptions } from "../src/brains/claude-pty.js";
import type { TaskTerminal, TaskTerminalSpec } from "../src/terminal.js";
import { TRUST_REASON, PERMISSION_REASON } from "../src/terminal-responder.js";
import { FakeX } from "./fake-x.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-pty-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: false, jevThreshold: 0.8, isRetry: false };
const fakeJev: JevLike = { decide: async () => ({ operation: "blocked", index: null, confidence: 0 }) };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A task terminal that records what is typed; the test drives its output and exit. */
class FakeTerminal implements TaskTerminal {
  static seq = 0;
  readonly terminalId = `task-${++FakeTerminal.seq}`;
  readonly pid = 777;
  written: string[] = [];
  killed = 0;
  exited = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((c: number | null) => void)[] = [];
  /** Exit when "/exit" + Enter is typed (like Claude Code). */
  constructor(private readonly exitOnSlashExit = true) {}
  write(data: string) {
    this.written.push(data);
    if (this.exitOnSlashExit && data === "\r" && this.written.at(-2) === "/exit") setTimeout(() => this.exit(0), 1);
  }
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCbs.push(cb);
  }
  kill() {
    this.killed++;
    this.exit(null);
  }
  output(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code);
  }
  /** Typed lines (text followed by Enter). */
  get lines(): string[] {
    return this.written.filter((w, i) => w !== "\r" && this.written[i + 1] === "\r");
  }
}

function setup(opts: Partial<ClaudePtyOptions> & { exitOnSlashExit?: boolean } = {}, deps: Partial<TaskRunnerDeps> = {}) {
  const specs: TaskTerminalSpec[] = [];
  const terms: FakeTerminal[] = [];
  const events: AgentEvent[] = [];
  let runner!: TaskRunner;
  const router = new ToolRouter({ getSession: (id) => runner.session(id) });
  runner = new TaskRunner({
    runsDir: join(dir, "runs"),
    mcpServerPath: "C:\\helper\\dist\\mcp-server.js",
    pipePath: "\\\\.\\pipe\\bt-test",
    browser: new FakeX().caller(),
    envJevKey: null,
    makeJev: () => fakeJev,
    makeBrain: () =>
      new ClaudePtyBrain({
        claudePath: "C:\\bin\\claude.exe",
        model: "sonnet",
        cwd: "C:\\ws",
        terminals: {
          openTask: (spec) => {
            specs.push(spec);
            const t = new FakeTerminal(opts.exitOnSlashExit ?? true);
            terms.push(t);
            return t;
          },
        },
        finishDelayMs: 20,
        exitKillMs: 60,
        enterDelayMs: 1,
        ...opts,
      }),
    notify: (_s, e) => events.push(e),
    finishGraceMs: 2000,
    abortWaitMs: 500,
    ...deps,
  });
  const run = (instructions = "Post: hello\nsecond line", config: RunConfig = CONFIG, sessionId = "S1") =>
    runner.run({ sessionId, task: { id: "T1", instructions, account: null }, mediaPaths: [], config });
  return { runner, router, terms, get term() { return terms[0]!; }, specs, events, run };
}

describe("ClaudePtyBrain", () => {
  it("builds the interactive arguments with the prompt last", () => {
    expect(
      buildInteractiveArgs({
        systemPrompt: "rules",
        mcpConfigPath: "C:\\run\\mcp-config.json",
        allowedTools: ["mcp__browsertodo__read_page", "mcp__browsertodo__task_complete"],
        model: "sonnet",
        prompt: "Do the task",
      }),
    ).toEqual([
      "--mcp-config",
      "C:\\run\\mcp-config.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__browsertodo__read_page,mcp__browsertodo__task_complete",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--append-system-prompt",
      "rules",
      "--model",
      "sonnet",
      "Do the task",
    ]);
    expect(typedLine(" line one\r\nline two\n")).toBe("line one line two");
    expect(taskTitle("\n  Post: hello  \nmore")).toBe("Post: hello");
    expect(taskTitle("x".repeat(100))).toHaveLength(80);
  });

  it("opens a task terminal with the args, workspace cwd, clean env and title; the session stays open after task_*", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const t = setup();
    const run = t.run(undefined, { ...CONFIG, model: "claude-opus-5-5" });
    await wait(10);
    const spec = t.specs[0]!;
    expect(spec.title).toBe("Post: hello");
    expect(spec.sessionId).toBe("S1");
    expect(spec.file).toBe("C:\\bin\\claude.exe");
    expect(spec.cwd).toBe("C:\\ws");
    expect(spec.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spec.env.CLAUDECODE).toBeUndefined();
    expect(spec.args.slice(0, 2)).toEqual(["--mcp-config", expect.stringMatching(/mcp-config\.json$/)]);
    expect(spec.args.slice(-3)).toEqual(["--model", "claude-opus-5-5", expect.stringContaining("Post: hello")]);
    expect(spec.args[spec.args.indexOf("--allowedTools") + 1]).toContain("mcp__browsertodo__task_complete");
    // Kept-open sessions are told about follow-ups.
    expect(spec.args[spec.args.indexOf("--append-system-prompt") + 1]).toContain(FOLLOW_UP_PROMPT);
    t.term.output("\x1b[1C● Opening the composer…");
    expect((await t.router.call("S1", "task_complete", { summary: "posted" })).isError).toBeFalsy();
    const result = await run;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    expect(result).toMatchObject({ outcome: "done", summary: "posted" });
    await wait(50);
    expect(t.term.written).toEqual([]);
    expect(t.term.killed).toBe(0);
    expect(t.runner.openSessions).toEqual(["S1"]);
    expect(t.runner.busy).toBe(false);
    expect(t.events[0]).toEqual({ type: "status", text: "Claude Code is running in the Terminal tab (claude-opus-5-5)" });
    expect(t.events.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "posted" });
    // An idle session refuses tools until its next turn.
    expect((await t.router.call("S1", "read_page", {})).text).toMatch(/No task is running in this session/);
    // The raw transcript is kept beside the log.
    expect(readFileSync(join(result.logPath!, "..", "terminal.log"), "utf8")).toContain("Opening the composer");
    t.runner.endSession("S1");
    await wait(80);
    expect(t.term.lines).toEqual(["/exit"]);
    expect(t.runner.openSessions).toEqual([]);
  });

  it("continueSession types the follow-up into the same session and resolves on the next task_* call", async () => {
    const t = setup();
    const first = t.run();
    await wait(5);
    await t.router.call("S1", "task_complete", { summary: "posted" });
    expect(await first).toMatchObject({ outcome: "done" });
    const next = t.runner.continueSession({ sessionId: "S1", text: "now like it\ntoo", config: { ...CONFIG, maxToolCalls: 2 } });
    expect(t.runner.busy).toBe(true);
    await expect(t.run(undefined, CONFIG, "S2")).rejects.toThrow("busy");
    await wait(10);
    expect(t.term.lines).toEqual([`${FOLLOW_UP_PREFIX}now like it too`]);
    // Fresh limits for the turn.
    expect((await t.router.call("S1", "read_page", {})).isError).toBeFalsy();
    expect((await t.router.call("S1", "read_page", {})).isError).toBeFalsy();
    expect((await t.router.call("S1", "read_page", {})).text).toMatch(/Tool call limit of 2 reached/);
    await t.router.call("S1", "task_complete", { summary: "liked" });
    expect(await next).toMatchObject({ outcome: "done", summary: "liked" });
    expect(t.specs).toHaveLength(1);
    const texts = t.events.filter((e) => e.type === "user_message" || e.type === "task_end").map((e) => e.type);
    expect(texts).toEqual(["task_end", "user_message", "task_end"]);
    expect(t.term.killed).toBe(0);
  });

  it("continueSession throws 'session ended' once the session is gone, and for unknown sessions", async () => {
    const t = setup();
    await expect(t.runner.continueSession({ sessionId: "nope", text: "hi", config: CONFIG })).rejects.toThrow("session ended");
    const run = t.run();
    await wait(5);
    await t.router.call("S1", "task_complete", { summary: "ok" });
    await run;
    t.term.exit(0); // e.g. the user typed /exit in the terminal
    await wait(5);
    await expect(t.runner.continueSession({ sessionId: "S1", text: "hi", config: CONFIG })).rejects.toThrow("session ended");
  });

  it("ends a session that ignores /exit by killing it", async () => {
    const t = setup({ exitOnSlashExit: false });
    const run = t.run();
    await wait(5);
    await t.router.call("S1", "task_fail", { reason: "cannot" });
    expect(await run).toMatchObject({ outcome: "failed", reason: "cannot" });
    expect(t.runner.endSession("S1")).toBe(true);
    await wait(150);
    expect(t.term.lines).toEqual(["/exit"]);
    expect(t.term.killed).toBe(1);
    expect(t.runner.endSession("S1")).toBe(false);
  });

  it("closes an idle session after idleSessionMs", async () => {
    const t = setup({}, { idleSessionMs: 40 });
    const run = t.run();
    await wait(5);
    await t.router.call("S1", "task_complete", { summary: "ok" });
    await run;
    await wait(150);
    expect(t.term.lines).toEqual(["/exit"]);
    expect(t.runner.openSessions).toEqual([]);
  });

  it("keeps at most maxSessions open: a new run closes the oldest idle one", async () => {
    const t = setup({}, { maxSessions: 2 });
    for (const id of ["A", "B", "C"]) {
      const run = t.run(`Post: ${id}`, CONFIG, id);
      await wait(5);
      await t.router.call(id, "task_complete", { summary: id });
      await run;
    }
    await wait(80);
    expect(t.runner.openSessions).toEqual(["B", "C"]);
    expect(t.terms[0]!.lines).toEqual(["/exit"]);
    expect(t.terms[0]!.exited).toBe(true);
    expect(t.terms[1]!.exited).toBe(false);
  });

  it("pauses on the folder-trust prompt without answering it", async () => {
    const t = setup();
    const run = t.run();
    await wait(5);
    t.term.output("\x1b[7;2HQuick\x1b[1Csafety\x1b[1Ccheck\x1b[14;2H❯\x1b[1CNo,\x1b[1Cexit\x1b[15;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder");
    expect(await run).toEqual({ outcome: "paused", reason: TRUST_REASON, logPath: expect.any(String) });
    expect(t.term.written).toEqual([]);
    expect(t.term.killed).toBe(1);
    expect(t.runner.openSessions).toEqual([]);
  });

  it("pauses on a permission prompt", async () => {
    const t = setup();
    const run = t.run();
    await wait(5);
    t.term.output("Bash command\r\n\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No");
    expect(await run).toMatchObject({ outcome: "paused", reason: PERMISSION_REASON });
  });

  it("reports a usage limit as an error (retried later)", async () => {
    const t = setup();
    const run = t.run();
    await wait(5);
    t.term.output("● Claude AI usage limit reached|1760000000");
    expect(await run).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^Claude Code: usage limit reached/) });
  });

  it("types user messages mid-turn (one line, then Enter)", async () => {
    const t = setup();
    const run = t.run();
    await wait(5);
    expect(t.runner.sendUserMessage("S1", "use the second draft\nplease")).toBe(true);
    await wait(10);
    expect(t.term.lines).toEqual(["use the second draft please"]);
    await t.router.call("S1", "task_complete", { summary: "ok" });
    await run;
    expect(t.events.some((e) => e.type === "user_message")).toBe(true);
    expect(t.runner.sendUserMessage("S1", "between turns")).toBe(false);
  });

  it("kills the terminal on abort and at the time limit; the session is gone", async () => {
    const a = setup();
    const run = a.run();
    await wait(5);
    a.runner.abort("S1", "stopped by the user");
    expect(await run).toMatchObject({ outcome: "failed", reason: "stopped by the user" });
    expect(a.term.killed).toBe(1);
    await expect(a.runner.continueSession({ sessionId: "S1", text: "hi", config: CONFIG })).rejects.toThrow("session ended");

    const b = setup();
    const r = await b.run(undefined, { ...CONFIG, maxTaskMinutes: 0.0005 });
    expect(r).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/time limit/) });
    expect(b.term.killed).toBe(1);
  });

  it("forcePause kills the terminal and wins", async () => {
    const t = setup();
    const run = t.run();
    await wait(5);
    t.runner.forcePause("S1", "X is asking to log in");
    expect(await run).toMatchObject({ outcome: "paused", reason: "X is asking to log in" });
    expect(t.term.killed).toBe(1);
  });

  it("nudges once when Claude goes quiet without a result; still quiet: the turn fails but the session stays", async () => {
    const t = setup({ quietMs: 30 });
    const run = t.run();
    await wait(5);
    t.term.output("● I have finished.");
    const r = await run;
    expect(t.term.lines).toEqual([NUDGE]);
    expect(r).toMatchObject({ outcome: "failed", reason: IDLE_TURN_REASON });
    expect(t.runner.openSessions).toEqual(["S1"]);
    // No nudging between turns; a follow-up is its own turn again.
    await wait(80);
    expect(t.term.lines).toEqual([NUDGE]);
    const next = t.runner.continueSession({ sessionId: "S1", text: "try again", config: CONFIG });
    await wait(5);
    await t.router.call("S1", "task_complete", { summary: "ok now" });
    expect(await next).toMatchObject({ outcome: "done", summary: "ok now" });
    t.runner.shutdown("test over");
  });
});
