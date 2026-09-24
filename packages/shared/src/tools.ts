import { z } from "zod";

/**
 * MCP tools exposed to Claude Code. The MCP server registers these, the helper
 * executes them. Claude sees them as `mcp__browsertodo__<name>`.
 */
export const MCP_SERVER_NAME = "browsertodo";

export const ToolArgs = {
  navigate: z.object({ url: z.string().describe("Absolute URL to open") }),
  read_page: z.object({}),
  screenshot: z.object({}),
  act: z.object({
    goal: z.string().describe("One small step in plain words, e.g. 'open the post composer'"),
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
  navigate: "Open a URL in the agent tab and wait for it to load.",
  read_page: "Get the page URL, title, visible text and an indexed list of interactive elements.",
  screenshot: "Capture the visible part of the page as an image.",
  act: "Perform one small step described in plain words. A fast model picks the element. Returns what it did, or 'not confident' so you can use click/type yourself.",
  click: "Click an element by index from read_page.",
  type: "Focus an element by index and insert text into it.",
  paste: "Insert text at the current keyboard focus.",
  press_key: "Press a key or key combination.",
  scroll: "Scroll the page or an element.",
  upload: "Attach local files to a file input by index.",
  switch_x_account: "Switch X (Twitter) to another signed-in account using X's account switcher. Verify with a screenshot afterwards.",
  get_credential: "Get the stored username and password for a site. Never use this for X.",
  task_complete: "Finish the task successfully. Call exactly once when the task is fully done.",
  task_fail: "Finish the task as failed when it cannot be done.",
  task_pause: "Stop and ask the human for help: login page, 2FA, CAPTCHA, warning, or anything uncertain.",
};

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
  "tool.list": { params: { taskId: string }; result: { names: ToolName[] } };
}
