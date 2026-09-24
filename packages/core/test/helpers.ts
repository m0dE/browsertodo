import type { AgentEvent, PageSnapshot, RunConfig } from "@browsertodo/shared";
import type { JevDecision, JevLike } from "../src/types.js";

export const noSleep = async () => {};

/** A Jev that answers from a function of the goal and snapshot (or a fixed list, in order). */
export function fakeJev(
  answer: ((goal: string, snap: PageSnapshot) => JevDecision) | JevDecision[],
): JevLike & { goals: string[] } {
  const goals: string[] = [];
  let i = 0;
  return {
    goals,
    async decide({ goal, snapshot }) {
      goals.push(goal);
      if (typeof answer === "function") return answer(goal, snapshot);
      const d = answer[Math.min(i++, answer.length - 1)];
      if (!d) throw new Error("no more fake Jev answers");
      return d;
    },
  };
}

/** Jev that finds elements by a word in the goal: "composer" -> textbox, "post button" -> Post, "home" -> Home link. */
export const smartJev = (confidence = 0.95) =>
  fakeJev((goal, snap) => {
    const g = goal.toLowerCase();
    const find = (pred: (e: PageSnapshot["elements"][number]) => boolean) => snap.elements.find(pred)?.index ?? null;
    if (g.includes("type")) return { operation: "type", index: find((e) => e.testId === "tweetTextarea_0"), confidence };
    if (g.includes("post button")) return { operation: "click", index: find((e) => e.name === "Post" && e.role === "button"), confidence };
    if (g.includes("home")) return { operation: "click", index: find((e) => e.name === "Home"), confidence };
    return { operation: "blocked", index: null, confidence: 0.2 };
  });

export function collect() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => void events.push(e) };
}

export const CONFIG: RunConfig = { maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8, isRetry: false };
