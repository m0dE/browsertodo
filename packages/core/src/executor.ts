/**
 * Tool execution shared by both brains. Plain tools map 1:1 to browser.*
 * calls; act (Jev), switch_x_account, get_credential, upload checks and
 * task_* are implemented here. Every call emits tool_call and tool_result
 * events (and one jev event per act decision). Never throws.
 */
import {
  ToolArgs,
  TOOL_NAMES,
  clipEventText,
  type AgentEvent,
  type BrowserMethod,
  type BrowserMethods,
  type PageSnapshot,
  type TaskRunResult,
  type ToolArgsOf,
  type ToolName,
  type ToolResult,
} from "@browsertodo/shared";
import type { JevDecision, ToolExecutor, ToolExecutorOptions } from "./types.js";
import { formatCompact, formatElement, formatSnapshot } from "./page-format.js";
import { switchXAccount } from "./x-account.js";
import { defaultSleep, errorMessage, isXSite, siteHost } from "./util.js";

/** Marker in act results when a step was not executed; the API brain unlocks click/type on it. */
export const NOT_CONFIDENT = "not confident";
export const NO_TASK_TO_END = "no task to end in the interactive terminal";

const err = (text: string): ToolResult => ({ text, isError: true });

/** Case- and slash-insensitive path key, for comparing upload paths with mediaPaths. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

type Step = ToolArgsOf<"act">["steps"][number];

export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const sleep = opts.sleep ?? defaultSleep;
  const allowedMedia = new Set(opts.mediaPaths.map(pathKey));
  let count = 0;
  let nextId = 1;

  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent(e);
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
  const readPage = () => browser("browser.readPage", {});

  const endTask = (r: TaskRunResult, reply: string): ToolResult => {
    if (!opts.onTaskEnd) return err(`${NO_TASK_TO_END}. Just tell the human what happened.`);
    opts.onTaskEnd(r);
    return { text: reply };
  };

  async function act(steps: Step[]): Promise<ToolResult> {
    const jev = opts.jev;
    const lines: string[] = [];
    const stop = (n: number, why: string, snap: PageSnapshot): ToolResult => {
      lines.push(`step ${n}: ${why}`);
      const rest = steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run.` : "";
      return {
        text: `${lines.join("\n")}\n\n${NOT_CONFIDENT} at step ${n}.${rest} Send step ${n} again with the element index from this list (e.g. {goal, index, text}), then continue:\n${formatCompact(snap)}`,
      };
    };

    for (let i = 0; i < steps.length; i++) {
      const n = i + 1;
      const step = steps[i]!;
      if (step.index !== undefined) {
        // The model already knows the element: run the step directly.
        try {
          if (step.text !== undefined && step.text !== "") {
            await browser("browser.type", { index: step.index, text: step.text });
            lines.push(`step ${n}: typed ${step.text.length} characters into [${step.index}] (direct)`);
            await sleep(300);
          } else {
            await browser("browser.click", { index: step.index });
            lines.push(`step ${n}: clicked [${step.index}] (direct)`);
            await sleep(500);
          }
        } catch (e) {
          return stop(n, `"${step.goal}": could not use element [${step.index}]: ${errorMessage(e)}`, await readPage());
        }
        continue;
      }
      if (!jev) return stop(n, `"${step.goal}": the fast model is off, so every step needs an element index`, await readPage());
      const snap = await readPage();
      const started = Date.now();
      let d: JevDecision;
      try {
        d = await jev.decide({ goal: step.goal, snapshot: snap });
      } catch (e) {
        emit({ type: "jev", goal: step.goal, operation: "error", index: null, confidence: 0, executed: false, ms: Date.now() - started });
        return stop(n, `"${step.goal}": Jev is unavailable (${errorMessage(e)})`, snap);
      }
      const ms = Date.now() - started;
      const target = d.index === null ? undefined : snap.elements.find((e) => e.index === d.index);
      const conf = `${d.operation}, confidence ${d.confidence.toFixed(2)}`;
      const jevEvent = (executed: boolean) =>
        emit({ type: "jev", goal: step.goal, operation: d.operation, index: d.index, confidence: d.confidence, executed, ms });

      if (d.operation === "blocked" || d.confidence < opts.jevThreshold) {
        jevEvent(false);
        return stop(n, `"${step.goal}": ${conf}`, snap);
      }
      switch (d.operation) {
        case "click": {
          if (!target) {
            jevEvent(false);
            return stop(n, `"${step.goal}": ${conf}, but element [${d.index}] does not exist`, snap);
          }
          await browser("browser.click", { index: target.index });
          jevEvent(true);
          lines.push(`step ${n}: clicked ${formatElement(target)}`);
          await sleep(500);
          break;
        }
        case "type": {
          if (step.text === undefined || step.text === "") {
            jevEvent(false);
            return stop(n, `"${step.goal}": Jev chose to type into ${target ? formatElement(target) : `[${d.index}]`}, but this step has no text`, snap);
          }
          if (!target) {
            jevEvent(false);
            return stop(n, `"${step.goal}": ${conf}, but element [${d.index}] does not exist`, snap);
          }
          await browser("browser.type", { index: target.index, text: step.text });
          jevEvent(true);
          lines.push(`step ${n}: typed ${step.text.length} characters into ${formatElement(target)}`);
          await sleep(300);
          break;
        }
        case "scroll":
          await browser("browser.scroll", { direction: "down" });
          jevEvent(true);
          lines.push(`step ${n}: scrolled down`);
          break;
        case "press_key":
          jevEvent(false);
          return stop(n, `"${step.goal}": Jev chose to press a key${target ? ` on ${formatElement(target)}` : ""}; call press_key yourself`, snap);
        case "wait":
          await sleep(1000);
          jevEvent(true);
          lines.push(`step ${n}: waited 1 s for the page`);
          break;
        case "done": {
          jevEvent(true);
          lines.push(`step ${n}: "${step.goal}" is already done`);
          const rest = steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run; send them again if they are still needed.` : "";
          return { text: `${lines.join("\n")}\nJev ended the batch at step ${n}.${rest}\n\n${formatSnapshot(await readPage())}` };
        }
      }
    }
    return { text: `${lines.join("\n")}\nAll ${steps.length} step(s) done. Verify the result.\n\n${formatSnapshot(await readPage())}` };
  }

  async function run(name: ToolName, a: unknown): Promise<ToolResult> {
    switch (name) {
      case "navigate": {
        const r = await browser("browser.navigate", { url: (a as ToolArgsOf<"navigate">).url });
        return { text: `Navigated to ${r.url}\nTitle: ${r.title}` };
      }
      case "read_page":
        return { text: formatSnapshot(await readPage()) };
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
        await browser("browser.scroll", params);
        return { text: `Scrolled ${direction}${amount ? ` ${amount}x` : ""}${index !== undefined ? ` inside [${index}]` : ""}.` };
      }
      case "upload": {
        const { index, paths } = a as ToolArgsOf<"upload">;
        const bad = paths.filter((p) => !allowedMedia.has(pathKey(p)));
        if (bad.length) {
          const allowed = opts.mediaPaths.length ? opts.mediaPaths.map((p) => `- ${p}`).join("\n") : "(none)";
          return err(`upload refused: ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not in the task's media list. Allowed files:\n${allowed}`);
        }
        await browser("browser.upload", { index, paths });
        return { text: `Attached ${paths.length} file(s) to [${index}].` };
      }
      case "get_credential": {
        const { site } = a as ToolArgsOf<"get_credential">;
        if (isXSite(site)) return err("get_credential is never used for X. Sign-in to X is done by the human; call task_pause if X asks to log in.");
        const host = siteHost(site);
        const r = await browser("vault.getCredential", { site: host });
        if (!r.found) {
          return r.locked
            ? err("The vault is locked. Call task_pause with the reason 'unlock the vault'.")
            : err(`No credential is stored for ${host}. Call task_pause if a login is required.`);
        }
        return { text: `username: ${r.username}\npassword: ${r.password}` };
      }
      case "switch_x_account":
        return switchXAccount(opts.browser, (a as ToolArgsOf<"switch_x_account">).handle, { sleep });
      case "act":
        return act((a as ToolArgsOf<"act">).steps);
      case "task_complete": {
        const { summary, url } = a as ToolArgsOf<"task_complete">;
        const r: TaskRunResult = { outcome: "done", summary };
        if (url) r.url = url;
        return endTask(r, "Task recorded as done. Stop now.");
      }
      case "task_fail":
        return endTask({ outcome: "failed", reason: (a as ToolArgsOf<"task_fail">).reason }, "Task recorded as failed. Stop now.");
      case "task_pause":
        return endTask({ outcome: "paused", reason: (a as ToolArgsOf<"task_pause">).reason }, "Task paused for the human. Stop now.");
    }
  }

  return {
    get callCount() {
      return count;
    },
    async call(name: ToolName, args: unknown): Promise<ToolResult> {
      count++;
      const id = `t${nextId++}`;
      emit({ type: "tool_call", id, name, args: args ?? {} });
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
