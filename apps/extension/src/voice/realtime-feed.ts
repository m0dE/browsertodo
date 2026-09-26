/**
 * What the Realtime narrator is told about the chat: short text notes made
 * from the agent's events, so it can say, in its own words, what is going
 * on. Progress (milestones, the agent's words) is batched and sent at most
 * every FEED_BATCH_MS; a finished task, a question and an error go at once.
 * Only milestones (milestones.ts), the agent's own text (clipped) and the
 * short result lines (spoken-line.ts) are passed on: never what the agent
 * types or what pages say. Pure.
 */
import type { AgentEvent } from "@browsertodo/shared";
import { milestoneOf } from "./milestones.js";
import { endLine, errorLine } from "./spoken-line.js";

/** Progress notes go to the narrator at most this often. */
export const FEED_BATCH_MS = 8_000;
/** The agent's text is passed on up to this many characters (the narrator summarises it). */
const MAX_AGENT_TEXT = 500;
/** The user's message is noted up to this many characters. */
const MAX_USER_TEXT = 300;

export interface FeedNote {
  text: string;
  /** Ask the narrator to say something about it now. */
  respond: boolean;
}

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export class NarratorFeed {
  private said: string[] = [];
  private steps: string[] = [];
  /** When the oldest unsent progress arrived. */
  private since: number | null = null;

  constructor(private readonly batchMs = FEED_BATCH_MS) {}

  /** An event of the chat the session follows: notes to send now (a finished task, a question, an error). */
  push(ev: AgentEvent, now: number): FeedNote[] {
    switch (ev.type) {
      case "assistant_text":
        if (ev.text.trim()) this.progress(now, () => this.said.push(clip(ev.text, MAX_AGENT_TEXT)));
        return [];
      case "tool_call": {
        const step = milestoneOf(ev);
        if (step && !this.steps.includes(step)) this.progress(now, () => this.steps.push(step));
        return [];
      }
      case "user_message":
        return [{ text: `Agent update: the user's message went to the agent: "${clip(ev.text, MAX_USER_TEXT)}"`, respond: false }];
      case "error":
        return [{ text: `Agent update (problem): "${errorLine(ev.text)}" Tell the user briefly.`, respond: true }];
      case "task_end":
        return [this.ending(ev)];
      default:
        return [];
    }
  }

  /** The batched progress, once FEED_BATCH_MS have passed since the oldest of it. */
  tick(now: number): FeedNote[] {
    if (this.since === null || now - this.since < this.batchMs) return [];
    return [{ text: `Agent update (progress): ${this.takeProgress()}`, respond: true }];
  }

  private progress(now: number, add: () => void): void {
    add();
    this.since ??= now;
  }

  /** The unsent progress as one line (and forgets it). */
  private takeProgress(): string {
    const parts: string[] = [];
    if (this.said.length) parts.push(`the agent said: ${this.said.map((t) => `"${t}"`).join(" ")}`);
    if (this.steps.length) parts.push(`Steps: ${this.steps.join("; ")}.`);
    this.said = [];
    this.steps = [];
    this.since = null;
    return parts.join(" ");
  }

  private ending(ev: Extract<AgentEvent, { type: "task_end" }>): FeedNote {
    const before = this.since === null ? "" : `${this.takeProgress()} `;
    const line = endLine(ev);
    if (ev.outcome === "paused" && !ev.spoken && ev.reason) {
      // A reason without a spoken line is the agent's question as it wrote it.
      return { text: `Agent update (needs the user): ${before}The agent asks: "${line}" Ask the user, and pass their answer on with send_to_agent.`, respond: true };
    }
    const what = ev.outcome === "done" ? "The task is done." : ev.outcome === "paused" ? "The task is waiting for the user." : "The task did not work.";
    return { text: `Agent update (finished): ${before}${what} Tell the user in one or two short sentences: "${line}"`, respond: true };
  }
}
