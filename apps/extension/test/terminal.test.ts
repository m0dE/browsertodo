import { describe, expect, it, vi } from "vitest";
import type { HelperInfo } from "@browsertodo/shared";
import { TerminalRelay, type TerminalHelper } from "../src/engine/terminal.js";

const INFO: HelperInfo = { version: "2", jevAvailable: false, claudePath: "c", logDir: "l", ptyAvailable: true };

function setup(info: HelperInfo = INFO) {
  const notif = new Map<string, (p: any) => void>();
  let disc: ((r: string) => void) | null = null;
  const calls: { method: string; params: any }[] = [];
  const helper: TerminalHelper = {
    connect: vi.fn(async () => info),
    call: (async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "helper.terminal.start") return { terminalId: "T1" };
      if (method === "helper.terminal.backlog") return { data: "previous screen" };
      return { ok: true };
    }) as TerminalHelper["call"],
    onNotification: ((m: string, fn: (p: any) => void) => {
      notif.set(m, fn);
      return () => {};
    }) as TerminalHelper["onNotification"],
    onDisconnect: (fn) => {
      disc = fn;
      return () => {};
    },
  };
  const pushed: unknown[] = [];
  const push = {
    data: (id: string, data: string) => pushed.push({ type: "terminal.data", terminalId: id, data }),
    exit: (id: string, exitCode: number | null) => pushed.push({ type: "terminal.exit", terminalId: id, exitCode }),
    changed: vi.fn(),
  };
  const relay = new TerminalRelay(helper, push);
  return { relay, calls, pushed, push, notify: (m: string, p: unknown) => notif.get(m)!(p), disconnect: (r: string) => disc!(r) };
}

