/**
 * Tool execution shared by both brains. Plain tools map 1:1 to browser.*
 * calls; switch_x_account, get_credential, upload checks and task_* are
 * implemented here, act in act.ts. Every call emits tool_call and
 * tool_result events (and one jev event per act decision). Never throws.
 */
import {
  clipEventText,
  delay,
  errorMessage,
  isXSite,
  OUT_OF_CREDIT,
  picksText,
  siteHost,
  TOOL_NAMES,
  ToolArgs,
  type AgentEvent,
  type BrowserMethod,
  type BrowserMethods,
  type ElementPicks,
  type TaskRunResult,
  type ToolArgsOf,
  type ToolName,
  type ToolResult,
} from "@browsertodo/shared";
import type { BrowserCaller, ToolExecutor, ToolExecutorOptions } from "./types.js";
import { createActGate, runAct } from "./act.js";
import { formatScroll, formatSnapshot, formatTabs, formatTabSnapshots } from "./page-format.js";
import { mapStrings, SecretRedactor } from "./redact.js";
import { switchXAccount } from "./x-account.js";

/** Answer of task_* tools when the executor has no task to end (mcp-server --attach). */
export const NO_TASK_TO_END = "no task to end in an attached session";

const err = (text: string): ToolResult => ({ text, isError: true });

/** Tools that do not change the page: the steps Jev left to the model stay open across them. */
const KEEPS_PENDING = new Set<string>(["act", "read_page", "screenshot", "list_tabs"]);

/** The status line at the end of a turn with Jev on: who picked act's elements. Null when nothing was picked. */
export function picksEvent(picks: ElementPicks): AgentEvent | null {
  if (picks.jev + picks.claude === 0) return null;
  return { type: "status", text: picksText(picks), picks };
}

/** A task_* result with the agent's follow-up suggestion, when it gave one. */
function withSuggestion(r: TaskRunResult, suggestion: string | undefined): TaskRunResult {
  return suggestion ? { ...r, suggestion } : r;
}

