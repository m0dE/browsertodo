/**
 * The TODO tab's per-task menu ("⋯"): which actions a task offers, by status
 * and by where the list lives. Run and Stop sit on the row itself
 * (runControl). Pure (tasks.ts renders them).
 */
import type { LocalTask } from "@browsertodo/shared";

export interface TaskAction {
  label: "Trust" | "Edit" | "Retry" | "Continue" | "Cancel" | "Run again" | "Details" | "Delete";
  /**
   * A request on the task; "continue": go on from its last run in this panel; "edit" / "details": the form / the
   * details sheet; "trust": the user takes the agent's instructions as theirs (Task.agentAuthored).
   */
  run: "tasks.retry" | "tasks.cancel" | "tasks.delete" | "continue" | "edit" | "details" | "trust";
  title?: string;
  danger?: true;
}

const DELETE: TaskAction = { label: "Delete", run: "tasks.delete", danger: true };
const EDIT: TaskAction = { label: "Edit", run: "edit", title: "Change what it does and when it runs" };
const DETAILS: TaskAction = { label: "Details", run: "details", title: "The full task, its schedule and its runs" };
/** On a task the agent wrote (Task.agentAuthored). */
export const TRUST: TaskAction = {
  label: "Trust",
  run: "trust",
  title: "The agent wrote this task. Trust it to do what it says without asking you, like a task you wrote",
};

/** Waiting tasks can be edited (the API allows it while pending or paused). */
const editable = (s: LocalTask["status"]) => s === "pending" || s === "paused";

/**
 * account: the signed-in account's queue, where runs go on from the queue
 * (retry failed tasks, continue paused ones, e.g. after a top-up, cancel
 * waiting ones). local: this browser's list, where a stopped task continues
 * from its last run in the panel.
 */
export function taskActions(task: Pick<LocalTask, "status" | "attempts" | "agentAuthored">, source: "local" | "account"): TaskAction[] {
  const s = task.status;
  const actions: TaskAction[] = editable(s) ? [...(task.agentAuthored ? [TRUST] : []), EDIT] : [];
  if (source === "account") {
    if (s === "failed") actions.push({ label: "Retry", run: "tasks.retry", title: "Put it back in the queue to run again" });
    if (s === "paused") actions.push({ label: "Continue", run: "tasks.retry", title: "Run it again now instead of waiting" });
    if (s === "pending" || s === "paused") actions.push({ label: "Cancel", run: "tasks.cancel", title: "It will not run; it moves to Finished" });
  } else {
    if ((s === "paused" || s === "failed") && task.attempts > 0) {
      actions.push({ label: "Continue", run: "continue", title: "Pick up where the last run stopped" });
    }
    if (s !== "running" && s !== "pending") {
      actions.push({ label: "Run again", run: "tasks.retry", title: "Put it back in the list to run again from the start" });
    }
  }
  actions.push(DETAILS);
  if (s !== "running" || source === "local") actions.push(DELETE);
  return actions;
}

export type RunControl =
  | { kind: "run"; disabled: false; title: string }
  | { kind: "stop"; sessionId: string; title: string }
  | { kind: "run"; disabled: true; title: string }
  | null;

/**
 * The row's own button: Run (that task now, whatever its time), Stop while it
 * runs, or nothing once it is over. Disabled, with the reason, while it runs
 * somewhere this panel cannot stop.
 */
export function runControl(task: Pick<LocalTask, "id" | "status">, running: readonly { sessionId: string; taskId?: string }[]): RunControl {
  const session = running.find((r) => r.taskId === task.id);
  if (session) return { kind: "stop", sessionId: session.sessionId, title: "Stop this run (it ends paused)" };
  switch (task.status) {
    case "running":
      return { kind: "run", disabled: true, title: "Already running (on another browser or runner)" };
    case "pending":
      return { kind: "run", disabled: false, title: "Run it now instead of waiting for its time" };
    case "paused":
    case "failed":
      return { kind: "run", disabled: false, title: "Run it again now, from the start" };
    default:
      return null;
  }
}
