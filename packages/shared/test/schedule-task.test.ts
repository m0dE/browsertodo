import { describe, expect, it } from "vitest";
import {
  describeRepeat,
  describeSchedule,
  ScheduleTaskArgs,
  SCHEDULE_PLAN_REQUIRED,
  SCHEDULE_SIGN_IN,
  SCHEDULE_TASK_DESCRIPTION,
  scheduledTaskText,
  userTimeLine,
  type ScheduleInput,
} from "../src/index.js";

const NY = "America/New_York";
/** Sat Sep 26 2026, 15:45 in New York (EDT, UTC-4). */
const NOW = new Date("2026-09-26T19:45:00Z");
const describeNy = (s: ScheduleInput) => describeSchedule(s, { now: NOW, timeZone: NY, hour12: true });

describe("ScheduleTaskArgs", () => {
  it("takes a one-off time or a repeat, with the task written out", () => {
    expect(ScheduleTaskArgs.safeParse({ task: "Check the order status at https://shop.example.com/orders/42", schedule: { at: "2026-09-26T18:45:00-04:00" } }).success).toBe(true);
    const repeat = ScheduleTaskArgs.parse({ task: " Post gm on X from @alpha ", schedule: { repeat: { cron: "0 9 * * 1-5", tz: NY } }, account: "@alpha" });
    expect(repeat.task).toBe("Post gm on X from @alpha");
    expect(repeat.schedule.repeat?.cron).toBe("0 9 * * 1-5");
  });

  it("refuses an empty task, a schedule with neither time nor repeat, a time without an offset, a bad cron or zone", () => {
    const bad = [
      { task: "  ", schedule: { at: "2026-09-26T18:45:00Z" } },
      { task: "x", schedule: {} },
      { task: "x", schedule: { at: null, repeat: null } },
      { task: "x", schedule: { at: "2026-09-26T18:45:00" } },
      { task: "x", schedule: { repeat: { cron: "every day", tz: NY } } },
      { task: "x", schedule: { repeat: { cron: "0 9 * * *", tz: "Mars/Olympus" } } },
    ];
    for (const args of bad) expect(ScheduleTaskArgs.safeParse(args).success, JSON.stringify(args)).toBe(false);
  });

  it("tells the model the task must stand on its own", () => {
    expect(SCHEDULE_TASK_DESCRIPTION).toMatch(/TODO list/);
    expect(SCHEDULE_TASK_DESCRIPTION).toMatch(/no memory of this chat/);
    const task = ScheduleTaskArgs.shape.task.description ?? "";
    expect(task).toMatch(/no memory of this chat/i);
    expect(task).toMatch(/URLs/);
    expect(task).toMatch(/Never 'same as before'/);
  });
});

describe("describeSchedule", () => {
  it("a one-off time: today, tomorrow, or its date, in the user's zone", () => {
    expect(describeNy({ at: "2026-09-26T22:45:00Z" })).toBe("Once, today at 6:45 PM");
    expect(describeNy({ at: "2026-09-27T13:00:00Z" })).toBe("Once, tomorrow at 9:00 AM");
    expect(describeNy({ at: "2026-10-05T13:30:00Z" })).toBe("Once, Mon, Oct 5 at 9:30 AM");
    expect(describeSchedule({ at: "2026-09-26T22:45:00Z" }, { now: NOW, timeZone: NY, hour12: false })).toBe("Once, today at 18:45");
  });

  it("a repeat in the schedule model's words; another zone and a first run are said", () => {
    const weekdays = { cron: "0 9 * * 1-5", tz: NY };
    expect(describeNy({ repeat: weekdays })).toBe(describeRepeat(weekdays, { now: NOW, hour12: true }));
    expect(describeNy({ repeat: weekdays })).toBe("Every weekday at 9:00 AM");
    expect(describeNy({ repeat: { cron: "0 9 * * *", tz: "Europe/Lisbon" } })).toMatch(/9:00 AM \(Europe\/Lisbon\)$/);
    expect(describeNy({ at: "2026-09-28T13:00:00Z", repeat: weekdays })).toBe("Every weekday at 9:00 AM, first run Mon, Sep 28 at 9:00 AM");
  });
});

describe("messages", () => {
  it("say what scheduling needs, and what was stored", () => {
    expect(SCHEDULE_PLAN_REQUIRED).toBe("Scheduling needs a paid plan.");
    expect(SCHEDULE_SIGN_IN).toMatch(/log in/i);
    const text = scheduledTaskText({ taskId: "t9", instructions: "Check the order status\nat the shop", when: "Once, today at 6:45 PM", nextRunAt: "2026-09-26T22:45:00.000Z" });
    expect(text).toContain('"Check the order status"');
    expect(text).toContain("Once, today at 6:45 PM");
    expect(text).toContain("t9");
  });
});

describe("userTimeLine", () => {
  it("the user's date, time, zone and UTC offset, for the prompt's relative times", () => {
    expect(userTimeLine(NY, NOW)).toBe("The user's time: Saturday, September 26, 2026, 3:45 PM in America/New_York (UTC-04:00).");
    expect(userTimeLine("Asia/Kolkata", NOW)).toBe("The user's time: Sunday, September 27, 2026, 1:15 AM in Asia/Kolkata (UTC+05:30).");
    expect(userTimeLine("UTC", NOW)).toBe("The user's time: Saturday, September 26, 2026, 7:45 PM in UTC (UTC+00:00).");
  });
});
