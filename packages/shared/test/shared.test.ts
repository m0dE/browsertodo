import { describe, expect, it } from "vitest";
import {
  BatchCreateInput,
  CreateTaskInput,
  DEFAULT_SETTINGS,
  INTERACTIVE_TOOL_NAMES,
  MAX_TABS_PER_CALL,
  RpcPeer,
  TOOL_DESCRIPTIONS,
  ToolArgs,
  mcpToolName,
  parseSettings,
  pauseReasonForUrl,
  pickDelayMs,
  toolsFor,
  type RpcMessage,
} from "../src/index.js";

describe("CreateTaskInput", () => {
  it("accepts a minimal task", () => {
    expect(CreateTaskInput.parse({ instructions: "Post hello" })).toEqual({ instructions: "Post hello" });
  });
  it("accepts a full task with offset time", () => {
    const t = CreateTaskInput.parse({
      instructions: "Post hello",
      account: "@me",
      mediaIds: ["m1"],
      notBefore: "2026-09-24T09:00:00+02:00",
      priority: 5,
    });
    expect(t.account).toBe("@me");
  });
  it("rejects empty instructions and bad dates", () => {
    expect(CreateTaskInput.safeParse({ instructions: "  " }).success).toBe(false);
    expect(CreateTaskInput.safeParse({ instructions: "x", notBefore: "tomorrow" }).success).toBe(false);
  });
  it("limits batch size to 100", () => {
    const tasks = Array.from({ length: 101 }, () => ({ instructions: "x" }));
    expect(BatchCreateInput.safeParse({ tasks }).success).toBe(false);
    expect(BatchCreateInput.safeParse({ tasks: tasks.slice(0, 100) }).success).toBe(true);
  });
});

describe("pauseReasonForUrl", () => {
  it.each([
    "https://x.com/i/flow/login",
    "https://x.com/i/flow/login?redirect_after_login=%2Fhome",
    "https://twitter.com/login",
    "https://x.com/account/access",
    "https://www.x.com/account/login_challenge",
  ])("pauses on %s", (url) => {
    expect(pauseReasonForUrl(url)).not.toBeNull();
  });
  it.each(["https://x.com/home", "https://x.com/compose/post", "https://x.com/loginhelper", "https://example.com/login", "not a url"])(
    "does not pause on %s",
    (url) => {
      expect(pauseReasonForUrl(url)).toBeNull();
    },
  );
});

describe("settings", () => {
  it("fills defaults and strips trailing slash", () => {
    const s = parseSettings({ apiBase: "https://api.example.com//", intervalMinutes: 5, jevThreshold: "bad" });
    expect(s.apiBase).toBe("https://api.example.com");
    expect(s.intervalMinutes).toBe(5);
    expect(s.jevThreshold).toBe(DEFAULT_SETTINGS.jevThreshold);
  });
  it("fixes an inverted delay range", () => {
    const s = parseSettings({ delayMinSec: 100, delayMaxSec: 10 });
    expect(s.delayMaxSec).toBe(100);
  });
  it("picks delays within range", () => {
    expect(pickDelayMs({ delayMinSec: 60, delayMaxSec: 180 }, () => 0)).toBe(60_000);
    expect(pickDelayMs({ delayMinSec: 60, delayMaxSec: 180 }, () => 1)).toBe(180_000);
  });
});

describe("mcpToolName", () => {
  it("prefixes with the server name", () => {
    expect(mcpToolName("click")).toBe("mcp__browsertodo__click");
  });
});

