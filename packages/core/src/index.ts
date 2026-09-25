/**
 * @browsertodo/core: agent logic shared by the helper (Claude Code brain, via
 * MCP) and the extension (Claude API brain, in the service worker).
 * Browser- and Node-safe: no Node-only imports, no process.env.
 */
export * from "./types.js";

/** Tool execution shared by both brains. */
export { createToolExecutor } from "./executor.js";
/** Jev client over fetch (works in the extension and in Node). */
export { createJev, type CreateJevOptions } from "./jev.js";
/** A hosted-AI request refused for lack of usage credit (HTTP 402). */
export { OutOfCreditError } from "./api-errors.js";
/** System prompt for either brain, the first user message of a task, and how later messages are framed. */
export { buildFollowUpMessage, buildSystemPrompt, buildTaskPrompt, FOLLOW_UP_PREFIX, humanMessage, type FollowUpMessage } from "./prompts.js";
/** Compact text form of a snapshot (as returned by read_page), and its parser for the helper's scripted brain. */
export { formatSnapshot, parseSnapshotText, type ParsedPage } from "./page-format.js";
/** Failure reasons the agents report, and their sorting into temporary (retry later) or permanent. */
export { agentError, classifyFailure, ENDED_WITHOUT_RESULT, EXITED_WITHOUT_RESULT } from "./failures.js";
/** A turn's tool call budget, time limit and closing events, the same for both brains. */
export { isTaskEndTool, timeLimitReached, toolBudget, toolCallLimitExceeded, toolCallLimitReached, turnEndEvents, type ToolBudget } from "./turn-rules.js";
/** Marker in act results when Jev was not sure about a step (the result then lists candidates for it). */
export { NOT_CONFIDENT } from "./act.js";
/** Checks independently that an X post exists and shows the expected text. */
export { verifyXPost } from "./verify.js";
/** Claude API agent loop (Anthropic Messages API with tool use). */
export { startApiAgent } from "./api-agent.js";
