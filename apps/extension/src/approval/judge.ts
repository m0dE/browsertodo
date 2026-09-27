/**
 * The consequence classifier: the rules first (consequence.ts), Jev for what
 * they leave unsure (jev-judge.ts), and when still unsure the action counts
 * as consequential, so the gate asks.
 */
import type { ConsequenceKind } from "@browsertodo/shared";
import { classifyByRules, type GateAction } from "./consequence.js";
import { judgeWithJev, type SystemOneLike } from "./jev-judge.js";
import { withinInstructions } from "./within-task.js";

/** Jev's "nothing happens" counts only this sure; below it the user is asked. */
export const JUDGE_MIN_CONFIDENCE = 0.8;

export interface Judgement {
  consequential: boolean;
  /** What it does; absent when consequential only because nobody could tell. */
  kind?: ConsequenceKind;
  /** Why, for the approval card and the trace. */
  reason: string;
  /** Who decided: the rules, Jev, or neither (unsure, so it asks). */
  by: "rules" | "jev" | "unsure";
}

export async function judgeAction(action: GateAction, opts: { jev?: SystemOneLike | null; pageText?: string }): Promise<Judgement> {
  const rules = classifyByRules(action);
  if (rules.verdict === "benign") return { consequential: false, reason: rules.reason, by: "rules" };
  if (rules.verdict === "consequential") return { consequential: true, kind: rules.kind, reason: rules.reason, by: "rules" };
  const unsure: Judgement = { consequential: true, ...(rules.kind ? { kind: rules.kind } : {}), reason: rules.reason, by: "unsure" };
  // Jev judges elements; a key press depends on the site's shortcuts, which it does not know ("#" deletes in Gmail).
  if (!opts.jev || action.method === "pressKey") return unsure;
  try {
    const j = await judgeWithJev(opts.jev, action, opts.pageText ?? "");
    if (j.kind === null) return j.confidence >= JUDGE_MIN_CONFIDENCE ? { consequential: false, reason: `Jev: nothing is sent or published (${j.confidence.toFixed(2)})`, by: "jev" } : unsure;
    return { consequential: true, kind: j.kind, reason: `Jev: ${j.kind} (${j.confidence.toFixed(2)})`, by: "jev" };
  } catch {
    return { ...unsure, reason: `${rules.reason}; Jev could not judge it` };
  }
}

/** How the within-task question was answered: the verdict, the rules' answer, and Jev's ("no 0.90"; absent: not asked). */
export interface WithinVerdict {
  within: boolean;
  reason: string;
  rules: boolean;
  jev?: string;
}

/**
 * Whether a scheduled task's instructions ask for a consequential action: the
 * word rules (within-task.ts), and Jev may only overrule a "yes" with a sure
 * "no" (it never lets through what the rules hold back). Measured on the
 * labelled set: rules alone 17 of 18, Jev alone 15 of 18, this 17 or 18 of 18
 * (Jev's answers vary between runs; the set is small and was used to design it).
 *
 * The veto stays even when the task's words name the action: the rules' one
 * miss is exactly that kind of false yes ("what my domain renewal would cost"
 * names "renew", and a payment would run), and a yes that is wrong does what
 * cannot be taken back, while a veto that is wrong costs the user one OK (an
 * unattended run pauses at once and says why, gate.ts). Both verdicts go to
 * the trace (approval.judge) so a wrong veto is plain to see.
 */
export async function judgeWithinTask(
  kind: ConsequenceKind | undefined,
  action: GateAction,
  instructions: string,
  opts: { jev?: SystemOneLike | null; pageText?: string },
): Promise<WithinVerdict> {
  const rules = !!kind && withinInstructions(kind, action, instructions);
  if (!rules) return { within: false, reason: "the task does not ask for this", rules };
  if (!opts.jev) return { within: true, reason: "the task asks for this", rules };
  let jev = "error";
  try {
    const j = await judgeWithJev(opts.jev, action, opts.pageText ?? "", instructions);
    jev = j.within ? `${j.within.yes ? "yes" : "no"} ${j.within.confidence.toFixed(2)}` : "no answer";
    if (j.within && !j.within.yes && j.within.confidence >= JUDGE_MIN_CONFIDENCE) return { within: false, reason: `Jev: the task does not ask for this (${j.within.confidence.toFixed(2)})`, rules, jev };
  } catch {
    /* Jev's veto is optional: the rules' yes stands */
  }
  return { within: true, reason: "the task asks for this", rules, jev };
}
