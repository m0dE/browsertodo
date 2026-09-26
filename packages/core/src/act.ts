/**
 * The act tool: up to MAX_ACT_STEPS small steps in one call. A step with text
 * fills a field (or chooses a dropdown's option), a step with checked sets a
 * checkbox or radio button, any other step clicks.
 *
 * Jev off: every step names an element index from read_page and runs directly.
 *
 * Jev on: Jev picks the element of every step from its words. A step may name
 * an index only when Jev was not confident about that same step in the
 * previous act result, and only an index from the candidates listed for it
 * (once). The batch stops at the first step Jev is not sure about and
 * returns candidates for that step only, so the model can pick one.
 */
import { errorMessage, type AgentEvent, type BrowserMethod, type BrowserMethods, type ElementInfo, type ElementPicks, type PageSnapshot, type Sleep, type ToolArgsOf, type ToolResult } from "@browsertodo/shared";
import { OutOfCreditError } from "./api-errors.js";
import type { JevDecision, JevLike } from "./types.js";
import { formatCompact, formatElement, formatSnapshot } from "./page-format.js";

/** Marker in act results when a step was not executed. */
export const NOT_CONFIDENT = "not confident";
/** Candidates returned for a step Jev was not sure about. */
export const MAX_CANDIDATES = 40;
/** Time the page gets to react after act types into an element. */
export const SETTLE_AFTER_TYPE_MS = 300;
/** Time the page gets to react after act clicks an element. */
export const SETTLE_AFTER_CLICK_MS = 500;
/** How long a step waits when Jev says the page is still loading. */
export const JEV_WAIT_MS = 1000;

type Step = ToolArgsOf<"act">["steps"][number];

/**
 * Per-executor act state: which steps may name an index (Jev mode), and who
 * picked the elements.
 */
export interface ActGate {
  /** Steps Jev was not sure about in the last act result: goal key -> the candidate indices offered. */
  pending: Map<string, Set<number>>;
  picks: ElementPicks;
}

export function createActGate(): ActGate {
  return { pending: new Map(), picks: { jev: 0, claude: 0 } };
}

/** Goals compare case- and space-insensitively. */
export function goalKey(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ActContext {
  browser: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
  jev: JevLike | null;
  jevThreshold: number;
  sleep: Sleep;
  emit: (e: AgentEvent) => void;
  /** Jev was refused for lack of usage credit (hosted Jev): ends the task. Returns the act result. */
  outOfCredit: (e: OutOfCreditError) => ToolResult;
  /** Default: a fresh gate (nothing pending). */
  gate?: ActGate;
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "in", "on", "into", "and", "or", "for", "with", "this", "that", "it", "its", "click", "press", "type", "enter", "open", "field", "box"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9@#]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * The elements most likely meant by `goal`: Jev's own ranking first (when it
 * gave probabilities), then by words shared with the goal, elements in view
 * first. Returned in page order.
 */
export function rankCandidates(snap: PageSnapshot, goal: string, ranked: number[] = [], max = MAX_CANDIDATES): ElementInfo[] {
  const byIndex = new Map(snap.elements.map((e) => [e.index, e]));
  const chosen = new Map<number, ElementInfo>();
  // Jev's top guesses (the long tail of its ranking is noise, so only the head).
  for (const i of ranked.slice(0, Math.ceil(max / 2))) {
    const e = byIndex.get(i);
    if (e) chosen.set(i, e);
  }
  const goalWords = new Set(words(goal));
  const score = (e: ElementInfo) => {
    const own = new Set(words(`${e.role} ${e.name} ${e.text ?? ""} ${e.testId ?? ""} ${e.type ?? ""}`));
    let n = 0;
    for (const w of goalWords) if (own.has(w)) n++;
    return n;
  };
  const rest = snap.elements
    .filter((e) => !chosen.has(e.index))
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || Number(b.e.inViewport) - Number(a.e.inViewport) || a.e.index - b.e.index);
  for (const { e } of rest) {
    if (chosen.size >= max) break;
    chosen.set(e.index, e);
  }
  return [...chosen.values()].sort((a, b) => a.index - b.index);
}

/** An element without its field state, which was read before the step changed it (the page after the batch has it). */
function withoutState({ value: _value, options: _options, checked: _checked, required: _required, invalid: _invalid, ...el }: ElementInfo): ElementInfo {
  return el;
}

