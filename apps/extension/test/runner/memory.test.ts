/** Runner and memory: what a turn is given at its start, and a repeating task's run note at its end. */
import { describe, expect, it } from "vitest";
import { Runner } from "../../src/engine/runner.js";
import { MemoryService } from "../../src/memory/service.js";
import { MemoryStore } from "../../src/memory/store.js";
import { memoryStorage } from "../memory/fakes.js";
import { harness, runAll, setupRunnerTests, type Harness } from "./harness.js";

setupRunnerTests();

const DAILY = "Post one tip about Mecha Royale on X from @mecharoyalecom";

function withMemory(h: Harness) {
  const store = new MemoryStore({ storage: memoryStorage() });
  const memory = new MemoryService({ store, sessions: h.sessions, settings: async () => h.settings });
  h.deps.memory = memory;
  h.runner = new Runner(h.deps);
  return { store, memory };
}

describe("Runner: memory", () => {
  it("a repeating task's run note is kept at its end and given to its next run", async () => {
    const h = harness();
    const { store } = withMemory(h);
    await h.store.add({ instructions: DAILY, account: "@mecharoyalecom" });
    h.brain.script = () => ({ outcome: "done", summary: "Posted", memoryNote: "Posted about the arena map. Next: ranked season." });
    await runAll(h);
    expect(h.brain.starts[0]!.task.memory).toBeUndefined();
    const [note] = await store.list();
    expect(note).toMatchObject({ kind: "task", scope: "task", text: "Posted about the arena map. Next: ranked season." });
    // Its chat shows "Remembered" before the end card.
    const [s1] = await h.sessions.list();
    const types = (await h.sessions.eventsOf(s1!.sessionId)).map((e) => e.type);
    expect(types.indexOf("memory")).toBeGreaterThan(-1);
    expect(types.indexOf("memory")).toBeLessThan(types.lastIndexOf("task_end"));

    // The next occurrence: a new row with the same instructions.
    await h.store.add({ instructions: DAILY, account: "@mecharoyalecom" });
    h.brain.script = () => ({ outcome: "done", summary: "Posted" });
    await runAll(h);
    expect(h.brain.starts[1]!.task.memory).toMatch(/Task history:\n- \[m\w+\] \d{4}-\d\d-\d\d Run note: Posted about the arena map/);
    // Where the memory went and what it cost is in the trace.
    const s2 = (await h.sessions.list()).find((s) => s.sessionId !== s1!.sessionId);
    const trace = await h.sessions.traceOf(s2!.sessionId);
    expect(trace?.events.find((e) => e.name === "memory.given")?.data).toMatchObject({ entries: 1 });
  });

  it("a chat started with memory off is marked, given nothing and keeps no run note", async () => {
    const h = harness();
    const { store } = withMemory(h);
    await store.put({ kind: "preference", subject: "Tone", text: "Friendly and short", scope: "global" }, { kind: "user" });
    h.brain.script = () => ({ outcome: "done", summary: "ok" });
    // A request the preference is about (a turn memory has nothing relevant for is given nothing either way).
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Say hi in my usual tone", memoryOff: true });
    await h.runner.idle();
    expect((await h.sessions.get(sessionId))?.memoryOff).toBe(true);
    expect(h.brain.starts[0]!.task.memory).toBeUndefined();
    // With memory on, the same chat is given the preference.
    const on = await h.runner.runAdhoc({ instructions: "Say hi in my usual tone" });
    await h.runner.idle();
    expect(h.brain.starts[1]!.task.memory).toMatch(/Preferences:\n- \[m\w+\] Tone: Friendly and short/);
    expect((await h.sessions.get(on.sessionId))?.memoryOff).toBeUndefined();
  });

  it("memory is picked while the turn's tab is made ready, and given when both are done (first turn and next turn)", async () => {
    const h = harness();
    const order: string[] = [];
    let release!: () => void;
    let picked!: Promise<void>;
    const arm = () => void (picked = new Promise<void>((r) => (release = r)));
    arm();
    h.deps.memory = {
      begin: async (_id, run) => {
        order.push(`begin ${run.request}`);
        // The account's search answers only once the tab is being made ready (it waited on it before).
        await picked;
        return { text: `Memory for ${run.request}`, entries: [], tokens: 5 };
      },
      runNote: async () => {},
    };
    const slots = h.deps.slots;
    h.deps.slots = {
      ...slots,
      take: (...args: Parameters<typeof slots.take>) => {
        const slot = slots.take(...args)!;
        return {
          ...slot,
          prepare: async (opts) => {
            order.push("prepare");
            release();
            return slot.prepare(opts);
          },
        };
      },
    };
    h.runner = new Runner(h.deps);
    h.brain.script = () => ({ outcome: "done", summary: "ok" });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Check my inbox" });
    await h.runner.idle();
    expect(order).toEqual(["begin Check my inbox", "prepare"]);
    expect(h.brain.starts[0]!.task.memory).toBe("Memory for Check my inbox");
    await h.sessions.flush();
    const names = (await h.sessions.traceOf(sessionId))?.events.map((e) => e.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["memory.inject", "memory.wait", "engine.tab"]));

    // The next turn in the same agent session: the same, and what is picked comes with the message.
    order.length = 0;
    arm();
    h.brain.continueScript = () => ({ outcome: "done", summary: "ok" });
    expect(await h.runner.message(sessionId, "And the spam folder")).toEqual({ sessionId, mode: "turn" });
    await h.runner.idle();
    expect(order).toEqual(["begin And the spam folder", "prepare"]);
    expect(h.brain.continues[0]!.text).toContain("Memory for And the spam folder");
  });

  it("a fresh agent session starts (prewarm) while memory is picked, not after; the same session's next turn starts none", async () => {
    const h = harness();
    const order: string[] = [];
    let release!: () => void;
    const picked = new Promise<void>((r) => (release = r));
    h.deps.memory = {
      begin: async () => {
        order.push("memory begin");
        await picked;
        order.push("memory ready");
        return { text: "Memory", entries: [], tokens: 5 };
      },
      runNote: async () => {},
    };
    h.runner = new Runner(h.deps);
    (h.brain as { prewarm?: (c: unknown) => void }).prewarm = (config) => {
      order.push(`prewarm ${(config as { model?: string }).model}`);
      release();
    };
    h.brain.script = () => ({ outcome: "done", summary: "ok" });
    const { sessionId } = await h.runner.runAdhoc({ instructions: "Check my inbox" });
    await h.runner.idle();
    expect(order).toEqual(["memory begin", `prewarm ${h.settings.anthropicModel}`, "memory ready"]);
    order.length = 0;
    h.brain.continueScript = () => ({ outcome: "done", summary: "ok" });
    await h.runner.message(sessionId, "And the spam folder");
    await h.runner.idle();
    expect(order.filter((o) => o.startsWith("prewarm"))).toEqual([]);
  });

  it("memory paused in settings: nothing given", async () => {
    const h = harness({ memoryPaused: true });
    const { store } = withMemory(h);
    await store.put({ kind: "preference", subject: "Tone", text: "Friendly", scope: "global" }, { kind: "user" });
    h.brain.script = () => ({ outcome: "done" });
    await h.runner.runAdhoc({ instructions: "Say hi" });
    await h.runner.idle();
    expect(h.brain.starts[0]!.task.memory).toBeUndefined();
  });
});
