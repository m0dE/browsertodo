/**
 * The local Claude Code executable: finding it, the environment it runs
 * with, and killing its process tree. Used by the Claude Code brain and the
 * self-test.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV } from "./env-names.js";

export const CLAUDE_NOT_FOUND = `Claude Code was not found. Install it or set ${ENV.claudePath}.`;

/**
 * Flags of every Claude Code run the helper starts: none of Claude Code's
 * own tools, no user or project settings, nothing saved, and the model.
 */
export function isolatedClaudeArgs(model: string): string[] {
  return ["--tools", "", "--setting-sources", "", "--no-session-persistence", "--model", model];
}

/** BROWSERTODO_CLAUDE_PATH, else `where claude`, else %USERPROFILE%\.local\bin\claude.exe. */
export function resolveClaudePath(
  env: Record<string, string | undefined> = process.env,
  deps: { where?: () => string; exists?: (p: string) => boolean } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const override = env[ENV.claudePath]?.trim();
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
    const candidates = process.platform === "win32" ? found.filter((p) => p.toLowerCase().endsWith(".exe")) : found;
    const exe = candidates.find((p) => exists(p));
    if (exe) return exe;
  } catch {
    /* not on PATH */
  }
  const home = env.USERPROFILE || homedir();
  const fallback = join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return exists(fallback) ? fallback : null;
}

function killPid(pid: number | undefined): void {
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
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === ENV.brain) delete out[k];
  }
  return out;
}
