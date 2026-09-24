/**
 * Runs Claude Code headless (`claude -p`) for one task. Claude only gets the
 * browsertodo MCP tools: no shell, file or web access.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Brain, BrainContext } from "./brain.js";

export function buildClaudeArgs(opts: {
  prompt: string;
  systemPrompt: string;
  mcpConfigPath: string;
  allowedTools: string[];
  model: string;
}): string[] {
  return [
    "-p",
    opts.prompt,
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

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {
      child.kill();
    }
  } else {
    child.kill("SIGKILL");
  }
}

/** Environment for the Claude process: drop variables that make it think it is nested. */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "BROWSERTODO_BRAIN") delete out[k];
  }
  return out;
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
      prompt: ctx.prompt,
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
          stdio: ["ignore", "pipe", "pipe"],
          env: claudeEnv(),
        });
      } catch (e) {
        return reject(e);
      }
      const onAbort = () => {
        ctx.log({ type: "claude_kill", reason: String(ctx.signal.reason ?? "aborted") });
        killTree(child);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const text = new StringDecoder("utf8");
      let rest = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        // stream-json: one JSON event per line; tolerate the odd non-JSON line.
        rest += text.write(chunk);
        let nl: number;
        while ((nl = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, nl).trim();
          rest = rest.slice(nl + 1);
          if (!line) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            ctx.log({ type: "claude_stdout", text: line.slice(0, 2000) });
            continue;
          }
          ctx.log({ type: "claude", event });
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
