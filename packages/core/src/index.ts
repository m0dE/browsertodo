/**
 * @browsertodo/core: agent logic shared by the helper (Claude Code brain, via
 * MCP) and the extension (Claude API brain, in the service worker).
 * Browser- and Node-safe: no Node-only imports, no process.env.
 */
import type { PageSnapshot, ToolName } from "@browsertodo/shared";
import type {
  AgentSession,
  AgentTask,
  ApiAgentOptions,
  BrowserCaller,
  FailureKind,
  JevLike,
  ToolExecutor,
  ToolExecutorOptions,
} from "./types.js";
import { createToolExecutor as createToolExecutorImpl } from "./executor.js";
import { createJev as createJevImpl } from "./jev.js";
import { buildSystemPrompt as buildSystemPromptImpl, buildTaskPrompt as buildTaskPromptImpl } from "./prompts.js";
import { formatSnapshot as formatSnapshotImpl } from "./page-format.js";
import { classifyFailure as classifyFailureImpl } from "./failures.js";
import { verifyXPost as verifyXPostImpl } from "./verify.js";
import { startApiAgent as startApiAgentImpl } from "./api-agent.js";

export * from "./types.js";

/** Tool execution shared by both brains. */
export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  return createToolExecutorImpl(opts);
}

/** Jev client over fetch (works in the extension and in Node). */
export function createJev(apiKey: string, opts?: { fetch?: typeof fetch; model?: string }): JevLike {
  return createJevImpl(apiKey, opts);
}

/** System prompt for either brain. interactive: terminal session with no task to end. */
export function buildSystemPrompt(opts: { tools: ToolName[]; jev: boolean; interactive?: boolean }): string {
  return buildSystemPromptImpl(opts);
}

/** First user message for a task. isRetry adds the "check it wasn't already done" instruction. */
export function buildTaskPrompt(task: AgentTask, mediaPaths: string[], opts: { isRetry: boolean }): string {
  return buildTaskPromptImpl(task, mediaPaths, opts);
}

/** Compact text form of a snapshot, as returned by read_page. */
export function formatSnapshot(snap: PageSnapshot): string {
  return formatSnapshotImpl(snap);
}

/** Sorts a failure reason into temporary (retry later) or permanent. */
export function classifyFailure(reason: string): FailureKind {
  return classifyFailureImpl(reason);
}

/**
 * Checks independently that an X post exists and shows the expected text:
 * navigates to the URL, reads the page, looks for a distinctive snippet.
 */
export async function verifyXPost(browser: BrowserCaller, url: string, expectedText: string): Promise<{ ok: boolean; detail: string }> {
  return verifyXPostImpl(browser, url, expectedText);
}

/** Claude API agent loop (Anthropic Messages API with tool use). */
export function startApiAgent(opts: ApiAgentOptions): AgentSession {
  return startApiAgentImpl(opts);
}

// Extras used by the helper (and handy for the extension).
export { NOT_CONFIDENT, NO_TASK_TO_END } from "./executor.js";
export { formatElement, formatElements, formatCompact, formatTabs, formatTabSnapshots, parseSnapshotText, type ParsedPage } from "./page-format.js";
export { switchXAccount, normalizeHandle, mentionsHandle, SWITCHER_TEST_ID } from "./x-account.js";
export { jevFromClient, buildJevState, buildJevQuestions, parseJevAnswers, type JevClientLike } from "./jev.js";
export { isXSite, isXUrl, isXStatusUrl, siteHost } from "./util.js";
export { verifySnippet } from "./verify.js";
export { KEY_REJECTED, ENDED_WITHOUT_RESULT } from "./api-agent.js";
