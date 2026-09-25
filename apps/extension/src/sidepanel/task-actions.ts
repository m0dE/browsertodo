/**
 * The TODO tab's per-task menu: which actions a task offers, by status and
 * by where the list lives. Pure (tasks.ts renders them).
 */
import type { LocalTask } from "@browsertodo/shared";

export interface TaskAction {
  label: "Retry" | "Continue" | "Cancel" | "Run again" | "Delete";
  /** A request on the task, or "continue": go on from its last run in this panel. */
  run: "tasks.retry" | "tasks.cancel" | "tasks.delete" | "continue";
  title?: string;
  danger?: true;
}

const DELETE: TaskAction = { label: "Delete", run: "tasks.delete", danger: true };

/**
 * account: the signed-in account's queue, where runs go on from the queue
 * (retry failed tasks, continue paused ones, e.g. after a top-up, cancel
 * waiting ones). local: this browser's list, where a stopped task continues
 * from its last run in the panel.
 */
export function taskActions(task: Pick<LocalTask, "status" | "attempts">, source: "local" | "account"): TaskAction[] {
  const s = task.status;
  const actions: TaskAction[] = [];
  if (source === "account") {
    if (s === "failed") actions.push({ label: "Retry", run: "tasks.retry", title: "Put it back in the queue to run again" });
    if (s === "paused") actions.push({ label: "Continue", run: "tasks.retry", title: "Run it again now instead of waiting" });
    if (s === "pending" || s === "paused") actions.push({ label: "Cancel", run: "tasks.cancel", title: "It will not run; it moves to Finished" });
    if (s !== "running") actions.push(DELETE);
    return actions;
  }
  if ((s === "paused" || s === "failed") && task.attempts > 0) {
    actions.push({ label: "Continue", run: "continue", title: "Pick up where the last run stopped" });
  }
  if (s !== "running" && s !== "pending") {
    actions.push({ label: "Run again", run: "tasks.retry", title: "Put it back in the list to run again from the start" });
  }
  actions.push(DELETE);
  return actions;
}
