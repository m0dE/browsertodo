/**
 * Executes MCP tool calls for the running task. Plain tools map 1:1 to a
 * `browser.*` RPC on the extension; `act`, `switch_x_account`,
 * `get_credential` and `task_*` are implemented here.
 */
import {
  ToolArgs,
  TOOL_NAMES,
  type BrowserMethod,
  type BrowserMethods,
  type Screenshot,
  type TaskOutcome,
  type ToolArgsOf,
  type ToolName,
  type ToolResult,
} from "@browsertodo/shared";
import type { EventLogger } from "./logger.js";
import { formatElement, formatElements, formatSnapshot } from "./page-format.js";
import { jevDecide, type JevClientLike } from "./jev.js";
import { switchXAccount } from "./x-account.js";

export const BROWSER_RPC_TIMEOUT_MS = 60_000;

/** Structural view of RpcPeer<BrowserMethods, ...>, so tests can pass a fake. */
export interface BrowserCaller {
  call<M extends BrowserMethod>(
    method: M,
    params: BrowserMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<BrowserMethods[M]["result"]>;
}

export interface TaskFinish {
  outcome: TaskOutcome;
  summary?: string;
  url?: string;
  reason?: string;
}

/** The running task, as seen by the router. Implemented by TaskRunner. */
export interface ToolSession {
  taskId: string;
  allowedTools: ReadonlySet<ToolName>;
  jevThreshold: number;
  /** Called before each tool. Returns an error text to return instead of running it. */
  beforeCall(name: ToolName): string | null;
  finish(result: TaskFinish): void;
  log: EventLogger;
  saveScreenshot?(shot: Screenshot): void;
}

export interface ToolRouterDeps {
  browser: BrowserCaller;
  getSession: () => ToolSession | null;
  jev?: JevClientLike | null;
  sleep?: (ms: number) => Promise<void>;
  browserTimeoutMs?: number;
  switchConfirmTimeoutMs?: number;
}

const X_CREDENTIAL_HOSTS = ["x.com", "twitter.com"];

export function siteHost(site: string): string {
  const s = site.trim().toLowerCase();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "");
  } catch {
    return s;
  }
}

