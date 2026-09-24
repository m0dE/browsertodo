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

  it("passes the Jev key on start and returns the backlog when reattaching", async () => {
    const t = setup();
    expect(await t.relay.start(80, 24, "jk")).toEqual({ terminalId: "T1" });
    expect(t.calls.find((c) => c.method === "helper.terminal.start")!.params).toEqual({ cols: 80, rows: 24, jevApiKey: "jk" });
    expect(await t.relay.start(80, 24)).toEqual({ terminalId: "T1", backlog: "previous screen" });
    expect(t.calls.filter((c) => c.method === "helper.terminal.start")).toHaveLength(1);
  });
});