/** Case- and slash-insensitive path key, for comparing upload paths with mediaPaths. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const sleep = opts.sleep ?? delay;
  const secrets = opts.secrets ?? new SecretRedactor();
  /** Allowed upload paths by pathKey, to the exact path the task listed. */
  const allowedMedia = new Map(opts.mediaPaths.map((p) => [pathKey(p), p]));
  let nextId = 1;
  /** Jev on: read_page lists elements in words and act steps name indices only after Jev was unsure. */
  const jevOn = opts.jev !== null;
  const gate = createActGate();

  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent(secrets.redact(e));
    } catch {
      /* a listener must not break tool execution */
    }
  };
  /** Notes the browser attaches to results (e.g. "Using fallback mode…"), shown once with the next tool result. */
  const notes: string[] = [];
  const browser = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => {
    const r = await opts.browser.call(method, params);
    const note = r && typeof r === "object" ? (r as { note?: unknown }).note : undefined;
    if (typeof note === "string" && note && !notes.includes(note)) notes.push(note);
    return r;
  };
  const noted: BrowserCaller = { call: browser };

  const endTask = (r: TaskRunResult, reply: string): ToolResult => {
    if (!opts.onTaskEnd) return err(`${NO_TASK_TO_END}. Just tell the human what happened.`);
    opts.onTaskEnd(r);
    return { text: reply };
  };

  async function run(name: ToolName, a: unknown): Promise<ToolResult> {
    switch (name) {
      case "navigate": {
        const r = await browser("browser.navigate", { url: (a as ToolArgsOf<"navigate">).url });
        return { text: `Navigated to ${r.url}\nTitle: ${r.title}` };
      }
      case "read_page": {
        const { tabs } = a as ToolArgsOf<"read_page">;
        if (!tabs) return { text: formatSnapshot(await browser("browser.readPage", {}), { words: jevOn }) };
        // Every tab is read at the same time; one failing tab does not hide the others.
        const ids = [...new Set(tabs)];
        const reads = await Promise.all(
          ids.map((tab) =>
            browser("browser.readPage", { tab }).then(
              (snap) => ({ tab, snap }),
              (e: unknown) => ({ tab, error: errorMessage(e) }),
            ),
          ),
        );
        const text = formatTabSnapshots(reads, { words: jevOn });
        return reads.every((r) => "error" in r) ? err(text) : { text };
      }
      case "open_tabs": {
        const { urls, background } = a as ToolArgsOf<"open_tabs">;
        const params: BrowserMethods["browser.openTabs"]["params"] = { urls };
        if (background !== undefined) params.background = background;
        const r = await browser("browser.openTabs", params);
        const ids = r.tabs.map((t) => t.id);
        return {
          text: `Opened ${r.tabs.length} tab(s):\n${formatTabs(r.tabs)}\nRead them together with read_page {"tabs": ${JSON.stringify(ids)}}; use switch_tab to act in one.`,
        };
      }
      case "switch_tab": {
        const t = await browser("browser.switchTab", { tab: (a as ToolArgsOf<"switch_tab">).tab });
        return { text: `Current tab is now ${t.id}: ${t.url}\nTitle: ${t.title}` };
      }
      case "list_tabs":
        return { text: formatTabs((await browser("browser.listTabs", {})).tabs) };
      case "close_tabs": {
        const r = await browser("browser.closeTabs", { tabs: (a as ToolArgsOf<"close_tabs">).tabs });
        return { text: `Closed ${r.closed.length ? r.closed.join(", ") : "no tabs"}. Open tabs:\n${formatTabs(r.tabs)}` };
      }
      case "screenshot": {
        const shot = await browser("browser.screenshot", {});
        return { image: { base64: shot.base64, mimeType: shot.mimeType } };
      }
      case "click": {
        const { index } = a as ToolArgsOf<"click">;
        await browser("browser.click", { index });
        return { text: `Clicked [${index}].` };
      }
      case "type": {
        const { index, text } = a as ToolArgsOf<"type">;
        await browser("browser.type", { index, text });
        return { text: `Typed ${text.length} characters into [${index}].` };
      }
      case "paste": {
        const { text } = a as ToolArgsOf<"paste">;
        await browser("browser.paste", { text });
        return { text: `Inserted ${text.length} characters at the focus.` };
      }
      case "press_key": {
        const { key } = a as ToolArgsOf<"press_key">;
        await browser("browser.pressKey", { key });
        return { text: `Pressed ${key}.` };
      }
      case "scroll": {
        const { direction, amount, index } = a as ToolArgsOf<"scroll">;
        const params: BrowserMethods["browser.scroll"]["params"] = { direction };
        if (amount !== undefined) params.amount = amount;
        if (index !== undefined) params.index = index;
        const r = await browser("browser.scroll", params);
        return { text: formatScroll({ direction, amount, index }, r ?? {}) };
      }
      case "upload": {
        const { index, paths } = a as ToolArgsOf<"upload">;
        const bad = paths.filter((p) => !allowedMedia.has(pathKey(p)));
        if (bad.length) {
          const allowed = opts.mediaPaths.length ? opts.mediaPaths.map((p) => `- ${p}`).join("\n") : "(none)";
          return err(`upload refused: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not in the task's media list. Allowed files:\n${allowed}`);
        }
        // The files exactly as the task listed them: the check above ignores case and slashes, a file system may not.
        await browser("browser.upload", { index, paths: paths.map((p) => allowedMedia.get(pathKey(p))!) });
        return { text: `Attached ${paths.length} file(s) to [${index}].` };
      }
      case "get_credential": {
        const { site } = a as ToolArgsOf<"get_credential">;
        if (isXSite(site)) return err("get_credential is never used for X. Sign-in to X is done by the human; call task_pause if X asks to log in.");
        const host = siteHost(site);
        const r = await browser("vault.getCredential", { site: host });
        if (!r.found) {
          return r.locked
            ? err(
                `The user's saved site logins are locked. If ${host} is asking you to sign in, call task_pause with the reason "Sign in to ${host} in this tab (or unlock saved logins in Settings > Site logins), then press Continue."`,
              )
            : err(
                `No login is saved for ${host}. First check whether the user is already signed in there. Only if it shows a sign-in page, call task_pause with the reason "Please sign in to ${host} in this tab, then press Continue." Never mention a vault.`,
              );
        }
        secrets.add(r.password);
        return { text: `username: ${r.username}\npassword: ${r.password}` };
      }
      case "switch_x_account":
        return switchXAccount(noted, (a as ToolArgsOf<"switch_x_account">).handle, { sleep });
      case "act":
        return runAct((a as ToolArgsOf<"act">).steps, {
          browser,
          jev: opts.jev,
          jevThreshold: opts.jevThreshold,
          sleep,
          emit,
          gate,
          // The hosted Jev and the hosted AI share one credit: pause the task, like a 402 from the Messages API does.
          outOfCredit: () => endTask({ outcome: "paused", reason: OUT_OF_CREDIT }, "Task paused: the account is out of usage credit. Stop now."),
        });
      case "task_complete": {
        const { summary, url, suggestion } = a as ToolArgsOf<"task_complete">;
        const r: TaskRunResult = { outcome: "done", summary };
        if (url) r.url = url;
        return endTask(withSuggestion(r, suggestion), "Task recorded as done. Stop now.");
      }
      case "task_fail": {
        const { reason, suggestion } = a as ToolArgsOf<"task_fail">;
        return endTask(withSuggestion({ outcome: "failed", reason }, suggestion), "Task recorded as failed. Stop now.");
      }
      case "task_pause": {
        const { reason, suggestion } = a as ToolArgsOf<"task_pause">;
        return endTask(withSuggestion({ outcome: "paused", reason }, suggestion), "Task paused for the human. Stop now.");
      }
    }
  }

  return {
    takePicks() {
      const p = { ...gate.picks };
      gate.picks = { jev: 0, claude: 0 };
      return p;
    },
    async call(name: ToolName, args: unknown): Promise<ToolResult> {
      const id = `t${nextId++}`;
      // Candidates Jev left to the model stay valid only while the page is left alone.
      if (!KEEPS_PENDING.has(name)) gate.pending.clear();
      // Arguments can be long (a pasted text): each string is clipped like any other event text.
      emit({ type: "tool_call", id, name, args: mapStrings(args ?? {}, (s) => clipEventText(s)) });
      let result: ToolResult;
      try {
        if (!(TOOL_NAMES as string[]).includes(name)) {
          result = err(`Unknown tool ${String(name)}.`);
        } else {
          const parsed = ToolArgs[name].safeParse(args ?? {});
          if (!parsed.success) {
            const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
            result = err(`Invalid arguments for ${name}: ${msg}`);
          } else {
            result = await run(name, parsed.data);
          }
        }
      } catch (e) {
        result = err(`${name} failed: ${errorMessage(e)}`);
      }
      if (notes.length) {
        // Both the model and the Activity log see why the page behaves differently.
        const prefix = notes.splice(0).join("\n");
        result = { ...result, text: result.text ? `${prefix}\n${result.text}` : prefix };
      }
      const ev: Extract<AgentEvent, { type: "tool_result" }> = { type: "tool_result", id, name };
      const text = name === "get_credential" && !result.isError ? "[credential redacted]" : (result.text ?? (result.image ? "[screenshot]" : undefined));
      if (text !== undefined) ev.text = clipEventText(text);
      if (result.isError) ev.isError = true;
      emit(ev);
      return result;
    },
  };
}
