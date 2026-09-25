/**
 * What a new task session needs before its brain starts: the run folder, the
 * MCP config Claude Code loads, the follow-up prompts, and the session's view
 * of the browser.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_SERVER_NAME, type ToolName } from "@browsertodo/shared";
import type { BrowserCaller } from "@browsertodo/core";

/** Typed before a follow-up message, so the agent knows it continues the same conversation. */
/** Same text the Claude API brain uses, so both brains see follow-ups alike. */
export { FOLLOW_UP_PREFIX } from "@browsertodo/core";

/** Added to the system prompt of kept-open sessions. */
export const FOLLOW_UP_PROMPT = [
  "Follow-up messages: after you call task_complete (or task_fail / task_pause), this session stays open",
  "and the user may send follow-up messages in it. Treat each follow-up as the next request in the same",
  "conversation, starting from the browser as you left it, and end each follow-up with exactly one",
  "task_complete, task_fail or task_pause call again. After that call, stop and wait.",
].join(" ");

function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
}

/** runs/<session>-<stamp> */
export function runDirFor(runsDir: string, sessionId: string): string {
  return join(runsDir, `${safeId(sessionId)}-${runStamp()}`);
}

/** The --mcp-config for Claude Code: one browsertodo MCP server (dist/mcp-server.js) bound to this session. */
export function buildMcpConfig(opts: { nodePath: string; mcpServerPath: string; pipePath: string; taskId: string; toolNames: ToolName[] }) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: opts.nodePath,
        args: [opts.mcpServerPath],
        env: {
          BROWSERTODO_PIPE: opts.pipePath,
          BROWSERTODO_TASK: opts.taskId,
          BROWSERTODO_TOOLS: opts.toolNames.join(","),
        },
      },
    },
  };
}

/** Browser call params with the calling session's id (see BrowserCallContext). */
function withSession<P>(params: P, sessionId: string): P {
  return { ...((params ?? {}) as object), sessionId } as P;
}

/**
 * The session's browser: every call names the session (so the extension
 * acts in that session's own tab), and screenshots are also saved into the
 * run folder.
 */
export function sessionBrowser(browser: BrowserCaller, sessionId: string, runDir: string): BrowserCaller {
  let screenshots = 0;
  return {
    call: async (method, params) => {
      const r = await browser.call(method, withSession(params, sessionId));
      if (method === "browser.screenshot") {
        const shot = r as { base64: string; mimeType: string };
        screenshots++;
        const ext = shot.mimeType === "image/png" ? "png" : "jpg";
        try {
          writeFileSync(join(runDir, `screenshot-${String(screenshots).padStart(3, "0")}.${ext}`), Buffer.from(shot.base64, "base64"));
        } catch {
          /* best effort */
        }
      }
      return r;
    },
  };
}
