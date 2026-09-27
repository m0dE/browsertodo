/**
 * schedule_task (packages/shared tools.ts): the agent puts a task in the
 * user's TODO list from the chat ("check again in 3 hours", "make this a
 * daily task at 9am"). The task goes where the TODO tab's tasks go (the
 * signed-in account's list, a paid feature), the tab shows it at once (the
 * TODO source's change push), and the conversation gets a task_scheduled
 * event: the chat's card, with View in TODO and Undo.
 *
 * Refusals (signed out, a plan without the TODO list) are also written to
 * the conversation as an error, so the chat shows the button that fixes it;
 * the thrown message is what the agent reads and relays.
 */
import {
  describeSchedule,
  errorMessage,
  localTimeZone,
  PLAN_REQUIRED,
  SCHEDULE_PLAN_REQUIRED,
  SCHEDULE_SIGN_IN,
  ScheduleTaskArgs,
  settleSchedule,
  type ScheduledTask,
} from "@browsertodo/shared";
import type { z } from "zod";
import type { TodoSource } from "../account/todo-source.js";
import { ApiRequestError, NotSignedInError } from "../http-client.js";
import type { SessionStore } from "./sessions.js";

/** Whether the user has a TODO list to schedule into: signed in, on a plan that includes it. */
export type TodoAccess = "ok" | "signed-out" | "no-plan";

/** A one-off time this far in the past is still taken (the model's clock arithmetic, a slow turn). */
const PAST_GRACE_MS = 60_000;

export interface TaskSchedulerDeps {
  /** The TODO tab's tasks (the account's when signed in). */
  todo(): Promise<TodoSource>;
  access(): Promise<TodoAccess>;
  sessions: Pick<SessionStore, "note" | "eventsOf">;
  /** The user's IANA time zone, for the schedule in words. Default: this browser's. */
  timeZone?(): string;
  now?(): Date;
  /** 12-hour times in the schedule's words. Default: the browser locale's choice. */
  hour12?: boolean;
}

/** The refusals the chat shows with a fix button, and the line the agent reads for each. */
const REFUSALS: Record<Exclude<TodoAccess, "ok">, { chat: string; agent: string }> = {
  "signed-out": {
    chat: SCHEDULE_SIGN_IN,
    agent: `${SCHEDULE_SIGN_IN} Nothing was scheduled. Tell the user; the chat shows them a Log in button. Do not retry.`,
  },
  "no-plan": {
    chat: SCHEDULE_PLAN_REQUIRED,
    agent: `${SCHEDULE_PLAN_REQUIRED} Nothing was scheduled. Tell the user; the chat shows them a Choose a plan button. Do not retry.`,
  },
};

/** Zod's issues as one line the model can act on: "schedule.repeat.cron: hour 25 is outside 0-23". */
function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "arguments"}: ${i.message}`).join("; ");
}

export class TaskScheduler {
  constructor(private readonly deps: TaskSchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Stores the task the agent wrote for conversation `sessionId`. Throws with the reason on refusal (nothing stored). */
  async schedule(sessionId: string, rawArgs: unknown): Promise<ScheduledTask> {
    const parsed = ScheduleTaskArgs.safeParse(rawArgs);
    if (!parsed.success) throw new Error(`schedule_task arguments: ${issuesText(parsed.error)}. Nothing was scheduled.`);
    const args = parsed.data;
    const now = this.now();
    const at = args.schedule.at ?? null;
    if (at && Date.parse(at) < now.getTime() - PAST_GRACE_MS) {
      throw new Error(`schedule.at ${at} has already passed (it is now ${now.toISOString()}). Nothing was scheduled: give a time in the future.`);
    }
    const settled = settleSchedule(at, args.schedule.repeat ?? null, now);

    const access = await this.deps.access();
    if (access !== "ok") return this.refuse(sessionId, access);
    let task;
    try {
      task = await (await this.deps.todo()).add({
        instructions: args.task,
        ...(args.account ? { account: args.account } : {}),
        notBefore: settled.notBefore,
        repeat: settled.repeat,
      });
    } catch (err) {
      if (err instanceof NotSignedInError) return this.refuse(sessionId, "signed-out");
      if (err instanceof ApiRequestError && err.body?.error === PLAN_REQUIRED) return this.refuse(sessionId, "no-plan");
      throw new Error(`The TODO list did not take the task: ${errorMessage(err)}. Nothing was scheduled.`);
    }

    const when = describeSchedule(args.schedule, {
      now,
      timeZone: this.deps.timeZone?.() ?? localTimeZone(),
      ...(this.deps.hour12 === undefined ? {} : { hour12: this.deps.hour12 }),
    });
    await this.deps.sessions.note(sessionId, { type: "task_scheduled", taskId: task.id, instructions: task.instructions, schedule: args.schedule });
    return { taskId: task.id, instructions: task.instructions, when, nextRunAt: settled.notBefore };
  }

  /** Undo on the chat's card: deletes a task this conversation scheduled, and the card says so. Undoing twice is harmless. */
  async undo(sessionId: string, taskId: string): Promise<void> {
    const events = await this.deps.sessions.eventsOf(sessionId);
    if (!events.some((e) => e.type === "task_scheduled" && e.taskId === taskId)) throw new Error("That task was not scheduled in this chat");
    if (events.some((e) => e.type === "task_unscheduled" && e.taskId === taskId)) return;
    await (await this.deps.todo()).delete(taskId);
    await this.deps.sessions.note(sessionId, { type: "task_unscheduled", taskId });
  }

  private async refuse(sessionId: string, why: Exclude<TodoAccess, "ok">): Promise<never> {
    const r = REFUSALS[why];
    await this.deps.sessions.note(sessionId, { type: "error", text: r.chat });
    throw new Error(r.agent);
  }
}
