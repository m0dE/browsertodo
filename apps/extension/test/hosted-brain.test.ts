/** The hosted browsertodo AI brain: request shape (endpoint, auth, session header), hosted models, Jev, 402. */
import { describe, expect, it, vi } from "vitest";
import * as core from "@browsertodo/core";
import { DEFAULT_SETTINGS, type AgentEvent, type ExtensionSettings } from "@browsertodo/shared";
import { ApiBrain } from "../src/engine/api-brain.js";
import type { BrainStartOptions } from "../src/engine/brains.js";
import { hostedBackend, SESSION_HEADER } from "../src/engine/hosted-brain.js";

type Req = { url: string; headers: Record<string, string>; body: any };

function server(replies: { status: number; body: unknown }[]) {
  const requests: Req[] = [];
  let i = 0;
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const complete = {
  status: 200,
  body: { id: "m", type: "message", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "task_complete", input: { summary: "done" } }] },
};

function startOpts(settings: Partial<ExtensionSettings> = {}, events: AgentEvent[] = []): BrainStartOptions {
  return {
    sessionId: "sess-42",
    task: { id: "t", instructions: "say hi", account: null },
    mediaPaths: [],
    config: { maxToolCalls: 10, maxTaskMinutes: 5, jevEnabled: true, jevThreshold: 0.8, isRetry: false },
    settings: { ...DEFAULT_SETTINGS, anthropicApiKey: "sk-own-key-not-used", ...settings },
    onEvent: (e) => events.push(e),
  };
}

function brain(replies: { status: number; body: unknown }[], session: { token: string; apiBase: string } | null = { token: "bt_s_tok", apiBase: "https://api.test" }) {
  const s = server(replies);
  const onOutOfCredit = vi.fn();
  const afterTurn = vi.fn();
  const b = new ApiBrain({
    core,
    browser: { call: vi.fn() as never },
    fetch: s.fetchFn,
    backend: hostedBackend({ core, session: () => session, onOutOfCredit, afterTurn, fetch: s.fetchFn }),
  });
  return { b, s, onOutOfCredit, afterTurn };
}

describe("browsertodo AI brain", () => {
  it("is the 'browsertodo' brain and calls ${apiBase}/v1/ai/messages with the session token and the run's session id", async () => {
    const t = brain([complete]);
    expect(t.b.kind).toBe("browsertodo");
    const events: AgentEvent[] = [];
    const run = t.b.start(startOpts({ jevEnabled: false }, events));
    expect(await run.done).toMatchObject({ outcome: "done" });
    const req = t.s.requests[0]!;
    expect(req.url).toBe("https://api.test/v1/ai/messages");
    expect(req.headers.authorization).toBe("Bearer bt_s_tok");
    expect(req.headers[SESSION_HEADER.toLowerCase()]).toBe("sess-42");
    // Never the user's own Anthropic key, never Anthropic's browser header.
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(req.body.model).toBe("claude-sonnet-5");
    expect(events[0]).toEqual({ type: "status", text: "browsertodo AI (claude-sonnet-5)" });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.afterTurn).toHaveBeenCalled();
  });

  it("offers only hosted models: a custom model id falls back to the default", async () => {
    const t = brain([complete]);
    await t.b.start(startOpts({ anthropicModel: "claude-opus-5-5", jevEnabled: false })).done;
    const t2 = brain([complete]);
    await t2.b.start(startOpts({ anthropicModel: "my-custom-model", jevEnabled: false })).done;
    expect([t.s.requests[0]!.body.model, t2.s.requests[0]!.body.model]).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("uses the hosted Jev at ${apiBase}/v1/ai/jev when Jev is on (no Jev key needed)", () => {
    const createJev = vi.fn(() => ({ decide: vi.fn() }));
    const startApiAgent = vi.fn(() => ({ sessionId: "s", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) }));
    const b = new ApiBrain({
      core: { createJev, startApiAgent } as never,
      browser: { call: vi.fn() as never },
      backend: hostedBackend({ core: { createJev } as never, session: () => ({ token: "bt_s_tok", apiBase: "https://api.test/" }), onOutOfCredit: vi.fn() }),
    });
    b.start(startOpts({ jevApiKey: "" }));
    expect(createJev).toHaveBeenCalledWith("bt_s_tok", { endpoint: "https://api.test/v1/ai/jev", headers: { [SESSION_HEADER]: "sess-42" } });
    const agentOpts = (startApiAgent.mock.calls[0] as unknown as [core.ApiAgentOptions])[0];
    expect(agentOpts).toMatchObject({ apiKey: "bt_s_tok", baseUrl: "https://api.test/v1/ai", auth: "bearer", headers: { [SESSION_HEADER]: "sess-42" }, label: "browsertodo AI" });
    expect(agentOpts.jev).not.toBeNull();
  });

  it("402 out_of_credit pauses the run with 'Out of AI credit' and reports the top-up link", async () => {
    const t = brain([{ status: 402, body: { error: "out_of_credit", message: "No AI credit left", topupUrl: "https://api.test/billing" } }]);
    const result = await t.b.start(startOpts({ jevEnabled: false })).done;
    expect(result).toEqual({ outcome: "paused", reason: "Out of AI credit" });
    expect(t.onOutOfCredit).toHaveBeenCalledWith("https://api.test/billing");
    expect(t.s.requests).toHaveLength(1);
  });

  it("a Jev 402 flags the account too", async () => {
    const onOutOfCredit = vi.fn();
    const inner = { decide: vi.fn(async () => Promise.reject(new core.OutOfCreditError("Jev: No AI credit left", "https://api.test/b"))) };
    let jev: core.JevLike | null = null;
    const b = new ApiBrain({
      core: { createJev: () => inner, startApiAgent: (o: core.ApiAgentOptions) => ((jev = o.jev), { sessionId: "s", sendUserMessage() {}, abort() {}, done: new Promise<never>(() => {}) }) } as never,
      browser: { call: vi.fn() as never },
      backend: hostedBackend({ core: { createJev: () => inner } as never, session: () => ({ token: "t", apiBase: "https://api.test" }), onOutOfCredit }),
    });
    b.start(startOpts());
    await expect(jev!.decide({ goal: "g", snapshot: { url: "", title: "", text: "", elements: [], truncated: false } })).rejects.toThrow(/credit/);
    expect(onOutOfCredit).toHaveBeenCalledWith("https://api.test/b");
  });

  it("signed out: the run fails before any request", async () => {
    const t = brain([complete], null);
    const r = await t.b.start(startOpts()).done;
    expect(r).toEqual({ outcome: "failed", reason: "Could not start the browsertodo AI agent: Not signed in: sign in to use browsertodo AI" });
    expect(t.s.requests).toHaveLength(0);
  });
});
