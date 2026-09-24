/**
 * Runs Claude Code headless for one task, with stream-json in and out. The
 * task prompt is the first stdin message; stdin stays open so the human can
 * add messages while it runs, and is closed after a task_* tool call (or
 * when Claude ends its turn without one). Claude only gets the browsertodo
 * MCP tools: no shell, file or web access.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { clipEventText, type AgentEvent } from "@browsertodo/shared";
import type { Brain, BrainContext } from "./brain.js";

export function buildClaudeArgs(opts: { systemPrompt: string; mcpConfigPath: string; allowedTools: string[]; model: string }): string[] {
  return [
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
    opts.mcpConfigPath,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--append-system-prompt",
    opts.systemPrompt,
    "--no-session-persistence",
    "--model",
    opts.model,
  ];
}

/** One stream-json input line carrying a user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** BROWSERTODO_CLAUDE_PATH, else `where claude`, else %USERPROFILE%\.local\bin\claude.exe. */
export function resolveClaudePath(
  env: Record<string, string | undefined> = process.env,
  deps: { where?: () => string; exists?: (p: string) => boolean } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const override = env.BROWSERTODO_CLAUDE_PATH?.trim();
  if (override) return override;
  const where =
    deps.where ??
    (() =>
      execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }));
  try {
    const found = where()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // With shell: false we need a real executable, not a .cmd/.ps1 shim.
    const exe = process.platform === "win32" ? found.find((p) => p.toLowerCase().endsWith(".exe")) : found[0];
    if (exe && exists(exe)) return exe;
  } catch {
    /* not on PATH */
  }
  const home = env.USERPROFILE || homedir();
  const fallback = join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return exists(fallback) ? fallback : null;
}

export function killPid(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  killPid(child.pid);
}

/**
 * Environment for a Claude process: drop variables that make it think it is
 * nested (an inherited CLAUDE_CODE_CHILD_SESSION, for one, turns off
 * transcript saving).
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "BROWSERTODO_BRAIN") delete out[k];
  }
  return out;
}

/**
 * AgentEvents for one Claude Code stream-json event. Tool calls and results
 * are not mapped: the helper's tool executor already emits them.
 */
export function mapStreamEvent(ev: any): AgentEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    return ev.message.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
      .map((b: any) => ({ type: "assistant_text", text: clipEventText(b.text) }));
  }
  if (ev.type === "result" && (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success"))) {
    const detail = typeof ev.result === "string" && ev.result.trim() ? ev.result : (ev.subtype ?? "error");
    return [{ type: "error", text: clipEventText(`Claude Code: ${detail}`) }];
  }
  if (ev.type === "system" && ev.subtype === "init") {
    return [{ type: "status", text: `Claude Code started${ev.model ? ` (${ev.model})` : ""}` }];
  }
  return [];
}

export class ClaudeCodeBrain implements Brain {
  constructor(
    private readonly opts: {
      claudePath: string;
      model: string;
      /** Extra leading args, for tests that run a fake claude script with node. */
      prefixArgs?: string[];
    },
  ) {}

  run(ctx: BrainContext): Promise<void> {
    const args = buildClaudeArgs({
      systemPrompt: ctx.systemPrompt,
      mcpConfigPath: ctx.mcpConfigPath,
      allowedTools: ctx.allowedTools,
      model: this.opts.model,
    });
    ctx.log({ type: "claude_start", claudePath: this.opts.claudePath, model: this.opts.model, allowedTools: ctx.allowedTools });
    return new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) return resolve();
      let child: ChildProcess;
      try {
        child = spawn(this.opts.claudePath, [...(this.opts.prefixArgs ?? []), ...args], {
          cwd: dirname(ctx.mcpConfigPath),
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: claudeEnv(),
        });
      } catch (e) {
        return reject(e);
      }
      const stdin = child.stdin!;
      stdin.on("error", (e) => ctx.log({ type: "claude_stdin_error", message: e.message }));

      // Every user message gets one result event; when all are answered and
      // no task_* was called, Claude has stopped: close stdin so it exits.
      let sent = 0;
      let results = 0;
      const send = (text: string) => {
        if (stdin.destroyed || stdin.writableEnded) return;
        sent++;
        stdin.write(userMessageLine(text));
      };
      send(ctx.prompt);
      ctx.input.onMessage((text) => {
        ctx.log({ type: "claude_user_message", chars: text.length });
        send(`Message from the human (they are watching this run): ${text}`);
      });
      ctx.input.onClose(() => {
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      });

      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const text = new StringDecoder("utf8");
      let rest = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        rest += text.write(chunk);
        let nl: number;
        while ((nl = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, nl).trim();
          rest = rest.slice(nl + 1);
          if (!line) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "claude_stdout", text: line.slice(0, 2000) });
            continue;
          }
          ctx.log({ type: "claude", event });
          for (const e of mapStreamEvent(event)) ctx.emit(e);
          if (event?.type === "result") {
            results++;
            if (results >= sent && !ctx.input.closed) {
              ctx.log({ type: "claude_turns_done", sent, results });
              ctx.input.close();
            }
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => ctx.log({ type: "claude_stderr", text: chunk.toString("utf8").slice(0, 2000) }));
      child.on("error", (e) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_error", message: e.message });
        reject(e);
      });
      child.on("close", (code, signal) => {
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.log({ type: "claude_exit", code, signal });
        resolve();
      });
    });
  }
}
