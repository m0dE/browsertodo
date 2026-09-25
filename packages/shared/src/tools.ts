import { z } from "zod";
import { MAX_TABS_PER_CALL } from "./browser.js";

/**
 * MCP tools exposed to Claude Code. The MCP server registers these, the helper
 * executes them. Claude sees them as `mcp__browsertodo__<name>`.
 */
export const MCP_SERVER_NAME = "browsertodo";

/** act's arguments; the field descriptions differ with Jev on (see ToolArgsJev). */
function actArgs(d: { goal: string; index: string; steps: string }) {
  return z.object({
    steps: z
      .array(
        z.object({
          goal: z.string().describe(d.goal),
          text: z.string().optional().describe("Text to enter when this step types into a field"),
          index: z.number().int().optional().describe(d.index),
        }),
      )
      .min(1)
      .max(8)
      .describe(d.steps),
  });
}

export const ToolArgs = {
  navigate: z.object({ url: z.string().describe("Absolute URL to open") }),
  read_page: z.object({
    tabs: z
      .array(z.string())
      .min(1)
      .max(MAX_TABS_PER_CALL)
      .optional()
      .describe("Tab ids (from open_tabs or list_tabs) to read together in one call. Default: the current tab"),
  }),
  screenshot: z.object({}),
  act: actArgs({
    goal: "One small step in plain words, e.g. 'open the post composer'",
    index: "Element index from read_page. When given, the step runs directly on it (types text if given, else clicks) without asking the fast model",
    steps: "Steps done in order by the fast model; stops at the first step it is not confident about",
  }),
  click: z.object({ index: z.number().int().describe("Element index from read_page") }),
  type: z.object({
    index: z.number().int().describe("Element index from read_page"),
    text: z.string(),
  }),
  paste: z.object({ text: z.string().describe("Text inserted at the current focus") }),
  press_key: z.object({
    key: z.string().describe("Key name like Enter, Escape, Tab, ArrowDown, or a combo like Control+Enter"),
  }),
  scroll: z.object({
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).optional().describe("Screens to scroll, default 1"),
    index: z.number().int().optional().describe("Scroll inside this element instead of the page"),
  }),
  upload: z.object({
    index: z.number().int().describe("Index of an <input type=file> from read_page"),
    paths: z.array(z.string()).min(1).describe("Local file paths from the task's media list"),
  }),
  open_tabs: z.object({
    urls: z.array(z.string().describe("Absolute URL")).min(1).max(MAX_TABS_PER_CALL).describe("URLs to open, each in its own new tab"),
    background: z
      .boolean()
      .optional()
      .describe("Default true: open without showing them and keep the current tab. false: show the first new tab and make it the current tab"),
  }),
  switch_tab: z.object({ tab: z.string().describe("Tab id from open_tabs or list_tabs, e.g. t2") }),
  list_tabs: z.object({}),
  close_tabs: z.object({ tabs: z.array(z.string()).min(1).describe("Tab ids to close") }),
  switch_x_account: z.object({ handle: z.string().describe("Account handle, e.g. @myhandle") }),
  get_credential: z.object({ site: z.string().describe("Hostname, e.g. example.com") }),
  task_complete: z.object({
    summary: z.string().describe("What was done"),
    url: z.string().optional().describe("URL of the created post or result, if any"),
  }),
  task_fail: z.object({ reason: z.string() }),
  task_pause: z.object({ reason: z.string().describe("Why a human is needed") }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
export type ToolArgsOf<N extends ToolName> = z.infer<(typeof ToolArgs)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  navigate: "Open a URL in the current tab and wait for it to load.",
  read_page:
    "Get the page URL, title, visible text and an indexed list of interactive elements. Give `tabs` to read several tabs in one call (each under its own header) without switching to them.",
  screenshot: "Capture the visible part of the current tab as an image.",
  act: "Do up to 8 small steps in order, in one call. For each step either describe it in plain words (a fast model picks the element) or give the element index you already know (runs directly). Give text for steps that type. Stops at the first step the fast model is not confident about and returns the page's element list, so you can retry that step with an index.",
  click: "Click an element by index from read_page.",
  type: "Focus an element by index and insert text into it.",
  paste: "Insert text at the current keyboard focus.",
  press_key: "Press a key or key combination.",
  scroll: "Scroll the page or an element.",
  upload: "Attach local files to a file input by index.",
  open_tabs:
    "Open up to 8 URLs at once, each in a new tab, loading in parallel. Waits until all are loaded and returns their tab ids and titles. The current tab stays the same unless background is false.",
  switch_tab: "Make another tab the current tab: read_page, act, navigate, scroll, screenshot and the other tools then act on it.",
  list_tabs: "List this task's tabs with id, URL, title, and which one is current.",
  close_tabs: "Close tabs you opened and no longer need. The tab the task started on is never closed.",
  switch_x_account: "Switch X (Twitter) to another signed-in account using X's account switcher. Verify with a screenshot afterwards.",
  get_credential: "Get the stored username and password for a site. Never use this for X.",
  task_complete: "Finish the task successfully. Call exactly once when the task is fully done.",
  task_fail: "Finish the task as failed when it cannot be done.",
  task_pause: "Stop and ask the human for help: login page, 2FA, CAPTCHA, warning, or anything uncertain.",
};

