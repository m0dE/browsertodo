import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@browsertodo/shared";
import { FEED_BATCH_MS, NarratorFeed } from "../../src/voice/realtime-feed.js";

const call = (name: string, args: unknown = {}): AgentEvent => ({ type: "tool_call", id: "1", name, args });

describe("NarratorFeed: the chat's events as short notes for the realtime narrator", () => {
  it("batches progress (milestones and the agent's words) and sends it at most every FEED_BATCH_MS, asking for a reply", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "assistant_text", text: "I'll open Gmail and read the newest email." }, 0)).toEqual([]);
    expect(feed.push(call("navigate", { url: "https://mail.google.com/" }), 100)).toEqual([]);
    expect(feed.push(call("read_page"), 200)).toEqual([]);
    expect(feed.tick(FEED_BATCH_MS - 1)).toEqual([]);
    expect(feed.tick(FEED_BATCH_MS)).toEqual([
      {
        text: 'Agent update (progress): the agent said: "I\'ll open Gmail and read the newest email." Steps: Opening mail.google.com; Reading the page.',
        respond: true,
      },
    ]);
    expect(feed.tick(FEED_BATCH_MS * 3)).toEqual([]);
  });

  it("never passes on what the agent types or what pages say, and drops repeated steps", () => {
    const feed = new NarratorFeed();
    feed.push(call("act", { steps: [{ goal: "type the password", text: "hunter2" }] }), 0);
    feed.push(call("act", { steps: [{ goal: "type the code", text: "123456" }] }), 10);
    feed.push({ type: "tool_result", id: "1", name: "read_page", text: "SECRET PAGE TEXT" }, 20);
    const [note] = feed.tick(FEED_BATCH_MS);
    expect(note!.text).toBe("Agent update (progress): Steps: Typing.");
    expect(note!.text).not.toMatch(/hunter2|123456|SECRET/);
  });

  it("the end of a task goes at once, with what came before it, the result to say, and asks for a reply", () => {
    const feed = new NarratorFeed();
    feed.push(call("navigate", { url: "https://x.com/home" }), 0);
    const notes = feed.push({ type: "task_end", outcome: "done", summary: "Posted the thread", spoken: "Posted your thread on X." }, 500);
    expect(notes).toEqual([
      {
        text: 'Agent update (finished): Steps: Opening x.com. The task is done. Tell the user in one or two short sentences: "Posted your thread on X."',
        respond: true,
      },
    ]);
    // Nothing is left for later.
    expect(feed.tick(FEED_BATCH_MS * 2)).toEqual([]);
  });

  it("a paused task is a question to ask; a failure and an error say what went wrong", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "task_end", outcome: "paused", reason: "Which account should I post from?" }, 0)).toEqual([
      { text: 'Agent update (needs the user): The agent asks: "Which account should I post from?" Ask the user, and pass their answer on with send_to_agent.', respond: true },
    ]);
    expect(feed.push({ type: "error", text: "Claude API rate limit (HTTP 429)" }, 0)).toEqual([
      { text: 'Agent update (problem): "Too many requests right now." Tell the user briefly.', respond: true },
    ]);
    expect(feed.push({ type: "task_end", outcome: "failed", reason: "The site kept timing out" }, 0)[0]!.text).toBe(
      'Agent update (finished): The task did not work. Tell the user in one or two short sentences: "That didn\'t work: The site kept timing out"',
    );
  });

  it("the user's message to the agent is noted without asking for a reply; long agent text is clipped", () => {
    const feed = new NarratorFeed();
    expect(feed.push({ type: "user_message", text: "use the second draft" }, 0)).toEqual([
      { text: 'Agent update: the user\'s message went to the agent: "use the second draft"', respond: false },
    ]);
    feed.push({ type: "assistant_text", text: "word ".repeat(400) }, 0);
    const [note] = feed.tick(FEED_BATCH_MS);
    expect(note!.text.length).toBeLessThan(700);
  });

  it("ignores status lines, Jev picks and live text deltas", () => {
    const feed = new NarratorFeed();
    feed.push({ type: "status", text: "Claude API (claude-sonnet-5)" }, 0);
    feed.push({ type: "jev", goal: "x", operation: "click", index: 1, confidence: 1, executed: true, ms: 1 }, 0);
    feed.push({ type: "assistant_text_delta", id: "m:0", text: "Hel" }, 0);
    expect(feed.tick(FEED_BATCH_MS * 2)).toEqual([]);
  });
});
