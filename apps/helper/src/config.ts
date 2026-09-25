/**
 * Helper configuration: `.env` files from the repo root and the helper
 * directory (tiny parser, no dependency), then `process.env`, which always wins.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { HelperBrain } from "@browsertodo/shared";
import helperPackage from "../package.json" with { type: "json" };
import { ENV } from "./env-names.js";

/** Reported in helper.hello and by the MCP server: the version in apps/helper/package.json (bundled at build time). */
export const HELPER_VERSION: string = helperPackage.version;

/** Claude Code's model alias when neither the extension nor BROWSERTODO_MODEL names a model. */
export const DEFAULT_CLAUDE_MODEL = "sonnet";

export interface HelperConfig {
  /** %LOCALAPPDATA%\browsertodo, or BROWSERTODO_HOME. */
  baseDir: string;
  logDir: string;
  runsDir: string;
  hostDir: string;
  /** helper.json: pipe name and pid of the running helper, for `mcp-server.js --attach`. */
  helperFilePath: string;
  /** Absolute path of the bundled MCP server that Claude Code spawns. */
  mcpServerPath: string;
  /** Jev key, or null when missing or blank. */
  typesafeApiKey: string | null;
  brain: HelperBrain;
  model: string;
  /** The merged environment (.env files, then process.env). */
  env: Record<string, string | undefined>;
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/** Later directories override earlier ones; `processEnv` overrides all. */
export function loadEnv(dirs: string[], processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const dir of dirs) {
    const file = join(dir, ".env");
    if (!existsSync(file)) continue;
    try {
      Object.assign(merged, parseDotEnv(readFileSync(file, "utf8")));
    } catch {
      /* an unreadable .env is ignored */
    }
  }
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) merged[k] = v;
  return merged;
}

/** apps/helper, whether running from src/ (tests) or dist/ (bundled). */
export function helperRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const name = basename(here);
  return name === "src" || name === "dist" ? dirname(here) : here;
}

export function repoRoot(): string {
  return resolve(helperRoot(), "..", "..");
}

export function loadConfig(
  processEnv: Record<string, string | undefined> = process.env,
  opts: { dotenvDirs?: string[] } = {},
): HelperConfig {
  const root = helperRoot();
  const env = loadEnv(opts.dotenvDirs ?? [repoRoot(), root], processEnv);
  const localAppData = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const baseDir = env[ENV.home] || join(localAppData, "browsertodo");
  const key = env[ENV.typesafeApiKey]?.trim();
  return {
    baseDir,
    logDir: join(baseDir, "logs"),
    runsDir: join(baseDir, "runs"),
    hostDir: join(baseDir, "host"),
    helperFilePath: join(baseDir, "helper.json"),
    mcpServerPath: join(root, "dist", "mcp-server.js"),
    typesafeApiKey: key ? key : null,
    brain: env[ENV.brain] === "scripted" ? "scripted" : "claude",
    model: env[ENV.model]?.trim() || DEFAULT_CLAUDE_MODEL,
    env,
  };
}
