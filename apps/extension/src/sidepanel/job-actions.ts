/**
 * The job page's "⋯" menu: which actions a job offers (only those that apply to it now), in words. Pure; the page
 * (job-page.ts) runs them.
 */
import type { Job } from "./jobs.js";

export type JobActionId = "run" | "pause" | "resume" | "schedule" | "trust" | "show" | "raw" | "rename" | "cancel" | "delete";

export interface JobAction {
  id: JobActionId;
  label: string;
  /** What it does (the item's tooltip). */
  title: string;
  danger?: true;
}

/** The Raw item's tooltip. */
export const RAW_TITLE = "The whole conversation with how long each step took (to find what is slow); copy it or download it for the developer";

/** Trust: on a task the agent wrote (Task.agentAuthored). */
export const TRUST_TITLE = "The agent wrote this task. Trust it to do what it says without asking you, like a task you wrote";

/** A task that waits (pending or paused) can still be changed. */
const waits = (job: Job) => job.task?.status === "pending" || job.task?.status === "paused";

/**
 * source: where the TODO list lives (the signed-in account's queue, or this browser). Running tasks of the account's
 * queue cannot be deleted from here; this browser's can be once stopped.
 */
export function jobActions(job: Job, source: "local" | "account"): JobAction[] {
  const t = job.task;
  const s = job.session;
  const out: JobAction[] = [];
  if (t && !job.running && (t.status === "pending" || t.status === "paused" || t.status === "failed")) {
    out.push({ id: "run", label: "Run now", title: t.status === "pending" ? "Run it now instead of waiting for its time" : "Run it again now, from the start" });
  }
  if (job.running) out.push({ id: "pause", label: "Pause", title: "Stop the agent here; the job waits for you (Resume goes on)" });
  if (!job.running && job.state === "needs" && canResume(job, source)) {
    out.push({ id: "resume", label: "Resume", title: source === "account" && t ? "Put it back in the queue to run now" : "Pick up where it stopped" });
  }
  if (t && waits(job)) out.push({ id: "schedule", label: "Edit schedule", title: "Change when it runs: one time, or on a repeat" });
  else if (job.kind === "chat" && s?.source === "adhoc" && s.instructions?.trim()) {
    out.push({ id: "schedule", label: "Schedule", title: "Run this request again later, or on a repeat" });
  }
  if (t?.agentAuthored && waits(job)) out.push({ id: "trust", label: "Trust", title: TRUST_TITLE });
  if (job.running) out.push({ id: "show", label: "Show tab", title: "Switch to the tab the agent is using" });
  if (s) out.push({ id: "raw", label: "Raw", title: RAW_TITLE });
  if (job.kind === "chat" && s?.source === "adhoc") out.push({ id: "rename", label: "Rename", title: "Give this job your own name" });
  if (t && source === "account" && waits(job)) out.push({ id: "cancel", label: "Cancel", title: "It will not run" });
  if (!job.running && !(t?.status === "running" && source === "account")) {
    out.push({ id: "delete", label: "Delete", title: job.kind === "task" ? "Delete the task and its runs" : "Delete this chat", danger: true });
  }
  return out;
}

/**
 * Resume goes on from the job's last run: a stopped conversation in this browser; the account's queue runs a paused
 * task again by itself (tasks.retry).
 */
function canResume(job: Job, source: "local" | "account"): boolean {
  if (job.task && source === "account") return job.task.status === "paused";
  return !!job.session?.endedAt && job.session.source !== "cloud";
}