describe("RpcPeer", () => {
  type A = { "b.echo": { params: { v: number }; result: { v: number } } };
  type B = { "a.fail": { params: Record<string, never>; result: null } };

  function pair() {
    let a!: RpcPeer<A, B>;
    let b!: RpcPeer<B, A>;
    a = new RpcPeer<A, B>((m: RpcMessage) => void b.receive(JSON.parse(JSON.stringify(m))), "a");
    b = new RpcPeer<B, A>((m: RpcMessage) => void a.receive(JSON.parse(JSON.stringify(m))), "b");
    return { a, b };
  }

  it("calls a handler on the other side", async () => {
    const { a, b } = pair();
    b.handle("b.echo", ({ v }) => ({ v: v * 2 }));
    await expect(a.call("b.echo", { v: 21 })).resolves.toEqual({ v: 42 });
  });
  it("propagates handler errors", async () => {
    const { a, b } = pair();
    a.handle("a.fail", () => {
      throw new Error("boom");
    });
    await expect(b.call("a.fail", {})).rejects.toThrow("boom");
  });
  it("rejects unknown methods", async () => {
    const { a } = pair();
    await expect(a.call("b.echo", { v: 1 })).rejects.toThrow("Unknown method");
  });
  it("delivers notifications without replies", async () => {
    const { a, b } = pair();
    const got: unknown[] = [];
    b.onNotification<{ n: number }>("tick", (p) => got.push(p.n));
    a.notify("tick", { n: 1 });
    a.notify("unhandled", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([1]);
    expect(a.pendingCount).toBe(0);
  });
  it("times out and rejects pending calls on close", async () => {
    const silent = new RpcPeer<A, B>(() => {});
    await expect(silent.call("b.echo", { v: 1 }, { timeoutMs: 10 })).rejects.toThrow("timed out");
    const p = silent.call("b.echo", { v: 1 });
    silent.close("gone");
    await expect(p).rejects.toThrow("gone");
    await expect(silent.call("b.echo", { v: 1 })).rejects.toThrow("closed");
  });
});

describe("multi-tab tools", () => {
  it("open_tabs takes 1..8 URLs and an optional background flag", () => {
    expect(ToolArgs.open_tabs.safeParse({ urls: ["https://a.test/"] }).success).toBe(true);
    expect(ToolArgs.open_tabs.safeParse({ urls: ["https://a.test/"], background: false }).success).toBe(true);
    expect(ToolArgs.open_tabs.safeParse({ urls: [] }).success).toBe(false);
    expect(ToolArgs.open_tabs.safeParse({ urls: Array(MAX_TABS_PER_CALL + 1).fill("https://a.test/") }).success).toBe(false);
  });

  it("read_page keeps the no-argument form and accepts 1..8 tabs", () => {
    expect(ToolArgs.read_page.safeParse({}).success).toBe(true);
    expect(ToolArgs.read_page.safeParse({ tabs: ["t2", "t3"] }).success).toBe(true);
    expect(ToolArgs.read_page.safeParse({ tabs: [] }).success).toBe(false);
    expect(ToolArgs.read_page.safeParse({ tabs: Array(9).fill("t2") }).success).toBe(false);
  });

  it("switch_tab, list_tabs and close_tabs validate their arguments", () => {
    expect(ToolArgs.switch_tab.safeParse({ tab: "t2" }).success).toBe(true);
    expect(ToolArgs.switch_tab.safeParse({}).success).toBe(false);
    expect(ToolArgs.list_tabs.safeParse({}).success).toBe(true);
    expect(ToolArgs.close_tabs.safeParse({ tabs: ["t2"] }).success).toBe(true);
    expect(ToolArgs.close_tabs.safeParse({ tabs: [] }).success).toBe(false);
  });

  it("are offered to tasks and the interactive terminal, with descriptions", () => {
    for (const n of ["open_tabs", "switch_tab", "list_tabs", "close_tabs"] as const) {
      expect(TOOL_DESCRIPTIONS[n].length).toBeGreaterThan(10);
      expect(toolsFor({ jev: false })).toContain(n);
      expect(toolsFor({ jev: true, interactive: true })).toContain(n);
      expect(INTERACTIVE_TOOL_NAMES).toContain(n);
    }
    // toolsFor semantics are unchanged: act replaces click/type, no task_* in the terminal.
    expect(toolsFor({ jev: false })).not.toContain("click");
    expect(toolsFor({ jev: true, interactive: true })).not.toContain("task_complete");
  });
});
