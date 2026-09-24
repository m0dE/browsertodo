import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEnv, parseDotEnv } from "../src/config.js";
import { LiveLog, RunLog } from "../src/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config", () => {
  it("parses .env text: comments, quotes, export prefix, blank lines", () => {
    const env = parseDotEnv("# c\nA=1\nexport B=\"two words\"\nC='x=y'\n\nD = spaced \nbad line\n");
    expect(env).toEqual({ A: "1", B: "two words", C: "x=y", D: "spaced" });
  });

  it("merges .env files in order, and process env wins even when empty", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, ".env"), "X=from-a\nY=from-a\n");
    writeFileSync(join(b, ".env"), "Y=from-b\nZ=from-b\n");
    const env = loadEnv([a, b, join(dir, "missing")], { Z: "" });
    expect(env).toEqual({ X: "from-a", Y: "from-b", Z: "" });
  });

  it("derives paths, brain and Jev key from env", () => {
    const cfg = loadConfig({ BROWSERTODO_HOME: dir, TYPESAFE_API_KEY: "  ", BROWSERTODO_BRAIN: "scripted" }, { dotenvDirs: [] });
    expect(cfg.baseDir).toBe(dir);
    expect(cfg.logDir).toBe(join(dir, "logs"));
    expect(cfg.runsDir).toBe(join(dir, "runs"));
    expect(cfg.typesafeApiKey).toBeNull();
    expect(cfg.brain).toBe("scripted");
    expect(cfg.model).toBe("sonnet");
    expect(cfg.mcpServerPath.endsWith(join("dist", "mcp-server.js"))).toBe(true);
    const withKey = loadConfig({ BROWSERTODO_HOME: dir, TYPESAFE_API_KEY: "k", BROWSERTODO_MODEL: "opus" }, { dotenvDirs: [] });
    expect(withKey.typesafeApiKey).toBe("k");
    expect(withKey.brain).toBe("claude");
    expect(withKey.model).toBe("opus");
  });

  it("defaults the base dir to %LOCALAPPDATA%\\browsertodo", () => {
    const cfg = loadConfig({ LOCALAPPDATA: dir }, { dotenvDirs: [] });
    expect(cfg.baseDir).toBe(join(dir, "browsertodo"));
  });
});

describe("logger", () => {
  it("writes JSONL events per run and a readable line to live.log", () => {
    const live = new LiveLog(join(dir, "logs"));
    const run = new RunLog(join(dir, "run", "log.jsonl"), live, "T1");
    run.event({ type: "tool_call", name: "click", args: { index: 3 } });
    run.event({ type: "note", text: "line1\nline2" });
    const lines = readFileSync(run.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "tool_call", name: "click", taskId: "T1" });
    expect(typeof lines[0].ts).toBe("string");
    const tail = live.tail(10);
    expect(tail.split("\n")).toHaveLength(2);
    expect(tail).toContain("T1 tool_call");
  });

  it("tail returns only the last N lines", () => {
    const live = new LiveLog(dir);
    for (let i = 0; i < 20; i++) live.write(`line ${i}`);
    expect(live.tail(3)).toMatch(/line 17\n.*line 18\n.*line 19$/);
  });

  it("keeps one event on one line", () => {
    const live = new LiveLog(dir);
    live.write("a\nb");
    expect(live.tail(10).split("\n")).toHaveLength(1);
  });

  it("rotates live.log past the size limit", () => {
    const live = new LiveLog(dir, 1000);
    for (let i = 0; i < 50; i++) live.write("x".repeat(50));
    expect(existsSync(join(dir, "live.log.1"))).toBe(true);
    expect(statSync(join(dir, "live.log")).size).toBeLessThan(1100);
  });
});
