import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBrain, buildClaudeArgs } from "../src/brains/claude-code.js";
import type { BrainContext } from "../src/brains/brain.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "support", "fake-claude.mjs");

let dir: string;
const savedClaudeCode = process.env.CLAUDECODE;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bt-claude-")));
});
afterEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
  if (savedClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = savedClaudeCode;
  rmSync(dir, { recursive: true, force: true });
});

function ctx(signal: AbortSignal, events: Record<string, any>[]): BrainContext {
  return {
    taskId: "T1",
    prompt: 'Line one\nLine "two" with \\ backslash and trailing \\',
    systemPrompt: "rules & <stuff> | %PATH%",
    mcpConfigPath: join(dir, "mcp-config.json"),
    allowedTools: ["mcp__browsertodo__read_page", "mcp__browsertodo__task_complete"],
    signal,
    log: (e) => events.push(e),
  };
}

describe("ClaudeCodeBrain process handling (fake claude)", () => {
  it("passes the exact args (including empty ones), runs in the run dir, and logs JSONL events", async () => {
    process.env.CLAUDECODE = "1"; // must not leak into the child
    const events: Record<string, any>[] = [];
    const c = ctx(new AbortController().signal, events);
    await new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE] }).run(c);
    const init = events.find((e) => e.type === "claude" && e.event.type === "system")!.event;
    expect(init.args).toEqual(buildClaudeArgs({ ...c, model: "sonnet" }));
    expect(init.cwd).toBe(dir);
    expect(init.nested).toBeNull();
    expect(events.find((e) => e.type === "claude_stdout")).toEqual({ type: "claude_stdout", text: "not json" });
    expect(events.some((e) => e.type === "claude" && e.event.text === "✓ done")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "claude_exit", code: 0 });
  });

  it("kills the process tree on abort", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    const events: Record<string, any>[] = [];
    const ac = new AbortController();
    const run = new ClaudeCodeBrain({ claudePath: process.execPath, model: "sonnet", prefixArgs: [FAKE] }).run(ctx(ac.signal, events));
    const started = Date.now();
    while (!events.some((e) => e.type === "claude") && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error("time limit"));
    await run;
    expect(events.some((e) => e.type === "claude_kill")).toBe(true);
    expect(events.at(-1)?.type).toBe("claude_exit");
  });

  it("rejects when claude cannot be started", async () => {
    const events: Record<string, any>[] = [];
    await expect(new ClaudeCodeBrain({ claudePath: join(dir, "missing.exe"), model: "sonnet" }).run(ctx(new AbortController().signal, events))).rejects.toThrow(
      /ENOENT/,
    );
  });
});
