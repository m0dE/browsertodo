/**
 * Native messaging host entry. Chrome starts this process when the extension
 * calls chrome.runtime.connectNative("com.browsertodo.helper").
 *
 * stdout is the native messaging channel (4-byte LE length + UTF-8 JSON).
 * Nothing else may ever be written to it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  toolsFor,
  MCP_SERVER_NAME,
  mcpToolName,
  RpcPeer,
  type AgentEvent,
  type HelperNotifications,
  type RpcMessage,
  type ToolName,
} from "@browsertodo/shared";
import { buildSystemPrompt, createJev, createToolExecutor, type JevLike } from "@browsertodo/core";
import { loadConfig } from "./config.js";
import { LiveLog, redirectConsole, summarize } from "./logger.js";
import { encodeNativeMessage, FrameTooLargeError, NativeDecoder } from "./native-framing.js";
import { pipePathFor, startPipeServer, type PipeServer } from "./pipe-server.js";
import { INTERACTIVE_TASK_ID, rpcBrowser, ToolRouter, type InteractiveTools } from "./tool-router.js";
import { TaskRunner } from "./task-runner.js";
import { ClaudeCodeBrain, claudeEnv, resolveClaudePath } from "./brains/claude-code.js";
import { ScriptedBrain } from "./brains/scripted.js";
import type { Brain } from "./brains/brain.js";
import { SelfTestCache } from "./self-test.js";
import { fakePtyFactory, loadNodePty, TerminalBacklog, TerminalManager } from "./terminal.js";
import { removeHelperFile, writeHelperFile } from "./helper-file.js";
import type { BrowserMap, HelperMap } from "./rpc-types.js";

export const HELPER_VERSION = "0.2.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const live = new LiveLog(config.logDir);
  redirectConsole(live);
  const logLine = (line: string) => live.write(`helper ${line}`);
  const scripted = config.brain === "scripted";
  logLine(`start v${HELPER_VERSION} pid=${process.pid} brain=${config.brain} jev=${config.typesafeApiKey ? "on" : "off"}`);

  const writeFrame = (msg: RpcMessage) => {
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(msg);
    } catch (e) {
      if (!(e instanceof FrameTooLargeError)) throw e;
      logLine(`dropping oversize message ${msg.id ?? msg.method}: ${e.message}`);
      if (msg.id === undefined) return;
      frame = encodeNativeMessage({ id: msg.id, error: { message: e.message } });
    }
    process.stdout.write(frame);
  };
  const peer = new RpcPeer<BrowserMap, HelperMap>(writeFrame, "h");
  const notify = <K extends keyof HelperNotifications>(method: K, params: HelperNotifications[K]) => peer.notify(method, params);
  const browser = rpcBrowser(peer);

  const makeJev = (key: string): JevLike => createJev(key);
  const envJev = config.typesafeApiKey ? makeJev(config.typesafeApiKey) : null;
  const pipePath = pipePathFor(process.pid);
  const claudePath = scripted ? null : (config.claudePathOverride ?? resolveClaudePath(config.env));

  let runner!: TaskRunner;
  const makeBrain = (): Brain => {
    if (scripted) return new ScriptedBrain((t, n, a) => router.call(t, n, a));
    if (!claudePath) throw new Error("Claude Code was not found. Install it or set BROWSERTODO_CLAUDE_PATH.");
    return new ClaudeCodeBrain({ claudePath, model: config.model });
  };
  runner = new TaskRunner({
    runsDir: config.runsDir,
    mcpServerPath: config.mcpServerPath,
    pipePath,
    browser,
    envJevKey: config.typesafeApiKey,
    makeJev,
    makeBrain,
    notify: (sessionId, event: AgentEvent) => notify("helper.event", { sessionId, event }),
    live,
  });

  // Tools for the interactive terminal (and `mcp-server.js --attach`): no task to end, no media.
  // Rebuilt when the extension passes its Jev key with terminal.start.
  let interactiveJev: JevLike | null = envJev;
  let interactiveNames: ToolName[] = [];
  let interactive!: InteractiveTools;
  const setInteractiveJev = (jev: JevLike | null) => {
    interactiveJev = jev;
    interactiveNames = toolsFor({ jev: jev !== null, interactive: true });
    interactive = {
      allowedTools: new Set(interactiveNames),
      executor: createToolExecutor({
        browser,
        jev,
        jevThreshold: 0.8,
        onEvent: (e) => live.write(`${INTERACTIVE_TASK_ID} ${summarize(e as unknown as Record<string, unknown>)}`),
        mediaPaths: [],
      }),
    };
  };
  setInteractiveJev(envJev);
  const router: ToolRouter = new ToolRouter({ getSession: () => runner.session(), getInteractive: () => interactive });

  const selfTest = new SelfTestCache({
    claudePath: scripted ? "scripted" : claudePath,
    cacheFile: join(config.baseDir, "selftest.json"),
  });

  const backlog = new TerminalBacklog(256 * 1024);
  const ptyFactory = config.env.BROWSERTODO_FAKE_PTY === "1" ? fakePtyFactory : await loadNodePty();
  const terminal = new TerminalManager({
    factory: ptyFactory,
    command: () => {
      if (!claudePath && ptyFactory !== fakePtyFactory) throw new Error("Claude Code was not found. Install it or set BROWSERTODO_CLAUDE_PATH.");
      mkdirSync(config.workspaceDir, { recursive: true });
      const mcpConfigPath = join(config.baseDir, "interactive-mcp-config.json");
      writeFileSync(
        mcpConfigPath,
        JSON.stringify(
          {
            mcpServers: {
              [MCP_SERVER_NAME]: {
                command: process.execPath,
                args: [config.mcpServerPath],
                env: { BROWSERTODO_PIPE: pipePath, BROWSERTODO_TASK: "", BROWSERTODO_TOOLS: interactiveNames.join(",") },
              },
            },
          },
          null,
          2,
        ),
      );
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(claudeEnv(process.env))) if (v !== undefined) env[k] = v;
      return {
        file: claudePath ?? "claude",
        args: [
          "--mcp-config",
          mcpConfigPath,
          // browsertodo's own browser tools are pre-approved; everything else keeps the user's normal prompts.
          "--allowedTools",
          interactiveNames.map((n) => mcpToolName(n)).join(","),
          "--append-system-prompt",
          buildSystemPrompt({ tools: interactiveNames, jev: interactiveJev !== null, interactive: true }),
        ],
        cwd: config.workspaceDir,
        env,
      };
    },
    onData: (terminalId, data) => {
      backlog.append(terminalId, data);
      notify("helper.terminal.data", { terminalId, data });
    },
    onExit: (terminalId, exitCode) => {
      backlog.clear(terminalId);
      notify("helper.terminal.exit", { terminalId, exitCode });
    },
    log: logLine,
  });
  logLine(`node-pty ${terminal.available ? "loaded" : "not available"}`);

  let pipe: PipeServer | null = null;
  try {
    pipe = await startPipeServer(
      pipePath,
      {
        toolCall: (p) => router.call(p.taskId || INTERACTIVE_TASK_ID, p.name, p.args),
        toolList: (p) => ({ names: router.allowedTools(p.taskId || INTERACTIVE_TASK_ID) }),
      },
      logLine,
    );
    logLine(`pipe listening at ${pipePath}`);
    try {
      writeHelperFile(config.helperFilePath, { pipe: pipePath, pid: process.pid, startedAt: new Date().toISOString() });
    } catch (e) {
      logLine(`could not write ${config.helperFilePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    logLine(`pipe failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  peer.handle("helper.hello", async ({ selfTest: rerun }) => {
    const st = await selfTest.get(rerun === true);
    return {
      version: HELPER_VERSION,
      jevAvailable: envJev !== null,
      claudePath: scripted ? "scripted" : claudePath,
      logDir: config.logDir,
      ptyAvailable: terminal.available,
      selfTest: st,
    };
  });
  peer.handle("helper.runTask", async (params) => {
    if (runner.busy) throw new Error("busy");
    if (!pipe) throw new Error("helper pipe server is not running");
    logLine(`runTask ${params.sessionId} task=${params.task.id} media=${params.mediaPaths.length}`);
    const result = await runner.run(params);
    logLine(`runTask ${params.sessionId} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.sendUserMessage", ({ sessionId, text }) => ({ ok: runner.sendUserMessage(sessionId, text) }));
  peer.handle("helper.forcePause", ({ sessionId, reason }) => {
    runner.forcePause(sessionId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.abortTask", ({ sessionId, reason }) => {
    runner.abort(sessionId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.getLog", ({ lines }) => ({ text: live.tail(lines) }));
  peer.handle("helper.terminal.start", ({ cols, rows, jevApiKey }) => {
    const key = jevApiKey || config.typesafeApiKey;
    setInteractiveJev(key ? makeJev(key) : null);
    return terminal.start(cols, rows);
  });
  peer.handle("helper.terminal.backlog", ({ terminalId }) => ({ data: backlog.get(terminalId) }));
  peer.handle("helper.terminal.input", ({ terminalId, data }) => {
    terminal.input(terminalId, data);
    return { ok: true as const };
  });
  peer.handle("helper.terminal.resize", ({ terminalId, cols, rows }) => {
    terminal.resize(terminalId, cols, rows);
    return { ok: true as const };
  });
  peer.handle("helper.terminal.stop", ({ terminalId }) => {
    terminal.stop(terminalId);
    return { ok: true as const };
  });

  const decoder = new NativeDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      logLine(`bad native frame: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const m of msgs) void peer.receive(m as RpcMessage);
  });

  let exiting = false;
  const shutdown = async (why: string) => {
    if (exiting) return;
    exiting = true;
    logLine(`shutting down: ${why}`);
    peer.close("helper shutting down");
    terminal.stopAll();
    runner.shutdown(why);
    removeHelperFile(config.helperFilePath, process.pid);
    // Give the brain a moment to kill its process tree.
    const deadline = Date.now() + 5000;
    while (runner.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await pipe?.close().catch(() => {});
    process.exit(0);
  };
  process.stdout.on("error", (e) => void shutdown(`stdout error: ${e.message}`));
  process.stdin.on("end", () => void shutdown("stdin closed (Chrome disconnected)"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("exit", () => removeHelperFile(config.helperFilePath, process.pid));
  process.on("uncaughtException", (e) => logLine(`uncaught: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => logLine(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
}

main().catch((e) => {
  try {
    process.stderr.write(`browsertodo host failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  } finally {
    process.exit(1);
  }
});
