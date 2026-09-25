/**
 * Deterministic brain for tests and end-to-end runs (BROWSERTODO_BRAIN=scripted).
 * It drives the ToolRouter directly, without any model, following a fixed
 * posting script:
 *
 *   1. navigate to the first http(s) URL in the instructions, if any
 *   2. read_page; pause if the page is a login/challenge page
 *   3. switch_x_account(account) when the task names one (pause if it fails),
 *      then navigate to the start URL again (if any) and read_page
 *   4. type the text after the literal "Post:" (or all instructions) into
 *      the first element with role "textbox" (not a file/password input)
 *   5. upload all media to the first input type=file
 *   6. click the element with testid tweetButton or tweetButtonInline
 *      (preferring one named "Post"), then read_page until the URL changes
 *   7. task_complete with the post URL (current URL, the "View" link, or
 *      the newest /status/ link on the account's profile)
 *
 * With Jev on, read_page lists elements in words: steps 4 and 6 go through
 * act with a description, and when Jev is not confident the brain picks the
 * element from the candidates act returns (same goal, with its index).
 *
 * Messages the human sends while it runs are acknowledged with an
 * assistant_text event ("Scripted brain received: ...").
 */
import { mcpToolName, pauseReasonForUrl, type ToolName, type ToolResult } from "@browsertodo/shared";
import { isXUrl, parseSnapshotText, type ParsedPage } from "@browsertodo/core";
import type { Brain, BrainContext } from "./brain.js";

export type CallTool = (taskId: string, name: ToolName, args: unknown) => Promise<ToolResult>;

const POST_BUTTON_TEST_IDS = new Set(["tweetButton", "tweetButtonInline"]);
const LOGIN_TITLE = /\b(log ?in|sign ?in)\b/i;

export function extractPostText(instructions: string): string {
  const i = instructions.indexOf("Post:");
  return (i >= 0 ? instructions.slice(i + "Post:".length) : instructions).trim();
}

export function extractStartUrl(instructions: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/.exec(instructions);
  if (!m) return null;
  // Text after "Post:" is content, not a place to go.
  const post = instructions.indexOf("Post:");
  if (post >= 0 && m.index > post) return null;
  return m[0].replace(/[.,;:!?)]+$/, "");
}

export function loginReason(page: ParsedPage): string | null {
  const byUrl = pauseReasonForUrl(page.url);
  if (byUrl) return byUrl;
  if (page.elements.some((e) => e.type === "password")) return `Login page: ${page.title || page.url}`;
  if (LOGIN_TITLE.test(page.title)) return `Login page: ${page.title}`;
  return null;
}

class Stop extends Error {}

