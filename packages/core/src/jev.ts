/**
 * Jev grounding for act steps: given a plain-language goal and the page's
 * element list, Jev picks one operation and one target element. Jev never
 * supplies text; typing text always comes from Claude.
 */
import { TypeSafeClient, type Logger } from "@typesafe-ai/sdk";
import type { PageSnapshot } from "@browsertodo/shared";
import type { JevDecision, JevLike, JevOperation } from "./types.js";

export const JEV_OPERATIONS: readonly JevOperation[] = ["click", "type", "scroll", "press_key", "wait", "done", "blocked"];
export const JEV_MAX_ELEMENTS = 250;
export const JEV_TIMEOUT_MS = 15_000;

/** The subset of TypeSafeClient that Jev uses, so tests can fake it. */
export interface JevClientLike {
  systemOne(
    request: { state: any; questions: Record<string, { type: "choice"; instructions?: any; criteria: Record<string, any> }>; model?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): PromiseLike<{ answers: Record<string, any> }>;
}

export interface JevElement {
  index: number;
  role: string;
  name: string;
  tag: string;
  text?: string;
  type?: string;
  testId?: string;
}

export interface JevState {
  goal: string;
  url: string;
  title: string;
  elements: JevElement[];
}

/** Trimmed state for Jev: at most `max` elements, in-viewport ones first, kept in page order. */
export function buildJevState(goal: string, snapshot: PageSnapshot, max = JEV_MAX_ELEMENTS): JevState {
  const visible = snapshot.elements.filter((e) => e.inViewport);
  const hidden = snapshot.elements.filter((e) => !e.inViewport);
  const chosen = [...visible, ...hidden].slice(0, max).sort((a, b) => a.index - b.index);
  return {
    goal,
    url: snapshot.url,
    title: snapshot.title,
    elements: chosen.map((e) => {
      const out: JevElement = { index: e.index, role: e.role, name: e.name.slice(0, 120), tag: e.tag };
      if (e.text) out.text = e.text.slice(0, 80);
      if (e.type) out.type = e.type;
      if (e.testId) out.testId = e.testId;
      return out;
    }),
  };
}

const OPERATION_CRITERIA: Record<JevOperation, string> = {
  click: "Click one element to make progress on the goal.",
  type: "Type text into one input or editable element.",
  scroll: "Scroll down because the needed element is not in the list.",
  press_key: "Press a key such as Enter or Escape.",
  wait: "Wait because the page is still loading.",
  done: "The goal is already achieved on this page.",
  blocked: "The goal cannot be done here: login, captcha, error, or the element is missing.",
};

export function buildJevQuestions(state: JevState) {
  // Integer-like keys always enumerate first, so "none" ends up last.
  const targets: Record<string, string> = {};
  for (const e of state.elements) {
    targets[String(e.index)] = `${e.role} "${e.name}"${e.text ? ` text="${e.text}"` : ""}${e.testId ? ` testid=${e.testId}` : ""}`;
  }
  targets.none = "No element is needed for this operation.";
  return {
    operation: {
      type: "choice" as const,
      instructions: "Which single operation best makes progress toward the goal on this page?",
      criteria: OPERATION_CRITERIA,
    },
    target: {
      type: "choice" as const,
      instructions: "Which element index should the operation act on? Answer none if no element is needed.",
      criteria: targets,
    },
  };
}

/** Turn a systemOne answer into a decision. Unknown operations become blocked. */
export function parseJevAnswers(answers: Record<string, any>): JevDecision {
  const op = answers.operation as { choice?: string; confidence?: number } | undefined;
  const target = answers.target as { choice?: string; confidence?: number } | undefined;
  const operation = (JEV_OPERATIONS as readonly string[]).includes(op?.choice ?? "") ? (op!.choice as JevOperation) : "blocked";
  const idx = target && target.choice !== undefined && target.choice !== "none" ? Number(target.choice) : null;
  const index = idx !== null && Number.isInteger(idx) ? idx : null;
  const opConf = typeof op?.confidence === "number" ? op.confidence : 0;
  const targetConf = typeof target?.confidence === "number" ? target.confidence : 0;
  return { operation, index, confidence: Math.min(opConf, targetConf) };
}

/** A JevLike over any systemOne-capable client. */
export function jevFromClient(client: JevClientLike, opts: { model?: string } = {}): JevLike {
  return {
    async decide({ goal, snapshot }) {
      const state = buildJevState(goal, snapshot);
      const request: Parameters<JevClientLike["systemOne"]>[0] = { state, questions: buildJevQuestions(state) };
      if (opts.model) request.model = opts.model;
      const res = await client.systemOne(request, { timeout: JEV_TIMEOUT_MS });
      return parseJevAnswers(res.answers);
    },
  };
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Jev client over fetch (works in the extension and in Node). */
export function createJev(apiKey: string, opts: { fetch?: typeof fetch; model?: string } = {}): JevLike {
  const f = opts.fetch;
  const client = new TypeSafeClient({
    apiKey,
    dangerouslyAllowBrowser: true,
    logger: quiet,
    logLevel: "off",
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 1 },
    // Call through a wrapper so a browser fetch is never invoked with a foreign `this`.
    fetch: f ? (input, init) => f(input, init) : (input, init) => globalThis.fetch(input, init),
  });
  const jevOpts: { model?: string } = {};
  if (opts.model) jevOpts.model = opts.model;
  return jevFromClient(client as unknown as JevClientLike, jevOpts);
}