/** Checks the index steps of a Jev-mode act call. Returns the refusal text, or null when every index step is allowed. */
function checkIndexSteps(steps: Step[], offered: Map<string, Set<number>>): string | null {
  const problems: string[] = [];
  const used = new Set<string>();
  steps.forEach((step, i) => {
    if (step.index === undefined) return;
    const key = goalKey(step.goal);
    // The goal must match the unsure step; a slightly reworded resend of the only unsure step (as the first step) counts too.
    let allowedKey: string | null = offered.has(key) ? key : null;
    if (!allowedKey && i === 0 && offered.size === 1) allowedKey = [...offered.keys()][0]!;
    if (!allowedKey || used.has(allowedKey)) {
      problems.push(`step ${i + 1} ("${step.goal}") names element [${step.index}], but Jev was not asked about this step yet`);
      return;
    }
    const candidates = offered.get(allowedKey)!;
    if (!candidates.has(step.index)) {
      problems.push(`step ${i + 1} ("${step.goal}"): [${step.index}] is not one of the candidates listed for it (${[...candidates].map((c) => `[${c}]`).join(", ")})`);
      return;
    }
    used.add(allowedKey);
  });
  if (!problems.length) return null;
  return [
    "act refused; nothing was run.",
    ...problems,
    "With Jev on, describe each element in words instead of naming an index: its visible label and role, and its position when several look alike (e.g. {goal: 'click the Reply button under the first post'}); the fast picker finds it.",
    "An index is accepted only when act just stopped at a step as not confident: send that step again with the same goal and the index of one of the candidates it listed.",
  ].join("\n");
}

