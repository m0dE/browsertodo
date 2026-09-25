/** Runner scheduling: failure pauses, pacing, stop, keep-alive, and several tasks at once (slots, X turns). */
import { describe, expect, it, vi } from "vitest";
import type { TaskRunResult } from "@browsertodo/shared";
import { claimFixture } from "../fixtures.js";
import { MAX_SLOTS, X_WAIT_STATUS } from "../../src/engine/run/scheduling.js";
import { KEEP_ALIVE_MS } from "../../src/engine/run/state.js";
import { env, harness, parallel, runAll, setupRunnerTests } from "./harness.js";

setupRunnerTests();

describe("Runner: scheduling", () => {
  it("pauses scheduled runs after maxConsecutiveFailures failed tasks in a row", async () => {
    const h = harness({ maxConsecutiveFailures: 2 });
    await h.store.add({ instructions: "a" });
    env.clock += 1;
    await h.store.add({ instructions: "b" });
    env.clock += 1;
    const c = await h.store.add({ instructions: "c" });
    h.brain.script = () => ({ outcome: "failed", reason: "button not found" });
    await runAll(h);
    expect(h.brain.starts).toHaveLength(2);
    expect(h.settings.paused).toBe(true);
    const st = await h.runner.state();
    expect(st.pausedReason).toMatch(/Paused after 2 failed tasks in a row. Last: button not found/);
    expect(h.notifications.map((n) => n.title)).toEqual(["Runs paused"]);
    expect(await h.store.get(c.id)).toMatchObject({ status: "pending" });
    // Alarm runs are skipped while paused.
    expect(await h.runner.runDue("alarm")).toEqual({ started: false, detail: "Scheduled runs are paused" });
    // Resume clears the reason and the counter.
    await h.runner.resumeSchedule();
    expect(h.settings.paused).toBe(false);
    expect(await h.runner.state()).toMatchObject({ consecutiveFailures: 0 });
    expect((await h.runner.state()).pausedReason).toBeUndefined();
  });

  it("a done resets the consecutive failure counter", async () => {
    const h = harness({ maxConsecutiveFailures: 2 });
    for (const x of ["a", "b", "c"]) {
      await h.store.add({ instructions: x });
      env.clock += 1;
    }
    const outcomes: TaskRunResult[] = [{ outcome: "failed", reason: "x" }, { outcome: "done" }, { outcome: "failed", reason: "y" }];
    h.brain.script = () => outcomes.shift()!;
    await runAll(h);
    expect(h.brain.starts).toHaveLength(3);
    expect(h.settings.paused).toBe(false);
    expect((await h.runner.state()).consecutiveFailures).toBe(1);
  });

  it("adhoc failures do not count toward the consecutive failure pause", async () => {
    const h = harness({ maxConsecutiveFailures: 1 });
    h.brain.script = () => ({ outcome: "failed", reason: "nope" });
    await h.runner.runAdhoc({ instructions: "x" });
    await h.runner.idle();
    expect(h.settings.paused).toBe(false);
  });

  it("paces between tasks but not after the last one", async () => {
    const h = harness({ delayMinSec: 5, delayMaxSec: 5 });
    await h.store.add({ instructions: "a" });
    env.clock += 1;
    await h.store.add({ instructions: "b" });
    await runAll(h);
    expect(h.brain.starts).toHaveLength(2);
    expect(h.sleeps).toEqual([5000]);
  });

  it("stop() ends the session as paused and ends the run", async () => {
    const h = harness();
    const a = await h.store.add({ instructions: "a" });
    await h.store.add({ instructions: "b" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(h.runner.stop()).toBe(true);
    await h.runner.idle();
    expect(h.brain.ctls[0]!.aborts).toEqual([{ reason: "stopped by user", outcome: "paused" }]);
    expect(await h.store.get(a.id)).toMatchObject({ status: "paused", pauseReason: "stopped by user" });
    expect(h.brain.starts).toHaveLength(1);
    expect(h.runner.stop()).toBe(false);
  });

  it("refuses a second run while one is active", async () => {
    const h = harness();
    await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect(await h.runner.runDue("manual")).toEqual({ started: false, detail: "A task is already running" });
    await expect(h.runner.runAdhoc({ instructions: "x" })).rejects.toThrow(/already running/);
    h.runner.stop();
    await h.runner.idle();
  });

  it("an alarm that fires during a run triggers one more due check afterwards", async () => {
    const h = harness({ cloudEnabled: true, apiBase: "https://api.test", runnerKey: "bt_k" });
    await h.store.add({ instructions: "a" });
    // The first claim (end of the first run) finds nothing; the task shows up later.
    h.claims.push(null, claimFixture("late"));
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    expect((await h.runner.runDue("alarm")).started).toBe(false);
    h.brain.script = () => ({ outcome: "done" });
    h.brain.ctls[0]!.resolve({ outcome: "done" });
    await vi.waitFor(() => expect(h.brain.starts.map((s) => s.task.id)).toEqual(["t1", "late"]));
    await h.runner.idle();
  });

  it("keeps the service worker alive every 20 s while busy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = harness();
    await h.store.add({ instructions: "a" });
    h.brain.script = () => "hang";
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(h.brain.starts).toHaveLength(1));
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(env.chrome.runtime.platformInfoCalls).toBe(3);
    h.runner.stop();
    await h.runner.idle();
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(env.chrome.runtime.platformInfoCalls).toBe(3);
  });
});

