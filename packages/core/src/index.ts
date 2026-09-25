/**
 * @browsertodo/core: agent logic shared by the helper (Claude Code brain, via
 * MCP) and the extension (Claude API brain, in the service worker).
 * Browser- and Node-safe: no Node-only imports, no process.env.
 */
export * from "./types.js";

/** Tool execution shared by both brains. */
export { createToolExecutor } from "./executor.js";
/** Jev client over fetch (works in the extension and in Node). */
export { createJev } from "./jev.js";
/** System prompt for either brain, and the first user message of a task. */
export { buildSystemPrompt, buildTaskPrompt } from "./prompts.js";
/** Compact text form of a snapshot (as returned by read_page), and its parser for the helper's scripted brain. */
export { formatSnapshot, parseSnapshotText, type ParsedPage } from "./page-format.js";
/** Sorts a failure reason into temporary (retry later) or permanent. */
export { classifyFailure } from "./failures.js";
/** Checks independently that an X post exists and shows the expected text. */
export { verifyXPost } from "./verify.js";
/** Claude API agent loop (Anthropic Messages API with tool use). */
export { FOLLOW_UP_PREFIX, startApiAgent } from "./api-agent.js";
/** X URL checks (defined in @browsertodo/shared), re-exported for existing callers. */
export { isXUrl, isXStatusUrl } from "@browsertodo/shared";
