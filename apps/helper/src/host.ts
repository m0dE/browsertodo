/**
 * Native messaging host entry. Chrome starts this process when the extension
 * calls chrome.runtime.connectNative("com.browsertodo.helper").
 *
 * stdout is the native messaging channel (4-byte LE length + UTF-8 JSON).
 * Nothing else may ever be written to it.
 */
import { join } from "node:path";
import {
  toolsFor,
  RpcPeer,
  type AgentEvent,
  type HelperNotifications,
  type RpcMessage,
} from "@browsertodo/shared";
import { createJev, createToolExecutor, type JevLike } from "@browsertodo/core";
import { HELPER_VERSION, loadConfig } from "./config.js";
import { errorMessage, LiveLog, redirectConsole, summarize } from "./logger.js";
import { encodeNativeMessage, FrameTooLargeError, NativeDecoder } from "./native-framing.js";
import { pipePathFor, startPipeServer, type PipeServer } from "./pipe-server.js";
import { rpcBrowser, ToolRouter, type InteractiveTools } from "./tool-router.js";
import { INTERACTIVE_TASK_ID } from "./mcp-tools.js";
import { TaskRunner } from "./task-runner.js";
import { ClaudeCodeBrain } from "./brains/claude-code.js";
import { CLAUDE_NOT_FOUND, resolveClaudePath } from "./claude-process.js";
import { ScriptedBrain } from "./brains/scripted.js";
import type { Brain } from "./brains/brain.js";
import { SelfTestCache } from "./self-test.js";
import { readRunLog } from "./run-log.js";
import { removeHelperFile, writeHelperFile } from "./helper-file.js";
import type { BrowserMap, HelperMap } from "./rpc-types.js";

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
  // resolveClaudePath honours BROWSERTODO_CLAUDE_PATH (from .env or the environment).
  const claudePath = scripted ? null : resolveClaudePath(config.env);
  /** As reported in helper.hello and keyed in the self-test cache. */
  const shownClaudePath = scripted ? "scripted" : claudePath;

  const makeBrain = (): Brain => {
    if (scripted) return new ScriptedBrain((t, n, a) => router.call(t, n, a));
    if (!claudePath) throw new Error(CLAUDE_NOT_FOUND);
    // Headless stream-json with stdin kept open: structured events, and follow-up turns in the same session.
    return new ClaudeCodeBrain({ claudePath, model: config.model, persistent: true });
  };
  const runner = new TaskRunner({
    runsDir: config.runsDir,
    mcpServerPath: config.mcpServerPath,
    pipePath,
    browser,
    envJevKey: config.typesafeApiKey,
    makeJev,
    makeBrain,
    notify: (sessionId, event: AgentEvent) => notify("helper.event", { sessionId, event }),
    onSessionsChanged: (open) => notify("helper.sessions", { open }),
    live,
  });

  // Tools for the user's own Claude Code (`mcp-server.js --attach`): no task to end, no media.
  const interactive: InteractiveTools = {
    allowedTools: new Set(toolsFor({ jev: envJev !== null, interactive: true })),
    jev: envJev !== null,
    executor: createToolExecutor({
      browser,
      jev: envJev,
      jevThreshold: 0.8,
      onEvent: (e) => live.write(`${INTERACTIVE_TASK_ID} ${summarize(e as unknown as Record<string, unknown>)}`),
      mediaPaths: [],
    }),
  };
  const router = new ToolRouter({ getSession: (taskId) => runner.session(taskId), getInteractive: () => interactive });

  const selfTest = new SelfTestCache({
    claudePath: shownClaudePath,
    cacheFile: join(config.baseDir, "selftest.json"),
  });

  let pipe: PipeServer | null = null;
  try {
    pipe = await startPipeServer(
      pipePath,
      {
        toolCall: (p) => router.call(p.taskId || INTERACTIVE_TASK_ID, p.name, p.args),
        toolList: (p) => ({ names: router.allowedTools(p.taskId || INTERACTIVE_TASK_ID), jev: router.jev(p.taskId || INTERACTIVE_TASK_ID) }),
      },
      logLine,
    );
    logLine(`pipe listening at ${pipePath}`);
    try {
      writeHelperFile(config.helperFilePath, { pipe: pipePath, pid: process.pid, startedAt: new Date().toISOString() });
    } catch (e) {
      logLine(`could not write ${config.helperFilePath}: ${errorMessage(e)}`);
    }
  } catch (e) {
    logLine(`pipe failed to start: ${errorMessage(e)}`);
  }

  peer.handle("helper.hello", async ({ selfTest: rerun }) => {
    const st = await selfTest.get(rerun === true);
    return {
      version: HELPER_VERSION,
      jevAvailable: envJev !== null,
      claudePath: shownClaudePath,
      logDir: config.logDir,
      openSessions: runner.openSessions,
      selfTest: st,
    };
  });
  peer.handle("helper.runTask", async (params) => {
    if (!pipe) throw new Error("helper pipe server is not running");
    logLine(`runTask ${params.sessionId} task=${params.task.id} media=${params.mediaPaths.length}`);
    const result = await runner.run(params);
    logLine(`runTask ${params.sessionId} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.continueSession", async (params) => {
    logLine(`continueSession ${params.sessionId} chars=${params.text.length}`);
    const result = await runner.continueSession(params);
    logLine(`continueSession ${params.sessionId} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.endSession", ({ sessionId }) => ({ ok: runner.endSession(sessionId) }));
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
  peer.handle("helper.runLog", ({ path, maxBytes }) => readRunLog(config.runsDir, path, maxBytes));

  const decoder = new NativeDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      logLine(`bad native frame: ${errorMessage(e)}`);
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
    runner.shutdown(why);
    removeHelperFile(config.helperFilePath, process.pid);
    // Give the brain a moment to kill its process tree.
    const deadline = Date.now() + 5000;
    while ((runner.busy || runner.openSessions.length > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
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
