import { describe, expect, it } from "vitest";
import type { AgentEvent, RunConfig } from "@browsertodo/shared";
import { startApiAgentWith } from "../src/api-agent.js";
import { ANTHROPIC_MESSAGES_URL } from "../src/anthropic.js";
import type { ApiAgentOptions, BrowserCaller, JevLike } from "../src/types.js";
import { FakeX } from "./fake-x.js";
import { CONFIG, collect, fakeJev, noSleep, smartJev } from "./helpers.js";

type Block = Record<string, any>;
type Reply = { status?: number; body?: unknown; throws?: string } | ((req: any) => { status?: number; body?: unknown; throws?: string });

/** A fake Anthropic server: plays replies in order and records every request. */
function fakeAnthropic(replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    // Answer asynchronously, like a real server (and so reply functions can use the session).
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse(String(init?.body));
    // Snapshot the request: the agent mutates its message list afterwards.
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: structuredClone(body) });
    const r0 = replies[Math.min(i++, replies.length - 1)]!;
    const r = typeof r0 === "function" ? r0(body) : r0;
    if (r.throws) throw new TypeError(r.throws);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, get served() { return i; } };
}

let nextId = 1;
const msg = (...content: Block[]) => ({
  body: { id: `msg_${nextId}`, type: "message", role: "assistant", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn" },
});
const tool = (name: string, input: unknown = {}): Block => ({ type: "tool_use", id: `toolu_${nextId++}`, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

function start(
  x: FakeX,
  replies: Reply[],
  over: {
    jev?: JevLike | null;
    config?: Partial<RunConfig>;
    mediaPaths?: string[];
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    browser?: BrowserCaller;
  } = {},
) {
  const server = fakeAnthropic(replies);
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
    expect(first.url).toBe(ANTHROPIC_MESSAGES_URL);
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
    expect(toolNames(first)).toHaveLength(13);
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

    expect(events.find((e) => e.type === "assistant_text")).toEqual({ type: "assistant_text", text: "Reading the page." });
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
    expect(lastUser(r3!).content[0].content[0].text).toMatch(/element index/);
    expect(toolNames(r3!)).not.toContain("click");
    expect(toolNames(r3!)).not.toContain("type");
    expect(events.filter((e) => e.type === "jev")).toHaveLength(3);
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
    expect(await session.done).toEqual({ outcome: "failed", reason: "agent ended without reporting a result" });
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
    expect(r).toEqual({ outcome: "failed", reason: "tool call limit exceeded (5 calls)" });
    expect(x.calls).toHaveLength(5);
    expect(lastUser(server.requests.at(-1)!).content[0].content[0].text).toMatch(/Tool call limit of 5 reached/);
  });

  it("enforces maxTaskMinutes", async () => {
    const x = new FakeX();
    const slow: BrowserCaller = { call: async (m, p) => (await new Promise((r) => setTimeout(r, 30)), x.handle(m, p)) };
    const { session } = start(x, [msg(tool("read_page"))], { config: { maxTaskMinutes: 0.002, maxToolCalls: 500 }, browser: slow });
    // 0.002 min = 120 ms; the loop keeps reading the page until the timer fires.
    const r = await session.done;
    expect(r).toEqual({ outcome: "failed", reason: "task time limit of 0.002 minutes reached" });
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
