import { describe, expect, it } from "vitest";
import { loadNodePty, TerminalManager, type PtyFactory, type PtyLike } from "../src/terminal.js";

class FakePty implements PtyLike {
  pid = 4242;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  dataCb: (d: string) => void = () => {};
  exitCb: (e: { exitCode: number }) => void = () => {};
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill() {
    this.killed = true;
  }
}

function setup(over: { flushMs?: number; maxChunk?: number } = {}) {
  const ptys: FakePty[] = [];
  const spawned: { file: string; args: string[]; opts: any }[] = [];
  const factory: PtyFactory = (file, args, opts) => {
    spawned.push({ file, args, opts });
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  const data: [string, string][] = [];
  const exits: [string, number | null][] = [];
  const killed: number[] = [];
  const tm = new TerminalManager({
    factory,
    command: () => ({ file: "C:\\claude.exe", args: ["--mcp-config", "C:\\m.json"], cwd: "C:\\ws", env: { A: "1" } }),
    onData: (id, d) => data.push([id, d]),
    onExit: (id, c) => exits.push([id, c]),
    killTree: (pid) => killed.push(pid),
    ...over,
  });
  return { tm, ptys, spawned, data, exits, killed };
}

describe("TerminalManager (fake PTY)", () => {
  it("spawns with xterm-256color, the size, cwd and env; pipes input and resize", () => {
    const { tm, ptys, spawned } = setup();
    const { terminalId } = tm.start(120, 30);
    expect(spawned[0]).toEqual({
      file: "C:\\claude.exe",
      args: ["--mcp-config", "C:\\m.json"],
      opts: { name: "xterm-256color", cols: 120, rows: 30, cwd: "C:\\ws", env: { A: "1" } },
    });
    tm.input(terminalId, "hi\r");
    tm.resize(terminalId, 100, 20);
    expect(ptys[0]!.written).toEqual(["hi\r"]);
    expect(ptys[0]!.sizes).toEqual([[100, 20]]);
    expect(() => tm.input("other", "x")).toThrow(/no running terminal/);
  });

  it("batches output every flushMs, and flushes at maxChunk", async () => {
    const { tm, ptys, data } = setup({ flushMs: 20, maxChunk: 10 });
    const { terminalId } = tm.start(80, 24);
    ptys[0]!.dataCb("ab");
    ptys[0]!.dataCb("cd");
    expect(data).toEqual([]);
    await new Promise((r) => setTimeout(r, 40));
    expect(data).toEqual([[terminalId, "abcd"]]);
    ptys[0]!.dataCb("0123456789XYZ");
    expect(data.slice(1)).toEqual([
      [terminalId, "0123456789"],
      [terminalId, "XYZ"],
    ]);
  });

  it("reports exit after flushing output", () => {
    const { tm, ptys, data, exits } = setup({ flushMs: 1000 });
    const { terminalId } = tm.start(80, 24);
    ptys[0]!.dataCb("bye");
    ptys[0]!.exitCb({ exitCode: 3 });
    expect(data).toEqual([[terminalId, "bye"]]);
    expect(exits).toEqual([[terminalId, 3]]);
    expect(tm.runningId).toBeNull();
  });

  it("stop kills the process tree and reports the exit once; one terminal at a time", () => {
    const { tm, ptys, exits, killed } = setup();
    const a = tm.start(80, 24).terminalId;
    const b = tm.start(80, 24).terminalId;
    expect(a).not.toBe(b);
    expect(ptys[0]!.killed).toBe(true);
    expect(exits).toEqual([[a, null]]);
    tm.stop(b);
    ptys[1]!.exitCb({ exitCode: 1 });
    expect(exits).toEqual([
      [a, null],
      [b, null],
    ]);
    expect(killed).toEqual([4242, 4242]);
    tm.stop("unknown"); // harmless
  });

  it("fails clearly without node-pty", () => {
    const tm = new TerminalManager({ factory: null, command: () => ({ file: "x", args: [], cwd: ".", env: {} }), onData: () => {}, onExit: () => {} });
    expect(tm.available).toBe(false);
    expect(() => tm.start(80, 24)).toThrow(/node-pty/);
  });
});

describe.runIf(process.platform === "win32")("real node-pty smoke test", () => {
  it("spawns cmd.exe /c echo pty-ok and reports its output and exit", async () => {
    const factory = await loadNodePty();
    expect(factory).not.toBeNull();
    let out = "";
    const exited = new Promise<number | null>((resolve) => {
      const tm = new TerminalManager({
        factory,
        command: () => ({ file: "cmd.exe", args: ["/c", "echo pty-ok"], cwd: process.cwd(), env: { ...process.env } as Record<string, string> }),
        onData: (_id, d) => (out += d),
        onExit: (_id, code) => resolve(code),
      });
      tm.start(80, 24);
    });
    expect(await exited).toBe(0);
    expect(out).toContain("pty-ok");
  });
});

describe("TerminalBacklog", () => {
  it("keeps only the newest output per terminal and clears on exit", async () => {
    const { TerminalBacklog } = await import("../src/terminal.js");
    const b = new TerminalBacklog(10);
    b.append("t1", "hello ");
    b.append("t1", "world!!");
    b.append("t2", "other");
    expect(b.get("t1")).toBe("lo world!!");
    expect(b.get("t2")).toBe("other");
    b.clear("t1");
    expect(b.get("t1")).toBe("");
  });
});

describe("ToolRouter interactive guard", () => {
  it("refuses interactive tool calls while a task is running", async () => {
    const { ToolRouter, INTERACTIVE_TASK_ID } = await import("../src/tool-router.js");
    const calls: string[] = [];
    const executor = { callCount: 0, call: async (name: string) => (calls.push(name), { text: "ok" }) };
    let session: unknown = null;
    const router = new ToolRouter({
      getSession: () => session as never,
      getInteractive: () => ({ allowedTools: new Set(["read_page"]) as never, executor: executor as never }),
    });
    expect((await router.call(INTERACTIVE_TASK_ID, "read_page", {})).text).toBe("ok");
    session = { taskId: "t1", allowedTools: new Set(), beforeCall: () => null, executor };
    const blocked = await router.call(INTERACTIVE_TASK_ID, "read_page", {});
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/task is using the browser/);
    expect(calls).toEqual(["read_page"]);
  });
});
