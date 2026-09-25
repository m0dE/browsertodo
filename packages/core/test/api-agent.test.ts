import { describe, expect, it } from "vitest";
import type { AgentEvent, RunConfig } from "@browsertodo/shared";
import { startApiAgentWith } from "../src/api-agent.js";
import { ENDED_WITHOUT_RESULT } from "../src/failures.js";
import type { ApiAgentOptions, BrowserCaller, JevLike } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeJev, fakeMessagesServer, noSleep, smartJev, type FakeReplySource } from "./helpers.js";

type Block = Record<string, any>;

let nextId = 1;
const msg = (...content: Block[]) => ({
  body: { id: `msg_${nextId}`, type: "message", role: "assistant", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn" },
});
const tool = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `toolu_${nextId++}`, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

function start(
  x: FakeX,
  replies: FakeReplySource[],
  over: {
    jev?: JevLike | null;
    config?: Partial<RunConfig>;
    mediaPaths?: string[];
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    browser?: BrowserCaller;
  } = {},
) {
  const server = fakeMessagesServer(replies);
  const { events, onEvent } = collect();
  const opts: ApiAgentOptions = {
    sessionId: "S1",
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    task: { id: "T1", instructions: "Post: gm", account: null },
    mediaPaths: over.mediaPaths ?? [],
    config: { ...CONFIG, ...over.config },
    browser: over.browser ?? x.caller(),
    jev: over.jev === undefined ? null : over.jev,
    onEvent,
    fetch: server.fetchImpl,
  };
  const session = startApiAgentWith(opts, { sleep: over.sleep ?? noSleep, retryDelaysMs: over.delays ?? [1000, 3000, 9000] });
  return { session, server, events };
}

const toolNames = (req: { body: any }) => req.body.tools.map((t: any) => t.name);
const lastUser = (req: { body: any }) => req.body.messages.at(-1);

describe("startApiAgent", () => {
  it("sends a correct Messages API request and finishes with task_complete", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [
      msg(text("Reading the page."), tool("read_page")),
      msg(tool("act", { steps: [{ goal: "type the post", index: 2, text: "gm" }, { goal: "click Post", index: 4 }] })),
      msg(tool("screenshot")),
      msg(tool("task_complete", { summary: "posted", url: "https://x.com/alice/status/1000" })),
    ]);
    const result = await session.done;
    expect(result).toEqual({ outcome: "done", summary: "posted", url: "https://x.com/alice/status/1000" });
    expect(x.posts).toHaveLength(1);

    const first = server.requests[0]!;
    expect(first.url).toBe("https://api.anthropic.com/v1/messages");
    expect(first.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    });
    expect(first.body.model).toBe("claude-sonnet-5");
    expect(first.body.max_tokens).toBe(4096);
    expect(first.body.system).toEqual([{ type: "text", text: expect.stringContaining("browsertodo"), cache_control: { type: "ephemeral" } }]);
    // act (batched, index steps) replaces click and type even without Jev; only the last tool has the cache breakpoint.
    expect(toolNames(first)).toContain("act");
    expect(toolNames(first)).not.toContain("click");
    expect(toolNames(first)).not.toContain("type");
    expect(toolNames(first)).toHaveLength(17);
    expect(first.body.tools.filter((t: any) => t.cache_control)).toEqual([first.body.tools.at(-1)]);
    const actTool = first.body.tools.find((t: any) => t.name === "act");
    expect(actTool.input_schema).toMatchObject({ type: "object", required: ["steps"] });
    expect(actTool.input_schema.properties.steps.items.properties.index).toMatchObject({ type: "integer" });
    expect(actTool.input_schema.$schema).toBeUndefined();
    const act = first.body.tools.find((t: any) => t.name === "scroll");
    expect(act.input_schema.required).toEqual(["direction"]);
    expect(first.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: expect.stringContaining("Post: gm") }] }]);

    // tool_result blocks answer each tool_use id
    const second = server.requests[1]!;
    expect(second.body.messages[1]).toMatchObject({ role: "assistant" });
    const tr = lastUser(second).content[0];
    expect(tr).toMatchObject({ type: "tool_result", tool_use_id: second.body.messages[1].content[1].id });
    expect(tr.content[0].text).toContain("URL: https://x.com/home");
    // screenshot comes back as image content
    const fourth = server.requests[3]!;
    expect(lastUser(fourth).content[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: expect.any(String) } },
    ]);

    // Streamed: the request asks for events, text arrives as deltas of block msg:0, then whole with the same id.
    expect(first.body.stream).toBe(true);
    const final = events.find((e) => e.type === "assistant_text") as Extract<AgentEvent, { type: "assistant_text" }>;
    expect(final).toEqual({ type: "assistant_text", text: "Reading the page.", id: expect.stringMatching(/^msg_\d+:0$/) });
    const deltas = events.filter((e) => e.type === "assistant_text_delta") as Extract<AgentEvent, { type: "assistant_text_delta" }>[];
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.id === final.id)).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe("Reading the page.");
    expect(events.indexOf(final)).toBeGreaterThan(events.indexOf(deltas.at(-1)!));
    // Tool input rebuilt from input_json_delta parts.
    expect(server.requests[2]!.body.messages[3].content[0]).toMatchObject({ type: "tool_use", name: "act", input: { steps: [{ goal: "type the post", index: 2, text: "gm" }, { goal: "click Post", index: 4 }] } });
    expect(events.filter((e) => e.type === "tool_call").map((e: any) => e.name)).toEqual(["read_page", "act", "screenshot", "task_complete"]);
    expect(events.at(-1)).toEqual({ type: "task_end", outcome: "done", summary: "posted", url: "https://x.com/alice/status/1000" });
  });

  it("with Jev, act replaces click/type for the whole task, even after a step is not confident", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const jev = smartJev();
    const { session, server, events } = start(
      x,
      [
        msg(tool("act", { steps: [{ goal: "type the post text into the composer", text: "gm" }, { goal: "click the post button" }] })),
        msg(tool("act", { steps: [{ goal: "open the mystery menu" }] })),
        msg(tool("task_complete", { summary: "posted" })),
      ],
      { jev },
    );
    await session.done;
    expect(x.posts.map((p) => p.text)).toEqual(["gm"]);
    const [r1, r2, r3] = server.requests;
    expect(toolNames(r1!)).toContain("act");
    expect(toolNames(r1!)).not.toContain("click");
    expect(toolNames(r1!)).not.toContain("type");
    expect(r1!.body.system[0].text).toMatch(/one act call \(up to 8\)/);
    expect(toolNames(r2!)).not.toContain("click");
    // The second act was not confident: the model is told to retry with an index, still via act.
    expect(lastUser(r3!).content[0].content[0].text).toContain("not confident at step 1");
    expect(lastUser(r3!).content[0].content[0].text).toMatch(/index of the right candidate/);
    expect(lastUser(r3!).content[0].content[0].text).toContain("Candidates for step 1");
    expect(toolNames(r3!)).not.toContain("click");
    expect(toolNames(r3!)).not.toContain("type");
    expect(events.filter((e) => e.type === "jev")).toHaveLength(3);
    // Jev mode: the tools are described for it, and the turn ends with who picked the elements.
    const actTool = r1!.body.tools.find((t: any) => t.name === "act");
    expect(actTool.description).toMatch(/Describe each step's element in words/);
    expect(actTool.input_schema.properties.steps.items.properties.index.description).toMatch(/not confident/);
    expect(r1!.body.tools.find((t: any) => t.name === "read_page").description).toMatch(/no index numbers/);
    expect(events.at(-2)).toEqual({ type: "status", text: "Jev chose 2 of 2 element picks (clicks and typing)", picks: { jev: 2, claude: 0 } });
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "done" });
  });

  it("without Jev, no picks line and the tools keep their index descriptions", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [msg(tool("act", { steps: [{ goal: "type", index: 2, text: "gm" }] })), msg(tool("task_complete", { summary: "ok" }))]);
    await session.done;
    expect(events.some((e) => e.type === "status" && "picks" in e)).toBe(false);
    expect(server.requests[0]!.body.tools.find((t: any) => t.name === "read_page").description).toMatch(/indexed list/);
  });

  it("refuses a locked tool that the model calls anyway", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server } = start(x, [msg(tool("click", { index: 1 })), msg(tool("task_fail", { reason: "gave up" }))], { jev: fakeJev([]) });
    expect(await session.done).toEqual({ outcome: "failed", reason: "gave up" });
    expect(lastUser(server.requests[1]!).content[0]).toMatchObject({ is_error: true, content: [{ text: expect.stringMatching(/click is not available|Tool click is not available/) }] });
    expect(x.calls).toHaveLength(0);
  });

  it("appends user messages before the next request", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.sendUserMessage("use the draft text instead");
        return msg(tool("read_page"));
      },
      msg(tool("task_complete", { summary: "ok" })),
    ]);
    session = r.session;
    await session.done;
    const second = r.server.requests[1]!;
    const content = lastUser(second).content;
    expect(content[0].type).toBe("tool_result");
    expect(content[1]).toEqual({ type: "text", text: expect.stringContaining("use the draft text instead") });
    expect(r.events.some((e) => e.type === "user_message" && e.text === "use the draft text instead")).toBe(true);
  });

  it("a user message after an end_turn keeps the loop going", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.sendUserMessage("are you done?");
        return msg(text("I think I am done."));
      },
      msg(tool("task_complete", { summary: "yes" })),
    ]);
    session = r.session;
    expect(await session.done).toEqual({ outcome: "done", summary: "yes" });
    expect(r.server.requests[1]!.body.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: expect.stringContaining("are you done?") }] });
  });

  it("ending without a task_* tool is a failure", async () => {
    const { session, events } = start(new FakeX(), [msg(text("All done!"))]);
    expect(await session.done).toEqual({ outcome: "failed", reason: ENDED_WITHOUT_RESULT });
    expect(events.at(-1)).toMatchObject({ type: "task_end", outcome: "failed" });
  });

  it("retries 429/529/5xx/network with 1 s, 3 s, 9 s backoff, then succeeds", async () => {
    const waits: number[] = [];
    const { session, server } = start(
      new FakeX(),
      [{ status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } }, { status: 529 }, { throws: "fetch failed" }, msg(tool("task_complete", { summary: "ok" }))],
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(await session.done).toMatchObject({ outcome: "done" });
    expect(waits).toEqual([1000, 3000, 9000]);
    expect(server.served).toBe(4);
  });

  it("gives up after 3 retries with outcome retry", async () => {
    const { session, server } = start(new FakeX(), [{ status: 503, body: { type: "error", error: { type: "api_error", message: "down" } } }]);
    const r = await session.done;
    expect(r.outcome).toBe("retry");
    expect(r.reason).toMatch(/HTTP 503.*gave up after 4 attempts/);
    expect(server.served).toBe(4);
  });

  it("401/403 fail with 'Claude API key rejected' without retrying", async () => {
    const { session, server } = start(new FakeX(), [{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
    expect(await session.done).toEqual({ outcome: "failed", reason: "Claude API key rejected" });
    expect(server.served).toBe(1);
  });

  it("other 4xx fail permanently with the API message", async () => {
    const { session } = start(new FakeX(), [{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad tool" } } }]);
    expect(await session.done).toEqual({ outcome: "failed", reason: "Claude API error (HTTP 400: invalid_request_error: bad tool)" });
  });

  it("enforces maxToolCalls: an error at the limit, then a hard stop", async () => {
    const x = new FakeX();
    const { session, server } = start(x, [msg(tool("read_page"))], { config: { maxToolCalls: 5 } });
    const r = await session.done;
    expect(r).toEqual({ outcome: "failed", reason: "Tool call limit exceeded (5 calls)" });
    expect(x.calls).toHaveLength(5);
    expect(lastUser(server.requests.at(-1)!).content[0].content[0].text).toMatch(/Tool call limit of 5 reached/);
  });

  it("enforces maxTaskMinutes", async () => {
    const x = new FakeX();
    const slow: BrowserCaller = { call: async (m, p) => (await new Promise((r) => setTimeout(r, 30)), x.handle(m, p)) };
    const { session } = start(x, [msg(tool("read_page"))], { config: { maxTaskMinutes: 0.002, maxToolCalls: 500 }, browser: slow });
    // 0.002 min = 120 ms; the loop keeps reading the page until the timer fires.
    const r = await session.done;
    expect(r).toEqual({ outcome: "failed", reason: "Task time limit of 0.002 minutes reached" });
  });

  it("abort resolves done with the given outcome and stops the loop", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    const r = start(x, [
      () => {
        session.abort("human took over", "paused");
        return msg(tool("read_page"));
      },
    ]);
    session = r.session;
    expect(await session.done).toEqual({ outcome: "paused", reason: "human took over" });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.server.served).toBe(1);
    expect(x.calls).toHaveLength(0);
    expect(r.events.filter((e: AgentEvent) => e.type === "task_end")).toHaveLength(1);
    // default outcome is failed
    const r2 = start(new FakeX(), [msg(tool("read_page"))]);
    r2.session.abort("stop");
    expect(await r2.session.done).toEqual({ outcome: "failed", reason: "stop" });
  });

  it("keeps only the newest screenshots in the history", async () => {
    const x = new FakeX();
    const { session, server } = start(x, [
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("screenshot")),
      msg(tool("task_complete", { summary: "ok" })),
    ]);
    await session.done;
    const last = server.requests.at(-1)!;
    const images = JSON.stringify(last.body.messages).match(/"type":"image"/g) ?? [];
    expect(images).toHaveLength(3);
    expect(JSON.stringify(last.body.messages)).toContain("[older screenshot removed]");
  });

  it("uses the retry prompt when isRetry", async () => {
    const { session, server } = start(new FakeX(), [msg(tool("task_fail", { reason: "x" }))], { config: { isRetry: true } });
    await session.done;
    expect(server.requests[0]!.body.messages[0].content[0].text).toMatch(/this is a retry/);
  });
});

describe("startApiAgent: conversation (continueWith)", () => {
  it("a follow-up message continues the same history after task_complete", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    const { session, server, events } = start(x, [
      msg(tool("read_page")),
      msg(tool("task_complete", { summary: "first done" })),
      msg(text("On it."), tool("task_complete", { summary: "second done", url: "https://x.com/a/status/2" })),
    ]);
    expect(await session.done).toEqual({ outcome: "done", summary: "first done" });
    expect(session.continueWith).toBeTypeOf("function");

    const next = session.continueWith!("now do the second thing", { config: { ...CONFIG, maxToolCalls: 7 } });
    expect(next.sessionId).toBe("S1");
    expect(await next.done).toEqual({ outcome: "done", summary: "second done", url: "https://x.com/a/status/2" });

    // The third request carries the whole conversation: the first turn's task_complete is answered,
    // then the follow-up text, in one user message.
    const third = server.requests[2]!.body.messages;
    expect(third).toHaveLength(5);
    expect(third[0].content[0].text).toContain("Post: gm");
    const followUp = third[4];
    expect(followUp.role).toBe("user");
    expect(followUp.content[0]).toMatchObject({ type: "tool_result", tool_use_id: third[3].content[0].id });
    expect(followUp.content.at(-1)).toEqual({ type: "text", text: expect.stringMatching(/same conversation.*now do the second thing/) });
    // The user's message shows in the event stream, and each turn ends with its own task_end.
    expect(events.filter((e) => e.type === "user_message")).toEqual([{ type: "user_message", text: "now do the second thing" }]);
    expect(events.filter((e) => e.type === "task_end").map((e) => (e as { summary?: string }).summary)).toEqual(["first done", "second done"]);
  });

  it("after a stop, the next turn answers the tool calls that never ran", async () => {
    const x = new FakeX({ url: "https://x.com/home" });
    let session!: ReturnType<typeof start>["session"];
    const inner = x.caller();
    // Stopped while the first of two tool calls runs.
    const browser: BrowserCaller = {
      call: async (method, params) => {
        const r = await inner.call(method, params);
        session.abort("stopped by user", "paused");
        return r;
      },
    };
    const r = start(x, [msg(tool("read_page"), tool("screenshot")), msg(tool("task_complete", { summary: "resumed" }))], { browser });
    session = r.session;
    expect(await session.done).toEqual({ outcome: "paused", reason: "stopped by user" });
    const next = session.continueWith!("carry on");
    expect(await next.done).toMatchObject({ outcome: "done", summary: "resumed" });
    const msgs = r.server.requests.at(-1)!.body.messages;
    expect(msgs).toHaveLength(3);
    const uses = msgs[1].content.filter((b: Block) => b.type === "tool_use");
    const answer = msgs[2].content;
    // Every tool_use has a result ("not run" for the ones the stop skipped), then the follow-up text.
    expect(answer.slice(0, 2).map((b: Block) => b.tool_use_id)).toEqual(uses.map((u: Block) => u.id));
    expect(answer[1].content[0].text).toMatch(/Not run/);
    expect(answer.at(-1).text).toContain("carry on");
  });

  it("a stop before Claude answered appends the follow-up to the pending user message", async () => {
    let session!: ReturnType<typeof start>["session"];
    const r = start(new FakeX(), [
      () => {
        queueMicrotask(() => session.abort("stopped by user", "paused"));
        return msg(tool("read_page"));
      },
      msg(tool("task_complete", { summary: "ok" })),
    ]);
    session = r.session;
    await session.done;
    await session.continueWith!("go on").done;
    const msgs = r.server.requests.at(-1)!.body.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content.map((b: Block) => b.type)).toEqual(["text", "text"]);
  });

  it("refuses a follow-up while a turn runs, and an empty one", async () => {
    const x = new FakeX();
    let session!: ReturnType<typeof start>["session"];
    let busy: unknown = null;
    const r = start(x, [
      () => {
        try {
          session.continueWith!("too early");
        } catch (e) {
          busy = e;
        }
        return msg(tool("task_fail", { reason: "nope" }));
      },
    ]);
    session = r.session;
    await session.done;
    expect(String(busy)).toMatch(/busy/);
    expect(() => session.continueWith!("  ")).toThrow(/empty/);
  });
});
