/**
 * Jev grounding for `act(goal)`: given a plain-language goal and the page's
 * element list, Jev picks one operation and one target element.
 * Jev never supplies text; typing always comes from Claude.
 */
import { TypeSafeClient, type Logger } from "@typesafe-ai/sdk";
import type { PageSnapshot } from "@browsertodo/shared";
import type { EventLogger } from "./logger.js";

export const JEV_OPERATIONS = ["click", "type", "scroll", "press_key", "wait", "done", "blocked"] as const;
export type JevOperation = (typeof JEV_OPERATIONS)[number];

export const JEV_MAX_ELEMENTS = 250;

export interface JevDecision {
  operation: JevOperation;
  index: number | null;
  /** The lower of the operation and target confidences, 0..1. */
  confidence: number;
  operationConfidence: number;
  targetConfidence: number;
}

/** The subset of TypeSafeClient that jevDecide uses, so tests can fake it. */
export interface JevClientLike {
  systemOne(
    request: { state: any; questions: Record<string, { type: "choice"; instructions?: any; criteria: Record<string, any> }> },
    options?: { signal?: AbortSignal; timeout?: number },
  ): PromiseLike<{ answers: Record<string, any> }>;
}

export interface JevElement {
  index: number;
  role: string;
  name: string;
  tag: string;
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
  for (const e of state.elements) targets[String(e.index)] = `${e.role} "${e.name}"${e.testId ? ` testid=${e.testId}` : ""}`;
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

export async function jevDecide(
  input: { goal: string; snapshot: PageSnapshot },
  client: JevClientLike,
  log?: EventLogger,
  signal?: AbortSignal,
): Promise<JevDecision> {
  const state = buildJevState(input.goal, input.snapshot);
  const questions = buildJevQuestions(state);
  log?.({ type: "jev_request", goal: input.goal, url: state.url, elements: state.elements.length });
  const started = Date.now();
  const res = await client.systemOne({ state: state as any, questions }, { signal, timeout: 15_000 });
  const op = res.answers.operation as { choice: string; confidence: number } | undefined;
  const target = res.answers.target as { choice: string; confidence: number } | undefined;
  const operation = (JEV_OPERATIONS as readonly string[]).includes(op?.choice ?? "") ? (op!.choice as JevOperation) : "blocked";
  const idx = target && target.choice !== "none" ? Number(target.choice) : null;
  const index = idx !== null && Number.isInteger(idx) ? idx : null;
  const operationConfidence = typeof op?.confidence === "number" ? op.confidence : 0;
  const targetConfidence = typeof target?.confidence === "number" ? target.confidence : 0;
  const decision: JevDecision = {
    operation,
    index,
    confidence: Math.min(operationConfidence, targetConfidence),
    operationConfidence,
    targetConfidence,
  };
  log?.({ type: "jev_response", ms: Date.now() - started, ...decision });
  return decision;
}

/** A real Jev client whose SDK logging goes to our log file, never stdout. */
export function createJevClient(apiKey: string, log: (line: string) => void): TypeSafeClient {
  const fmt = (level: string) => (message: string, ...args: unknown[]) =>
    log(`jev-sdk ${level} ${message} ${args.length ? JSON.stringify(args).slice(0, 500) : ""}`);
  const logger: Logger = { debug: fmt("debug"), info: fmt("info"), warn: fmt("warn"), error: fmt("error") };
  return new TypeSafeClient({ apiKey, logger, logLevel: "warn", timeout: 15_000 });
}
