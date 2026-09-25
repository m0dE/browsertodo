/**
 * The act tool: up to 8 small steps in one call. A step that names an element
 * index runs directly; otherwise Jev picks the operation and element. The
 * batch stops at the first step that cannot be done confidently and returns
 * the element list so the model can retry that step with an index.
 */
import type { AgentEvent, BrowserMethod, BrowserMethods, PageSnapshot, ToolArgsOf, ToolResult } from "@browsertodo/shared";
import type { JevDecision, JevLike } from "./types.js";
import { formatCompact, formatElement, formatSnapshot } from "./page-format.js";
import { errorMessage } from "./util.js";

/** Marker in act results when a step was not executed. */
const NOT_CONFIDENT = "not confident";

type Step = ToolArgsOf<"act">["steps"][number];

export interface ActContext {
  browser: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  jev: JevLike | null;
  jevThreshold: number;
  sleep: (ms: number) => Promise<void>;
  emit: (e: AgentEvent) => void;
}

export async function runAct(steps: Step[], ctx: ActContext): Promise<ToolResult> {
  const { browser, jev, sleep, emit } = ctx;
  const readPage = () => browser("browser.readPage", {});
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
          lines.push(`step ${n}: typed ${step.text.length} characters into [${step.index}] (picked by Claude)`);
          await sleep(300);
        } else {
          await browser("browser.click", { index: step.index });
          lines.push(`step ${n}: clicked [${step.index}] (picked by Claude)`);
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

    if (d.operation === "blocked" || d.confidence < ctx.jevThreshold) {
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
        lines.push(`step ${n}: clicked ${formatElement(target)} (picked by Jev, ${d.confidence.toFixed(2)}, ${ms} ms)`);
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
        lines.push(`step ${n}: typed ${step.text.length} characters into ${formatElement(target)} (picked by Jev, ${d.confidence.toFixed(2)}, ${ms} ms)`);
        await sleep(300);
        break;
      }
      case "scroll":
        await browser("browser.scroll", { direction: "down" });
        jevEvent(true);
        lines.push(`step ${n}: scrolled down (picked by Jev)`);
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
