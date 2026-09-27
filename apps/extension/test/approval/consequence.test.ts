import { describe, expect, it } from "vitest";
import { classifyByRules, hasPhrase, labelOf, words } from "../../src/approval/consequence.js";
import { withinInstructions } from "../../src/approval/within-task.js";
import { CASES, el, HOLDOUT_CASES, WITHIN_CASES } from "./cases.js";

/** Precision and recall of "needs approval", as the gate uses the rules without Jev: unsure asks. */
function measure(results: readonly { ask: boolean; predicted: boolean }[]) {
  const tp = results.filter((r) => r.ask && r.predicted).length;
  const fp = results.filter((r) => !r.ask && r.predicted).length;
  const fn = results.filter((r) => r.ask && !r.predicted).length;
  return { n: results.length, tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn) };
}

describe("consequence rules on the labelled set", () => {
  const rows = CASES.map((c) => {
    const v = classifyByRules(c.action);
    return { name: c.name, ask: c.ask, verdict: v.verdict, predicted: v.verdict !== "benign", reason: v.reason };
  });
  const m = measure(rows);

  it("never lets a consequential action through (recall 1.0), and asks rarely about harmless ones", () => {
    const missed = rows.filter((r) => r.ask && !r.predicted);
    const extra = rows.filter((r) => !r.ask && r.predicted);
    const unsure = rows.filter((r) => r.verdict === "unsure");
    console.log(
      [
        `rules alone (unsure asks): ${m.n} cases, precision ${m.precision.toFixed(2)}, recall ${m.recall.toFixed(2)} (tp ${m.tp}, fp ${m.fp}, fn ${m.fn}); ${unsure.length} unsure (left to Jev)`,
        ...missed.map((r) => `  MISSED: ${r.name} (${r.reason})`),
        ...extra.map((r) => `  asks needlessly: ${r.name} [${r.verdict}] (${r.reason})`),
      ].join("\n"),
    );
    expect(missed.map((r) => r.name)).toEqual([]);
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(m.precision).toBeGreaterThanOrEqual(0.75);
  });

  it("is certain (no Jev needed) for most cases", () => {
    const certain = rows.filter((r) => r.verdict !== "unsure");
    const wrong = certain.filter((r) => (r.verdict === "consequential") !== r.ask);
    expect(certain.length / rows.length).toBeGreaterThanOrEqual(0.8);
    // Every certain verdict that is wrong errs on the safe side (asks).
    expect(wrong.filter((r) => r.ask).map((r) => r.name)).toEqual([]);
  });
});

/** Within-task cases the word rules get wrong (they read "renewal" in "what my renewal would cost" as asking to renew). */
const KNOWN_WITHIN_MISSES = ["payment not asked for"];

describe("within the task's instructions (scheduled runs)", () => {
  it("tells what the task asks for from what it does not", () => {
    const rows = WITHIN_CASES.map((c) => {
      const v = classifyByRules(c.action);
      const kind = v.verdict === "benign" ? undefined : v.kind;
      return { name: c.name, within: c.within, predicted: kind !== undefined && withinInstructions(kind, c.action, c.instructions) };
    });
    const wrong = rows.filter((r) => r.within !== r.predicted);
    // "beyond" is the class that must be caught: it is what asks.
    const beyond = measure(rows.map((r) => ({ ask: !r.within, predicted: !r.predicted })));
    console.log(
      [
        `within-task rules: ${rows.length} cases, ${rows.length - wrong.length} right; "beyond the task" precision ${beyond.precision.toFixed(2)}, recall ${beyond.recall.toFixed(2)}`,
        ...wrong.map((r) => `  WRONG: ${r.name} (expected ${r.within ? "within" : "beyond"})`),
      ].join("\n"),
    );
    // A known limit of word rules: a noun ("renewal") reads as the verb ("renew").
    expect(wrong.map((r) => r.name)).toEqual(KNOWN_WITHIN_MISSES);
  });

  it("a forbidden verb is never within, even when the family is named elsewhere", () => {
    const post = CASES.find((c) => c.name === "X: Post button in the home composer")!.action;
    expect(withinInstructions("publish", post, "Write the post, do not publish it")).toBe(false);
    expect(withinInstructions("publish", post, "Post the launch note")).toBe(true);
  });
});

describe("consequence rules on the held-out set", () => {
  it("measures cases written after the rules (reported, not tuned against)", () => {
    const rows = HOLDOUT_CASES.map((c) => {
      const v = classifyByRules(c.action);
      return { name: c.name, ask: c.ask, verdict: v.verdict, predicted: v.verdict !== "benign", reason: v.reason };
    });
    const m = measure(rows);
    console.log(
      [
        `held out, rules alone (unsure asks): ${m.n} cases, precision ${m.precision.toFixed(2)}, recall ${m.recall.toFixed(2)} (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`,
        ...rows.filter((r) => r.ask !== r.predicted).map((r) => `  ${r.ask ? "MISSED" : "asks needlessly"}: ${r.name} [${r.verdict}] (${r.reason})`),
      ].join("\n"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });
});

describe("rule details", () => {
  it("reads labels as words: camelCase test ids, marks and punctuation", () => {
    expect(words("tweetButtonInline")).toBe("tweet button inline");
    expect(words("Send ‪(Ctrl-Enter)‬")).toBe("send ctrl enter");
    expect(hasPhrase("send ctrl enter", ["send"])).toBe("send");
    expect(hasPhrase("sender", ["send"])).toBeNull();
    expect(labelOf(el("button", "Submit", { tag: "input", type: "submit", value: "Pay now" }))).toContain("pay now");
  });

  it("an element not in the last page read is unsure (it asks)", () => {
    expect(classifyByRules({ method: "click", page: { url: "https://x.com/home", title: "" }, typed: [] }).verdict).toBe("unsure");
  });

  it("a Post button read as disabled still counts: typing enables it without a new read (found in a real Claude Code run)", () => {
    const v = classifyByRules({ method: "click", element: el("button", "Post", { disabled: true }), page: { url: "https://x.com/home", title: "" }, typed: [] });
    expect(v).toMatchObject({ verdict: "consequential", kind: "publish" });
  });
});