describe("Runner: several tasks at once", () => {
  it("runs up to maxParallelTasks tasks at once, each in its own tab, with the pause between starts", async () => {
    const { h, pool, startsOf, finishTask } = parallel();
    for (const x of ["a", "b", "c"]) {
      await h.store.add({ instructions: `Like the newest photo on example.com/${x}` });
      env.clock += 1;
    }
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1", "t2"]));
    expect(h.runner.runningSessions).toHaveLength(2);
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 own-tab", "prepare 1 own-tab"]);
    // One pause between the two starts, none before the first.
    expect(h.sleeps).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(startsOf()).toHaveLength(2);

    await finishTask("t1");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1", "t2", "t3"]));
    // The freed tab is used again.
    expect(pool.log.filter((l) => l.startsWith("take")).map((l) => l.split(" ")[1])).toEqual(["0", "1", "0"]);
    expect(h.sleeps).toHaveLength(2);
    await finishTask("t2");
    await finishTask("t3");
    await h.runner.idle();
    expect((await h.store.list()).map((t) => t.status)).toEqual(["done", "done", "done"]);
    expect(h.runner.runningSessions).toEqual([]);
    expect(pool.owner.size).toBe(0);
  });

  it("X tasks never run at the same time; other tasks run beside them", async () => {
    const { h, overlaps, startsOf, finishTask } = parallel({ maxParallelTasks: 3 });
    await h.store.add({ instructions: "Post: gm", account: "@alpha" }); // t1: X (account)
    env.clock += 1;
    await h.store.add({ instructions: "Reply to @beta's newest post with thanks" }); // t2: X (@handle)
    env.clock += 1;
    await h.store.add({ instructions: "Email paul@example.com the invoice" }); // t3: not X (an email address)
    env.clock += 1;
    await h.store.add({ instructions: "Open https://x.com/home and like the first post" }); // t4: X (x.com)
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1", "t3"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(startsOf()).toEqual(["t1", "t3"]);
    // The other task ending frees room, but not the X turn.
    await finishTask("t3");
    await new Promise((r) => setTimeout(r, 20));
    expect(startsOf()).toEqual(["t1", "t3"]);
    await finishTask("t1");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1", "t3", "t2"]));
    await finishTask("t2");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1", "t3", "t2", "t4"]));
    await finishTask("t4");
    await h.runner.idle();
    const xTasks = new Set(["t1", "t2", "t4"]);
    for (const running of overlaps) expect(running.filter((id) => xTasks.has(id)).length).toBeLessThanOrEqual(1);
  });

  it("one-off runs start beside scheduled ones; an X one-off waits for the running X task", async () => {
    const { h, pool, startsOf, finishTask } = parallel({ maxParallelTasks: 1 });
    await h.store.add({ instructions: "Post: scheduled", account: "@alpha" });
    await h.runner.runDue("manual");
    await vi.waitFor(() => expect(startsOf()).toEqual(["t1"]));

    const plain = await h.runner.runAdhoc({ instructions: "Summarize my inbox at mail.example.com" });
    await vi.waitFor(() => expect(startsOf()).toHaveLength(2));
    expect(pool.owner.get(1)).toBe(plain.sessionId);

    const x = await h.runner.runAdhoc({ instructions: "Post on X from @beta: hello" });
    await h.sessions.flush();
    const waiting = await h.sessions.eventsOf(x.sessionId);
    expect(waiting.map((e) => (e.type === "status" ? e.text : e.type))).toContain(X_WAIT_STATUS);
    expect(startsOf()).toHaveLength(2);
    expect(h.runner.runningSessions.map((s) => s.sessionId)).toContain(x.sessionId);

    await finishTask("t1");
    await vi.waitFor(() => expect(startsOf()).toHaveLength(3));
    expect(h.brain.starts[2]!.sessionId).toBe(x.sessionId);
    h.brain.ctls[1]!.resolve({ outcome: "done" });
    h.brain.ctls[2]!.resolve({ outcome: "done" });
    await h.runner.idle();
  });

  it("each run uses its own tab: the API brain's browser, verification, pause URLs, Stop", async () => {
    const { h, pool, startsOf } = parallel();
    const a = await h.runner.runAdhoc({ instructions: "one" });
    const b = await h.runner.runAdhoc({ instructions: "two" });
    await vi.waitFor(() => expect(startsOf()).toHaveLength(2));
    // One-off runs act on the tab the user is looking at (each slot picks its own).
    expect(pool.log.filter((l) => l.startsWith("prepare"))).toEqual(["prepare 0 current-tab", "prepare 1 current-tab"]);
    expect(h.brain.starts[0]!.browser).toBe(pool.slots.get(0)!.browser);
    expect(h.brain.starts[1]!.browser).toBe(pool.slots.get(1)!.browser);
    // A login page in slot 1's tab pauses only that session.
    await h.runner.onTabUpdated(101, { url: "https://x.com/i/flow/login" });
    expect(h.brain.ctls[1]!.aborts).toEqual([{ reason: "X is asking to log in", outcome: "paused" }]);
    expect(h.brain.ctls[0]!.aborts).toEqual([]);
    // Stop one session: the other goes on.
    expect(h.runner.stop("nope")).toBe(false);
    expect(h.runner.stop(a.sessionId)).toBe(true);
    await vi.waitFor(async () => expect((await h.sessions.get(a.sessionId))?.outcome).toBe("paused"));
    expect(h.runner.runningSessions).toEqual([]);
    expect((await h.sessions.get(b.sessionId))?.reason).toBe("X is asking to log in");

    // Verification uses the tab of the run that posted.
    h.brain.script = () => ({ outcome: "done", url: "https://x.com/me/status/9" });
    await h.runner.runAdhoc({ instructions: "three" });
    await h.runner.idle();
    expect(h.verify).toHaveBeenLastCalledWith(pool.slots.get(0)!.browser, "https://x.com/me/status/9", "");
  });

  it("a conversation's next turn uses the tab it used, unless another run has it", async () => {
    const { h, pool } = parallel();
    h.brain.script = () => ({ outcome: "done" });
    const a = await h.runner.runAdhoc({ instructions: "one" });
    await h.runner.idle();
    const b = await h.runner.runAdhoc({ instructions: "two" }); // slot 0 again, now B's
    await h.runner.idle();
    await h.runner.message(a.sessionId, "and more");
    await h.runner.idle();
    expect(pool.log.filter((l) => l.startsWith("take")).map((l) => l.split(" ").slice(1).join(" "))).toEqual([`0 ${a.sessionId}`, `0 ${b.sessionId}`, `0 ${a.sessionId}`]);
    h.brain.script = () => "hang";
    await h.runner.runAdhoc({ instructions: "busy" }); // takes slot 0
    await h.runner.message(b.sessionId, "and b more");
    expect(pool.log.filter((l) => l.startsWith("take")).at(-1)).toBe(`take 1 ${b.sessionId}`);
    h.runner.stop();
    await h.runner.idle();
  });

  it("refuses a one-off run when every tab is in use", async () => {
    const { h } = parallel();
    for (let i = 0; i < MAX_SLOTS; i++) await h.runner.runAdhoc({ instructions: `run ${i}` });
    await expect(h.runner.runAdhoc({ instructions: "one more" })).rejects.toThrow(`${MAX_SLOTS} tasks are running`);
    h.runner.stop();
    await h.runner.idle();
  });
});