export class ScriptedBrain implements Brain {
  constructor(
    private readonly callTool: CallTool,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; urlPolls?: number; pollMs?: number } = {},
  ) {}

  async run(ctx: BrainContext): Promise<void> {
    const task = ctx.task;
    if (!task) throw new Error("ScriptedBrain needs ctx.task");
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    ctx.input.onMessage((text) => ctx.emit({ type: "assistant_text", text: `Scripted brain received: ${text}` }));
    const offered = (name: ToolName) => ctx.allowedTools.includes(mcpToolName(name));
    const call = async (name: ToolName, args: unknown = {}): Promise<ToolResult> => {
      if (ctx.signal.aborted) throw new Stop();
      // With Jev on, click and type are not offered: send the same action as an act step with the index.
      if ((name === "click" || name === "type") && !offered(name) && offered("act")) {
        const a = args as { index: number; text?: string };
        const step = name === "type" ? { goal: "type the text", index: a.index, text: a.text } : { goal: "click", index: a.index };
        args = { steps: [step] };
        name = "act";
      }
      const r = await this.callTool(ctx.taskId, name, args);
      ctx.log({ type: "scripted_step", name, isError: r.isError ?? false });
      return r;
    };
    const read = async () => parseSnapshotText((await call("read_page")).text ?? "");
    type El = ParsedPage["elements"][number];
    /**
     * Clicks (or types into) an element: by index when read_page gave one,
     * else by describing it to Jev, picking from its candidates when it is unsure.
     */
    const actOn = async (el: El, goal: string, pick: (e: El) => boolean, text?: string): Promise<ToolResult> => {
      if (el.index >= 0) return text !== undefined ? call("type", { index: el.index, text }) : call("click", { index: el.index });
      const step = text !== undefined ? { goal, text } : { goal };
      const r = await call("act", { steps: [step] });
      if (r.isError || !(r.text ?? "").includes("not confident")) return r;
      const candidate = parseSnapshotText(r.text ?? "").elements.filter((e) => e.index >= 0).find(pick);
      if (!candidate) return { text: `no matching candidate for "${goal}"`, isError: true };
      return call("act", { steps: [{ ...step, index: candidate.index }] });
    };
    const finish = async (name: "task_fail" | "task_pause", reason: string) => {
      await call(name, { reason });
    };

    try {
      const startUrl = extractStartUrl(task.instructions);
      if (startUrl) await call("navigate", { url: startUrl });
      let page = await read();
      let pause = loginReason(page);
      if (pause) return await finish("task_pause", pause);

      if (task.account) {
        const r = await call("switch_x_account", { handle: task.account });
        if (r.isError) return await finish("task_pause", `Could not switch to ${task.account}: ${r.text ?? ""}`.slice(0, 1000));
        if (startUrl) await call("navigate", { url: startUrl });
        page = await read();
        pause = loginReason(page);
        if (pause) return await finish("task_pause", pause);
      }

      const findTextbox = () => page.elements.find((e) => e.role === "textbox" && e.type !== "file" && e.type !== "password");
      let textbox = findTextbox();
      if (!textbox && !startUrl && isXUrl(page.url)) {
        // A previous task may have left the tab on a post page; the composer lives on home.
        await call("navigate", { url: "https://x.com/home" });
        page = await read();
        pause = loginReason(page);
        if (pause) return await finish("task_pause", pause);
        textbox = findTextbox();
      }
      if (!textbox) return await finish("task_fail", `No compose textbox found on ${page.url}`);
      const text = extractPostText(task.instructions);
      const isTextbox = (e: El) => e.role === "textbox" && e.type !== "file" && e.type !== "password";
      const typed = await actOn(textbox, `type into the ${textbox.name ? `"${textbox.name}" ` : ""}text box`, isTextbox, text);
      if (typed.isError) return await finish("task_fail", typed.text ?? "typing failed");

      if (task.mediaPaths.length) {
        page = await read();
        const input = page.elements.find((e) => e.tag === "input" && e.type === "file");
        if (!input) return await finish("task_fail", `No file input found on ${page.url}`);
        const up = await call("upload", { index: input.index, paths: task.mediaPaths });
        if (up.isError) return await finish("task_fail", up.text ?? "upload failed");
      }

      page = await read();
      const candidates = page.elements.filter((e) => e.testId && POST_BUTTON_TEST_IDS.has(e.testId));
      const button = candidates.find((e) => e.name.trim().toLowerCase() === "post") ?? candidates[0];
      if (!button) return await finish("task_fail", `No Post button (testid tweetButton/tweetButtonInline) found on ${page.url}`);
      const before = page.url;
      const isPostButton = (e: El) => !!e.testId && POST_BUTTON_TEST_IDS.has(e.testId);
      const clicked = await actOn(button, `click the "${button.name || "Post"}" button (testid ${button.testId})`, isPostButton);
      if (clicked.isError) return await finish("task_fail", clicked.text ?? "click failed");

      // Find the new post's URL the way the system prompt tells Claude to:
      // the URL itself, the "View" link in X's toast, or the profile's newest post.
      const statusLink = () =>
        page.elements.find((e) => e.href && /\/status\/\d+/.test(e.href) && e.name.trim().toLowerCase() === "view") ??
        null;
      const polls = this.opts.urlPolls ?? 5;
      page = await read();
      for (let i = 0; i < polls && page.url === before && !statusLink(); i++) {
        await sleep(this.opts.pollMs ?? 1000);
        page = await read();
      }
      let postUrl = /\/status\/\d+/.test(page.url) ? page.url : (statusLink()?.href ?? null);
      if (!postUrl && task.account && isXUrl(page.url)) {
        await call("navigate", { url: `https://x.com/${task.account.replace(/^@+/, "")}` });
        page = await read();
        postUrl = page.elements.find((e) => e.href && /\/status\/\d+/.test(e.href))?.href ?? null;
      }
      await call("task_complete", { summary: `Posted: ${text.slice(0, 200)}`, url: postUrl ?? page.url });
    } catch (e) {
      if (e instanceof Stop) return;
      throw e;
    }
  }
}