export async function runAct(steps: Step[], ctx: ActContext): Promise<ToolResult> {
  const { browser, jev, sleep, emit } = ctx;
  const gate = ctx.gate ?? createActGate();
  const jevOn = jev !== null;
  const readPage = () => browser("browser.readPage", {});
  const pageText = async () => formatSnapshot(await readPage(), { words: jevOn });
  /**
   * Does the step on the element, then lets the page settle: sets a checkbox (checked), fills a field
   * or chooses a dropdown's option (text), else clicks. Returns what was done, as "<verb> ELEMENT<after>".
   */
  const perform = async (index: number, step: Step): Promise<{ did: string; after: string }> => {
    if (step.checked !== undefined) {
      const r = await browser("browser.click", { index, checked: step.checked });
      await sleep(SETTLE_AFTER_TYPE_MS);
      return { did: r?.checked === false ? "unchecked" : "checked", after: "" };
    }
    if (step.text) {
      const r = await browser("browser.type", { index, text: step.text });
      await sleep(SETTLE_AFTER_TYPE_MS);
      return { did: r?.selected !== undefined ? `chose ${JSON.stringify(r.selected)} in` : `typed ${step.text.length} characters into`, after: "" };
    }
    const r = await browser("browser.click", { index });
    await sleep(SETTLE_AFTER_CLICK_MS);
    return { did: "clicked", after: r?.checked === undefined ? "" : ` (now ${r.checked ? "checked" : "not checked"})` };
  };

  // Jev mode: index steps only for the steps the last act result left to Claude.
  const offered = gate.pending;
  gate.pending = new Map();
  if (jevOn) {
    const refusal = checkIndexSteps(steps, offered);
    if (refusal) {
      gate.pending = offered; // still open: the model can resend the step properly
      return { text: refusal, isError: true };
    }
  }

  const lines: string[] = [];
  const stop = (n: number, why: string, snap: PageSnapshot, d?: JevDecision): ToolResult => {
    lines.push(`step ${n}: ${why}`);
    const step = steps[n - 1]!;
    const rest = steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run.` : "";
    if (!jevOn) {
      return {
        text: `${lines.join("\n")}\n\n${NOT_CONFIDENT} at step ${n}.${rest} Send step ${n} again with the element index from this list (e.g. {goal, index, text}), then continue:\n${formatCompact(snap)}`,
      };
    }
    const candidates = rankCandidates(snap, step.goal, d?.ranked);
    gate.pending.set(goalKey(step.goal), new Set(candidates.map((e) => e.index)));
    const example = step.text !== undefined ? `{goal: ${JSON.stringify(step.goal)}, index: <n>, text: ...}` : `{goal: ${JSON.stringify(step.goal)}, index: <n>}`;
    return {
      text: [
        lines.join("\n"),
        "",
        `${NOT_CONFIDENT} at step ${n}.${rest} Jev was not sure which element step ${n} means. Pick it yourself: send step ${n} again with the same goal and the index of the right candidate below, e.g. ${example}, followed by the remaining steps described in words. If none fits, describe the element differently (or scroll) instead.`,
        `URL: ${snap.url}`,
        `Title: ${snap.title}`,
        `Candidates for step ${n} (${candidates.length} of ${snap.elements.length} elements, most likely ones):`,
        candidates.map(formatElement).join("\n"),
      ].join("\n"),
    };
  };

  for (let i = 0; i < steps.length; i++) {
    const n = i + 1;
    const step = steps[i]!;
    const hasText = step.text !== undefined && step.text !== "";
    const couldNotUse = async (index: number, e: unknown, d?: JevDecision) => stop(n, `"${step.goal}": could not use element [${index}]: ${errorMessage(e)}`, await readPage(), d);
    if (step.index !== undefined) {
      // The model knows the element (Jev off, or Jev was unsure about this step): run it directly.
      try {
        const { did, after } = await perform(step.index, step);
        lines.push(`step ${n}: ${did} [${step.index}]${after} (picked by Claude)`);
        gate.picks.claude++;
      } catch (e) {
        return couldNotUse(step.index, e);
      }
      continue;
    }
    if (!jev) return stop(n, `"${step.goal}": the fast model is off, so every step needs an element index`, await readPage());
    const snap = await readPage();
    const started = Date.now();
    let d: JevDecision;
    try {
      const input: Parameters<JevLike["decide"]>[0] = { goal: step.goal, snapshot: snap, typesText: hasText };
      const previous = lines.at(-1);
      if (previous) input.previousStep = previous;
      d = await jev.decide(input);
    } catch (e) {
      emit({ type: "jev", goal: step.goal, operation: "error", index: null, confidence: 0, executed: false, ms: Date.now() - started });
      if (e instanceof OutOfCreditError) {
        const ended = ctx.outOfCredit(e);
        return { ...ended, text: [...lines, `step ${n}: "${step.goal}": ${e.message}`, ended.text].join("\n") };
      }
      return stop(n, `"${step.goal}": Jev is unavailable (${errorMessage(e)})`, snap);
    }
    const ms = Date.now() - started;
    const target = d.index === null ? undefined : snap.elements.find((e) => e.index === d.index);
    const conf = `${d.operation}, confidence ${d.confidence.toFixed(2)}`;
    const jevEvent = (executed: boolean, operation = d.operation) =>
      emit({ type: "jev", goal: step.goal, operation, index: d.index, confidence: d.confidence, executed, ms });

    if (d.operation === "blocked" || d.confidence < ctx.jevThreshold) {
      jevEvent(false);
      return stop(n, `"${step.goal}": ${conf}`, snap, d);
    }
    // Clicking or typing is decided by the step: a step with text types into the element Jev picked, one without clicks it.
    let op = d.operation;
    if ((op === "click" || op === "type") && target) op = hasText ? "type" : "click";
    switch (op) {
      case "click":
      case "type": {
        if (!target) {
          jevEvent(false);
          return stop(n, `"${step.goal}": ${conf}, but element [${d.index}] does not exist`, snap, d);
        }
        let done: { did: string; after: string };
        try {
          done = await perform(target.index, op === "type" ? step : { ...step, text: undefined });
        } catch (e) {
          jevEvent(false, op);
          return couldNotUse(target.index, e, d);
        }
        jevEvent(true, op);
        gate.picks.jev++;
        lines.push(`step ${n}: ${done.did} ${formatElement(withoutState(target))}${done.after} (picked by Jev, ${d.confidence.toFixed(2)}, ${ms} ms)`);
        break;
      }
      case "scroll":
        await browser("browser.scroll", { direction: "down" });
        jevEvent(true);
        lines.push(`step ${n}: scrolled down (picked by Jev)`);
        break;
      case "press_key":
        jevEvent(false);
        return stop(n, `"${step.goal}": Jev chose to press a key${target ? ` on ${formatElement(target)}` : ""}; call press_key yourself, or pick the element`, snap, d);
      case "wait":
        await sleep(JEV_WAIT_MS);
        jevEvent(true);
        lines.push(`step ${n}: waited ${JEV_WAIT_MS / 1000} s for the page`);
        break;
      case "done": {
        jevEvent(true);
        lines.push(`step ${n}: "${step.goal}" is already done`);
        const rest = steps.length > n ? ` Steps ${n + 1}-${steps.length} were not run; send them again if they are still needed.` : "";
        return { text: `${lines.join("\n")}\nJev ended the batch at step ${n}.${rest}\n\n${await pageText()}` };
      }
    }
  }
  return { text: `${lines.join("\n")}\nAll ${steps.length} step(s) done. Verify the result.\n\n${await pageText()}` };
}