/**
 * With Jev on, the fast model picks the element of every act step: read_page
 * lists elements without index numbers, and act takes an index only for a
 * step Jev just reported "not confident" about (from the candidates it
 * returned). These replace TOOL_DESCRIPTIONS / ToolArgs entries in that mode.
 */
const JEV_DESCRIPTIONS: Partial<Record<ToolName, string>> = {
  read_page:
    "Get the page URL, title, visible text and a compact list of the interactive elements (role and visible label, no index numbers). Describe the element you want in words in act; the fast picker finds it. Give `tabs` to read several tabs in one call (each under its own header) without switching to them.",
  act: "Do up to 8 small steps in order, in one call. Describe each step's element in words: its visible label and role, and its position when several look alike (e.g. 'click the Reply button under the first post', 'type into the Post text box'); a fast model picks the element. Give text for steps that type. If the fast model is not confident about a step, act stops there and returns a short numbered candidate list for that step only: send that step again with the same goal and the index of the right candidate, then continue. Do not send an index otherwise.",
};

/** The description of a tool, for the given Jev mode. */
export function toolDescription(name: ToolName, jev: boolean): string {
  return (jev && JEV_DESCRIPTIONS[name]) || TOOL_DESCRIPTIONS[name];
}

/** ToolArgs with Jev-mode field descriptions (same shapes, so validation is the same). */
export const ToolArgsJev: typeof ToolArgs = {
  ...ToolArgs,
  act: actArgs({
    goal: "The step and its element in words, precisely: visible label, role, and position if several look alike, e.g. 'click the Reply button under the first post'",
    index: "Only for a step the fast model just reported not confident about: the index of the right element from the candidate list act returned for it (same goal). Never otherwise",
    steps: "Steps done in order; the fast model picks each step's element. Stops at the first step it is not confident about and returns candidates for that step",
  }),
};

/** The input schema of a tool, for the given Jev mode. */
export function toolArgsSchema(name: ToolName, jev: boolean) {
  return (jev ? ToolArgsJev : ToolArgs)[name];
}

export function mcpToolName(name: ToolName): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** Result of a tool call as returned to Claude. */
export interface ToolResult {
  text?: string;
  image?: { base64: string; mimeType: string };
  isError?: boolean;
}

/** RPC method the MCP server calls on the helper over the named pipe. */
export type PipeMethods = {
  "tool.call": { params: { taskId: string; name: ToolName; args: unknown }; result: ToolResult };
  /** jev: the session's act steps are picked by Jev (tool descriptions differ, see toolDescription). */
  "tool.list": { params: { taskId: string }; result: { names: ToolName[]; jev?: boolean } };
}

/** Tools that end a task. Not offered to the user's own Claude Code (mcp-server --attach). */
export const TASK_END_TOOLS: readonly ToolName[] = ["task_complete", "task_fail", "task_pause"];

/** Tools offered to the user's own Claude Code through mcp-server --attach (no task to end). */
export const INTERACTIVE_TOOL_NAMES: ToolName[] = TOOL_NAMES.filter((n) => !TASK_END_TOOLS.includes(n));

/**
 * Tools offered to the model. act (batched steps) always replaces click and
 * type: steps that name an element index run directly; with Jev, steps may
 * instead describe the element in words. The jev flag is kept for callers.
 */
export function toolsFor(opts: { jev: boolean; interactive?: boolean }): ToolName[] {
  return TOOL_NAMES.filter((n) => {
    if (opts.interactive && TASK_END_TOOLS.includes(n)) return false;
    return n !== "click" && n !== "type";
  });
}
