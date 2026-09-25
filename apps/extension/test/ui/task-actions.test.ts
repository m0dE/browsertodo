import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@browsertodo/shared";
import { taskActions } from "../../src/sidepanel/task-actions.js";

const labels = (status: TaskStatus, source: "local" | "account", attempts = 1) => taskActions({ status, attempts }, source).map((a) => a.label);

describe("task menu actions", () => {
  it("the account's queue: retry failed, continue paused, cancel waiting, delete unless running", () => {
    expect(labels("failed", "account")).toEqual(["Retry", "Delete"]);
    expect(labels("paused", "account")).toEqual(["Continue", "Cancel", "Delete"]);
    expect(labels("pending", "account")).toEqual(["Cancel", "Delete"]);
    expect(labels("done", "account")).toEqual(["Delete"]);
    expect(labels("running", "account")).toEqual([]);
    // Continue on the account's queue puts the task back in it (no run in this panel).
    expect(taskActions({ status: "paused", attempts: 1 }, "account")[0]!.run).toBe("tasks.retry");
  });

  it("this browser's list: continue a stopped run, run finished ones again, always delete", () => {
    expect(labels("paused", "local")).toEqual(["Continue", "Run again", "Delete"]);
    expect(labels("failed", "local", 0)).toEqual(["Run again", "Delete"]);
    expect(labels("done", "local")).toEqual(["Run again", "Delete"]);
    expect(labels("pending", "local")).toEqual(["Delete"]);
    expect(labels("running", "local")).toEqual(["Delete"]);
    expect(taskActions({ status: "failed", attempts: 2 }, "local")[0]!.run).toBe("continue");
  });
});