describe("TerminalRelay", () => {
  it("starts once, relays input/resize, pushes data and exit", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.relay.start(120.7, 0), t.relay.start(80, 24)]);
    expect(a).toEqual({ terminalId: "T1" });
    expect(b).toEqual({ terminalId: "T1" });
    expect(t.calls).toEqual([{ method: "helper.terminal.start", params: { cols: 120, rows: 24 } }]);
    expect(t.relay.current).toEqual({ terminalId: "T1" });
    expect(await t.relay.input("ls\r")).toBe(true);
    expect(await t.relay.resize(100, 40)).toBe(true);
    expect(t.calls.slice(1)).toEqual([
      { method: "helper.terminal.input", params: { terminalId: "T1", data: "ls\r" } },
      { method: "helper.terminal.resize", params: { terminalId: "T1", cols: 100, rows: 40 } },
    ]);
    t.notify("helper.terminal.data", { terminalId: "T1", data: "hello" });
    t.notify("helper.terminal.data", { terminalId: "OLD", data: "stale" });
    t.notify("helper.terminal.exit", { terminalId: "T1", exitCode: 0 });
    expect(t.pushed).toEqual([
      { type: "terminal.data", terminalId: "T1", data: "hello" },
      { type: "terminal.exit", terminalId: "T1", exitCode: 0 },
    ]);
    expect(t.relay.current).toBeNull();
    expect(await t.relay.input("x")).toBe(false);
  });

  it("stop kills it and reports exit even without the helper's exit notice", async () => {
    const t = setup();
    await t.relay.start(80, 24);
    expect(await t.relay.stop()).toBe(true);
    expect(t.pushed).toEqual([{ type: "terminal.exit", terminalId: "T1", exitCode: null }]);
    expect(await t.relay.stop()).toBe(false);
  });

  it("a helper disconnect ends the terminal", async () => {
    const t = setup();
    await t.relay.start(80, 24);
    t.disconnect("gone");
    expect(t.pushed).toEqual([{ type: "terminal.exit", terminalId: "T1", exitCode: null }]);
    expect(t.relay.current).toBeNull();
  });

  it("refuses when the helper has no node-pty", async () => {
    const t = setup({ ...INFO, ptyAvailable: false });
    await expect(t.relay.start(80, 24)).rejects.toThrow(/node-pty/);
  });

  it("tracks task terminals the helper opens beside the user's session, each with its own input, resize, backlog and exit", async () => {
    const t = setup();
    const opened: unknown[] = [];
    const pushed = t.pushed;
    const notif2 = new Map<string, (p: any) => void>();
    let disc2: ((r: string) => void) | null = null;
    let info2: ((i: HelperInfo | null) => void) | null = null;
    const relay = new TerminalRelay(
      {
        connect: async () => INFO,
        call: (async (method: string, params: any) => {
          t.calls.push({ method, params });
          if (method === "helper.terminal.start") return { terminalId: "U1" };
          if (method === "helper.terminal.backlog") return { data: `screen of ${params.terminalId}` };
          return { ok: true };
        }) as TerminalHelper["call"],
        onNotification: ((m: string, fn: (p: any) => void) => {
          notif2.set(m, fn);
          return () => {};
        }) as TerminalHelper["onNotification"],
        onDisconnect: (fn) => {
          disc2 = fn;
          return () => {};
        },
        onInfo: (fn) => {
          info2 = fn;
          return () => {};
        },
      },
      { ...t.push, opened: (x) => opened.push(x) },
    );
    const n = (m: string, p: unknown) => notif2.get(m)!(p);

    await relay.start(80, 24);
    n("helper.terminal.opened", { terminalId: "U1", kind: "user", title: "Claude Code" }); // after start: no duplicate
    n("helper.terminal.opened", { terminalId: "K1", kind: "task", title: "Post hi", sessionId: "S1" });
    expect(opened).toEqual([
      { terminalId: "U1", kind: "user", title: "Claude Code" },
      { terminalId: "K1", kind: "task", title: "Post hi", sessionId: "S1" },
    ]);
    expect(relay.list()).toEqual([
      { terminalId: "K1", kind: "task", title: "Post hi", sessionId: "S1" },
      { terminalId: "U1", kind: "user", title: "Claude Code" },
    ]);
    expect(relay.current).toEqual({ terminalId: "U1" });

    t.calls.length = 0;
    expect(await relay.input("y", "K1")).toBe(true);
    expect(await relay.input("u")).toBe(true);
    expect(await relay.resize(100, 30, "K1")).toBe(true);
    expect(await relay.backlog("K1")).toBe("screen of K1");
    expect(await relay.input("x", "GONE")).toBe(false);
    expect(t.calls.map((c) => [c.method, c.params.terminalId])).toEqual([
      ["helper.terminal.input", "K1"],
      ["helper.terminal.input", "U1"],
      ["helper.terminal.resize", "K1"],
      ["helper.terminal.backlog", "K1"],
    ]);

    n("helper.terminal.data", { terminalId: "K1", data: "task out" });
    n("helper.terminal.data", { terminalId: "U1", data: "user out" });
    n("helper.terminal.exit", { terminalId: "K1", exitCode: 0 });
    expect(pushed).toEqual([
      { type: "terminal.data", terminalId: "K1", data: "task out" },
      { type: "terminal.data", terminalId: "U1", data: "user out" },
      { type: "terminal.exit", terminalId: "K1", exitCode: 0 },
    ]);
    expect(relay.list().map((x) => x.terminalId)).toEqual(["U1"]);

    // A reconnect's HelperInfo lists terminals already running.
    info2!({ ...INFO, terminals: [{ terminalId: "K2", kind: "task", title: "Later", sessionId: "S2" }] });
    expect(relay.list().map((x) => x.terminalId)).toEqual(["K2", "U1"]);
    disc2!("gone");
    expect(relay.list()).toEqual([]);
    expect(pushed.slice(-2)).toEqual(
      expect.arrayContaining([
        { type: "terminal.exit", terminalId: "K2", exitCode: null },
        { type: "terminal.exit", terminalId: "U1", exitCode: null },
      ]),
    );
  });

  it("stop takes a terminal id (a task session) and defaults to the user's", async () => {
    const t = setup();
    await t.relay.start(80, 24);
    t.notify("helper.terminal.opened", { terminalId: "K1", kind: "task", title: "T", sessionId: "S1" });
    expect(await t.relay.stop("K1")).toBe(true);
    expect(t.calls.at(-1)).toEqual({ method: "helper.terminal.stop", params: { terminalId: "K1" } });
    expect(await t.relay.stop()).toBe(true);
    expect(t.calls.at(-1)).toEqual({ method: "helper.terminal.stop", params: { terminalId: "T1" } });
    expect(t.relay.list()).toEqual([]);
  });

  it("passes the Jev key on start and returns the backlog when reattaching", async () => {
    const t = setup();
    expect(await t.relay.start(80, 24, "jk")).toEqual({ terminalId: "T1" });
    expect(t.calls.find((c) => c.method === "helper.terminal.start")!.params).toEqual({ cols: 80, rows: 24, jevApiKey: "jk" });
    expect(await t.relay.start(80, 24)).toEqual({ terminalId: "T1", backlog: "previous screen" });
    expect(t.calls.filter((c) => c.method === "helper.terminal.start")).toHaveLength(1);
  });
});
