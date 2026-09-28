import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@browsertodo/shared";
import { runControl, taskActions } from "../../src/sidepanel/task-actions.js";

const labels = (status: TaskStatus, source: "local" | "account", attempts = 1) => taskActions({ status, attempts }, source).map((a) => a.label);

describe("task menu actions", () => {
  it("the account's queue: edit waiting ones, retry failed, continue paused, cancel waiting, details, delete unless running", () => {
    expect(labels("pending", "account")).toEqual(["Edit", "Cancel", "Details", "Delete"]);
    expect(labels("paused", "account")).toEqual(["Edit", "Continue", "Cancel", "Details", "Delete"]);
    expect(labels("failed", "account")).toEqual(["Retry", "Details", "Delete"]);
    expect(labels("done", "account")).toEqual(["Details", "Delete"]);
    expect(labels("running", "account")).toEqual(["Details"]);
    // Continue on the account's queue puts the task back in it (no run in this panel).
    expect(taskActions({ status: "paused", attempts: 1 }, "account").find((a) => a.label === "Continue")!.run).toBe("tasks.retry");
  });

  it("this browser's list: continue a stopped run, run finished ones again, always delete", () => {
    expect(labels("paused", "local")).toEqual(["Edit", "Continue", "Run again", "Details", "Delete"]);
    expect(labels("failed", "local", 0)).toEqual(["Run again", "Details", "Delete"]);
    expect(labels("done", "local")).toEqual(["Run again", "Details", "Delete"]);
    expect(labels("pending", "local")).toEqual(["Edit", "Details", "Delete"]);
    expect(labels("running", "local")).toEqual(["Details", "Delete"]);
    expect(taskActions({ status: "failed", attempts: 2 }, "local")[0]!.run).toBe("continue");
  });

  it("a waiting task the agent wrote offers Trust first; one the user wrote, or one that is over, does not", () => {
    for (const source of ["account", "local"] as const) {
      expect(taskActions({ status: "pending", attempts: 0, agentAuthored: true }, source)[0]).toMatchObject({ label: "Trust", run: "trust" });
      expect(taskActions({ status: "paused", attempts: 1, agentAuthored: true }, source)[0]!.label).toBe("Trust");
      expect(taskActions({ status: "pending", attempts: 0 }, source).map((a) => a.label)).not.toContain("Trust");
      expect(taskActions({ status: "done", attempts: 1, agentAuthored: true }, source).map((a) => a.label)).not.toContain("Trust");
    }
  });
});

describe("a task row's Run button", () => {
  const running = [{ sessionId: "s1", taskId: "t-run" }];
  it("Run while waiting or stopped, Stop while this panel runs it, nothing once over", () => {
    expect(runControl({ id: "a", status: "pending" }, running)).toEqual({ kind: "run", disabled: false, title: "Run it now instead of waiting for its time" });
    expect(runControl({ id: "a", status: "paused" }, running)).toMatchObject({ kind: "run", disabled: false });
    expect(runControl({ id: "a", status: "failed" }, running)).toEqual({ kind: "run", disabled: false, title: "Run it again now, from the start" });
    expect(runControl({ id: "t-run", status: "running" }, running)).toEqual({ kind: "stop", sessionId: "s1", title: "Stop this run (it ends paused)" });
    expect(runControl({ id: "b", status: "running" }, running)).toEqual({ kind: "run", disabled: true, title: "Already running (on another browser or runner)" });
    expect(runControl({ id: "c", status: "done" }, running)).toBeNull();
    expect(runControl({ id: "c", status: "cancelled" }, running)).toBeNull();
  });
});
