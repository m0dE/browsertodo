/**
 * Native messaging host entry. Chrome starts this process when the extension
 * calls chrome.runtime.connectNative("com.browsertodo.helper").
 *
 * stdout is the native messaging channel (4-byte LE length + UTF-8 JSON).
 * Nothing else may ever be written to it.
 */
import type { RpcMessage } from "@browsertodo/shared";
import { RpcPeer } from "@browsertodo/shared";
import { loadConfig } from "./config.js";
import { LiveLog, redirectConsole } from "./logger.js";
import { encodeNativeMessage, FrameTooLargeError, NativeDecoder } from "./native-framing.js";
import { pipePathFor, startPipeServer, type PipeServer } from "./pipe-server.js";
import { ToolRouter } from "./tool-router.js";
import { TaskRunner } from "./task-runner.js";
import { createJevClient } from "./jev.js";
import { ClaudeCodeBrain, resolveClaudePath } from "./brains/claude-code.js";
import { ScriptedBrain } from "./brains/scripted.js";
import type { Brain } from "./brains/brain.js";
import type { BrowserMap, HelperMap } from "./rpc-types.js";

export const HELPER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const live = new LiveLog(config.logDir);
  redirectConsole(live);
  const logLine = (line: string) => live.write(`helper ${line}`);
  logLine(`start v${HELPER_VERSION} pid=${process.pid} brain=${config.brain} jev=${config.typesafeApiKey ? "on" : "off"}`);

  const writeFrame = (msg: RpcMessage) => {
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(msg);
    } catch (e) {
      if (!(e instanceof FrameTooLargeError) || msg.id === undefined) throw e;
      logLine(`dropping oversize message ${msg.id}: ${e.message}`);
      frame = encodeNativeMessage({ id: msg.id, error: { message: e.message } });
    }
    process.stdout.write(frame);
  };
  const peer = new RpcPeer<BrowserMap, HelperMap>(writeFrame, "h");

  const jev = config.typesafeApiKey ? createJevClient(config.typesafeApiKey, logLine) : null;
  let runner!: TaskRunner;
  const router = new ToolRouter({ browser: peer, getSession: () => runner.session(), jev });
  const pipePath = pipePathFor(process.pid);
  const claudePath = config.brain === "claude" ? (config.claudePathOverride ?? resolveClaudePath(config.env)) : null;

  const makeBrain = (): Brain => {
    if (config.brain === "scripted") return new ScriptedBrain((t, n, a) => router.call(t, n, a));
    if (!claudePath) throw new Error("Claude Code was not found. Install it or set BROWSERTODO_CLAUDE_PATH.");
    return new ClaudeCodeBrain({ claudePath, model: config.model });
  };
  runner = new TaskRunner({
    runsDir: config.runsDir,
    mcpServerPath: config.mcpServerPath,
    pipePath,
    jevAvailable: jev !== null,
    makeBrain,
    live,
  });

  let pipe: PipeServer | null = null;
  try {
    pipe = await startPipeServer(
      pipePath,
      {
        toolCall: (p) => router.call(p.taskId, p.name, p.args),
        toolList: (p) => ({ names: router.allowedTools(p.taskId) }),
      },
      logLine,
    );
    logLine(`pipe listening at ${pipePath}`);
  } catch (e) {
    logLine(`pipe failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  peer.handle("helper.hello", () => ({
    version: HELPER_VERSION,
    jevAvailable: jev !== null,
    claudePath: config.brain === "scripted" ? "scripted" : claudePath,
    logDir: config.logDir,
  }));
  peer.handle("helper.runTask", async ({ claim, config: runConfig }) => {
    if (runner.busy) throw new Error("busy");
    if (!pipe) throw new Error("helper pipe server is not running");
    logLine(`runTask ${claim.task.id}`);
    const result = await runner.run(claim, runConfig);
    logLine(`runTask ${claim.task.id} -> ${result.outcome}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  });
  peer.handle("helper.forcePause", ({ taskId, reason }) => {
    runner.forcePause(taskId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.abortTask", ({ taskId, reason }) => {
    runner.abort(taskId, reason);
    return { ok: true as const };
  });
  peer.handle("helper.getLog", ({ lines }) => ({ text: live.tail(lines) }));

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
    runner.shutdown(why);
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
