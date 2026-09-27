import { describe, expect, it } from "vitest";
import { PLAN_REQUIRED, PLAN_REQUIRED_MESSAGES, SCHEDULE_PLAN_REQUIRED, SCHEDULE_SIGN_IN, type LocalTask, type SessionInfo } from "@browsertodo/shared";
import type { TodoSource } from "../src/account/todo-source.js";
import type { NewLocalTask } from "../src/engine/local-store.js";
import { TaskScheduler, type TodoAccess } from "../src/engine/schedule-task.js";
import { SessionStore } from "../src/engine/sessions.js";
import { ApiRequestError } from "../src/http-client.js";
import { MemoryKvDb } from "./memory-kv.js";

const NY = "America/New_York";
/** Sat Sep 26 2026, 15:45 in New York. */
const NOW = new Date("2026-09-26T19:45:00Z");
const SESSION: SessionInfo = { sessionId: "s1", source: "adhoc", title: "Check my order", brain: "claude-api", jev: false, startedAt: NOW.toISOString() };

/** A TODO list in memory, with what was added and deleted. */
function memoryTodo(opts: { failAdd?: Error } = {}) {
  const tasks = new Map<string, LocalTask>();
  const added: NewLocalTask[] = [];
  let n = 0;
  const source: TodoSource = {
    kind: "account",
    list: async () => ({ tasks: [...tasks.values()].map((t) => ({ ...t, media: [] })), locked: false }),
    add: async (input) => {
      if (opts.failAdd) throw opts.failAdd;
      added.push(input);
      const task = {
        id: `t${++n}`,
        instructions: input.instructions,
        account: input.account ?? null,
        mediaIds: [],
        notBefore: input.notBefore ?? null,
        repeat: input.repeat ?? null,
        status: "pending",
      } as unknown as LocalTask;
      tasks.set(task.id, task);
      return task;
    },
    update: async () => {
      throw new Error("not used");
    },
    delete: async (id) => tasks.delete(id),
    retry: async () => {
      throw new Error("not used");
    },
    cancel: async () => {
      throw new Error("not used");
    },
  };
  return { source, tasks, added };
}

async function setup(opts: { access?: TodoAccess; failAdd?: Error } = {}) {
  const sessions = new SessionStore(new MemoryKvDb(), { now: () => NOW });
  await sessions.create(SESSION);
  const todo = memoryTodo(opts);
  const scheduler = new TaskScheduler({
    todo: async () => todo.source,
    access: async () => opts.access ?? "ok",
    sessions,
    timeZone: () => NY,
    now: () => NOW,
    hour12: true,
  });
  const events = async () => (await sessions.eventsOf("s1")).map(({ ts: _ts, sessionId: _s, ...e }) => e);
  return { scheduler, sessions, todo, events };
}

describe("TaskScheduler.schedule", () => {
  it("a one-off check-up: stored in the TODO list, the chat gets its card, the model its confirmation", async () => {
    const t = await setup();
    const task = "Open https://shop.example.com/orders/42 and tell me whether order 42 has shipped.";
    const r = await t.scheduler.schedule("s1", { task, schedule: { at: "2026-09-26T22:45:00-04:00" } });
    expect(t.todo.added).toEqual([{ instructions: task, notBefore: "2026-09-27T02:45:00.000Z", repeat: null }]);
    expect(r).toEqual({ taskId: "t1", instructions: task, when: "Once, today at 10:45 PM", nextRunAt: "2026-09-27T02:45:00.000Z" });
    expect(await t.events()).toEqual([{ type: "task_scheduled", taskId: "t1", instructions: task, schedule: { at: "2026-09-26T22:45:00-04:00" } }]);
  });

  it("a daily repeat with an account: its first run is the rule's next time", async () => {
    const t = await setup();
    const r = await t.scheduler.schedule("s1", { task: "Post gm on X", account: "@alpha", schedule: { repeat: { cron: "0 9 * * *", tz: NY } } });
    expect(t.todo.added).toEqual([{ instructions: "Post gm on X", account: "@alpha", notBefore: "2026-09-27T13:00:00.000Z", repeat: { cron: "0 9 * * *", tz: NY } }]);
    expect(r.when).toBe("Daily at 9:00 AM");
    expect(r.nextRunAt).toBe("2026-09-27T13:00:00.000Z");
  });

  it("refuses bad arguments with what to fix, and stores nothing", async () => {
    const t = await setup();
    await expect(t.scheduler.schedule("s1", { task: "", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(/task/);
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: {} })).rejects.toThrow(/at.*repeat/);
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { repeat: { cron: "0 25 * * *", tz: NY } } })).rejects.toThrow(/hour 25/);
    expect(t.todo.added).toEqual([]);
    expect(await t.events()).toEqual([]);
  });

  it("refuses a time that has passed", async () => {
    const t = await setup();
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T09:00:00-04:00" } })).rejects.toThrow(/passed/);
    expect(t.todo.added).toEqual([]);
  });

  it("on a plan without the TODO list: nothing stored, the chat shows the plan card, the model is told to relay it", async () => {
    const t = await setup({ access: "no-plan" });
    const err = await t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } }).catch((e: Error) => e);
    expect((err as Error).message).toContain(SCHEDULE_PLAN_REQUIRED);
    expect((err as Error).message).toMatch(/Nothing was scheduled/);
    expect(t.todo.added).toEqual([]);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_PLAN_REQUIRED }]);
  });

  it("signed out: nothing stored, the chat offers Log in", async () => {
    const t = await setup({ access: "signed-out" });
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(SCHEDULE_SIGN_IN);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_SIGN_IN }]);
  });

  it("the server's plan refusal (a plan cached here that changed) reads the same", async () => {
    const refusal = new ApiRequestError(403, PLAN_REQUIRED_MESSAGES.todo, { error: PLAN_REQUIRED, feature: "todo", message: PLAN_REQUIRED_MESSAGES.todo });
    const t = await setup({ failAdd: refusal });
    await expect(t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } })).rejects.toThrow(SCHEDULE_PLAN_REQUIRED);
    expect(await t.events()).toEqual([{ type: "error", text: SCHEDULE_PLAN_REQUIRED }]);
  });
});

describe("TaskScheduler.undo", () => {
  it("deletes the task and marks the card undone; a second undo changes nothing", async () => {
    const t = await setup();
    const { taskId } = await t.scheduler.schedule("s1", { task: "x", schedule: { at: "2026-09-26T22:45:00Z" } });
    await t.scheduler.undo("s1", taskId);
    expect(t.todo.tasks.has(taskId)).toBe(false);
    await t.scheduler.undo("s1", taskId);
    expect((await t.events()).map((e) => e.type)).toEqual(["task_scheduled", "task_unscheduled"]);
  });

  it("only undoes a task this chat scheduled", async () => {
    const t = await setup();
    await expect(t.scheduler.undo("s1", "t-other")).rejects.toThrow(/not scheduled in this chat/);
  });
});