export function isXSite(site: string): boolean {
  const host = siteHost(site);
  return X_CREDENTIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const err = (text: string): ToolResult => ({ text, isError: true });
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ToolRouter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ToolRouterDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.timeoutMs = deps.browserTimeoutMs ?? BROWSER_RPC_TIMEOUT_MS;
  }

  /** Tool names the given task may use (for `tool.list`). */
  allowedTools(taskId: string): ToolName[] {
    const s = this.deps.getSession();
    return s && s.taskId === taskId ? TOOL_NAMES.filter((n) => s.allowedTools.has(n)) : [];
  }

  async call(taskId: string, name: ToolName, args: unknown): Promise<ToolResult> {
    const session = this.deps.getSession();
    if (!session || session.taskId !== taskId) return err(`No running task ${taskId}. Stop now.`);
    if (!(TOOL_NAMES as string[]).includes(name) || !session.allowedTools.has(name)) {
      return err(`Tool ${name} is not available for this task.`);
    }
    const blocked = session.beforeCall(name);
    if (blocked) {
      session.log({ type: "tool_blocked", name, reason: blocked });
      return err(blocked);
    }
    const parsed = ToolArgs[name].safeParse(args ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
      session.log({ type: "tool_invalid", name, args, error: msg });
      return err(`Invalid arguments for ${name}: ${msg}`);
    }
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await this.run(session, name, parsed.data);
    } catch (e) {
      result = err(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    session.log({
      type: "tool_call",
      name,
      args: parsed.data,
      ms: Date.now() - started,
      isError: result.isError ?? false,
      text: name === "get_credential" ? "[redacted]" : result.text?.slice(0, 1000),
      image: result.image ? `${result.image.mimeType} ${result.image.base64.length} b64 chars` : undefined,
    });
    return result;
  }

  private browser<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]): Promise<BrowserMethods[M]["result"]> {
    return this.deps.browser.call(method, params, { timeoutMs: this.timeoutMs });
  }

  private async readPageText(): Promise<string> {
    return formatSnapshot(await this.browser("browser.readPage", {}));
  }

  private async run(session: ToolSession, name: ToolName, a: unknown): Promise<ToolResult> {
    switch (name) {
      case "navigate": {
        const { url } = a as ToolArgsOf<"navigate">;
        const r = await this.browser("browser.navigate", { url });
        return { text: `Navigated to ${r.url}\nTitle: ${r.title}` };
      }
      case "read_page":
        return { text: await this.readPageText() };
      case "screenshot": {
        const shot = await this.browser("browser.screenshot", {});
        session.saveScreenshot?.(shot);
        return { image: { base64: shot.base64, mimeType: shot.mimeType } };
      }
      case "click": {
        const { index } = a as ToolArgsOf<"click">;
        await this.browser("browser.click", { index });
        return { text: `Clicked [${index}].` };
      }
      case "type": {
        const { index, text } = a as ToolArgsOf<"type">;
        await this.browser("browser.type", { index, text });
        return { text: `Typed ${text.length} characters into [${index}].` };
      }
      case "paste": {
        const { text } = a as ToolArgsOf<"paste">;
        await this.browser("browser.paste", { text });
        return { text: `Inserted ${text.length} characters at the focus.` };
      }
      case "press_key": {
        const { key } = a as ToolArgsOf<"press_key">;
        await this.browser("browser.pressKey", { key });
        return { text: `Pressed ${key}.` };
      }
      case "scroll": {
        const { direction, amount, index } = a as ToolArgsOf<"scroll">;
        const params: BrowserMethods["browser.scroll"]["params"] = { direction };
        if (amount !== undefined) params.amount = amount;
        if (index !== undefined) params.index = index;
        await this.browser("browser.scroll", params);
        return { text: `Scrolled ${direction}${amount ? ` ${amount}x` : ""}${index !== undefined ? ` inside [${index}]` : ""}.` };
      }
      case "upload": {
        const { index, paths } = a as ToolArgsOf<"upload">;
        await this.browser("browser.upload", { index, paths });
        return { text: `Attached ${paths.length} file(s) to [${index}].` };
      }
      case "get_credential": {
        const { site } = a as ToolArgsOf<"get_credential">;
        if (isXSite(site)) return err("get_credential is never used for X. Sign-in to X is done by the human; call task_pause if X asks to log in.");
        const host = siteHost(site);
        const r = await this.browser("vault.getCredential", { site: host });
        if (!r.found) {
          return r.locked
            ? err("The vault is locked. Call task_pause with the reason 'unlock the vault'.")
            : err(`No credential is stored for ${host}. Call task_pause if a login is required.`);
        }
        return { text: `username: ${r.username}\npassword: ${r.password}` };
      }
      case "switch_x_account": {
        const { handle } = a as ToolArgsOf<"switch_x_account">;
        const deps: { sleep: (ms: number) => Promise<void>; confirmTimeoutMs?: number } = { sleep: this.sleep };
        if (this.deps.switchConfirmTimeoutMs !== undefined) deps.confirmTimeoutMs = this.deps.switchConfirmTimeoutMs;
        return switchXAccount({ call: (m, p) => this.browser(m, p) }, handle, deps);
      }
      case "act":
        return this.act(session, (a as ToolArgsOf<"act">).goal);
      case "task_complete": {
        const { summary, url } = a as ToolArgsOf<"task_complete">;
        const r: TaskFinish = { outcome: "done", summary };
        if (url) r.url = url;
        session.finish(r);
        return { text: "Task recorded as done. Stop now." };
      }
      case "task_fail": {
        session.finish({ outcome: "failed", reason: (a as ToolArgsOf<"task_fail">).reason });
        return { text: "Task recorded as failed. Stop now." };
      }
      case "task_pause": {
        session.finish({ outcome: "paused", reason: (a as ToolArgsOf<"task_pause">).reason });
        return { text: "Task paused for the human. Stop now." };
      }
    }
  }

  private async act(session: ToolSession, goal: string): Promise<ToolResult> {
    const jev = this.deps.jev;
    if (!jev) return err("act is not available; use read_page, click and type.");
    const snapshot = await this.browser("browser.readPage", {});
    const notConfident = (why: string) => ({
      text: `not confident (${why}). Choose yourself with click/type using this list:\nURL: ${snapshot.url}\n${formatElements(snapshot.elements, snapshot.truncated)}`,
    });
    let d;
    try {
      d = await jevDecide({ goal, snapshot }, jev, session.log);
    } catch (e) {
      session.log({ type: "jev_error", message: e instanceof Error ? e.message : String(e) });
      return notConfident("Jev is unavailable");
    }
    const conf = `${d.operation}, confidence ${d.confidence.toFixed(2)}`;
    if (d.operation === "blocked" || d.confidence < session.jevThreshold) return notConfident(conf);
    const target = d.index === null ? undefined : snapshot.elements.find((e) => e.index === d.index);
    const describe = target ? formatElement(target) : `[${d.index}]`;
    switch (d.operation) {
      case "type":
        return { text: `Jev chose to type into ${describe}; call type yourself with the index and the text.` };
      case "press_key":
        return { text: `Jev chose to press a key${target ? ` on ${describe}` : ""}; call press_key yourself with the key.` };
      case "click": {
        if (!target) return notConfident(`${conf}, but no valid target`);
        await this.browser("browser.click", { index: target.index });
        await this.sleep(500);
        return { text: `Jev clicked ${describe}.\n\n${await this.readPageText()}` };
      }
      case "scroll":
        await this.browser("browser.scroll", { direction: "down" });
        return { text: `Jev scrolled down.\n\n${await this.readPageText()}` };
      case "wait":
        await this.sleep(1000);
        return { text: `Jev waited 1 s for the page.\n\n${await this.readPageText()}` };
      case "done":
        return { text: `Jev thinks the goal is already done. Verify with a screenshot.\n\n${await this.readPageText()}` };
    }
  }
}
