import { describe, expect, it } from "vitest";
import { chipHint, taskChip, USER_STOP_REASON, type SessionInfo } from "@browsertodo/shared";
import { APPROVAL_REASON, buildJobs, groupJobs, jobKeyOf, jobRow, jobSubtitle, type JobInputs, type JobTask } from "../../src/sidepanel/jobs.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const DAILY = { cron: "0 9 * * *", tz: "UTC" };

function session(id: string, min: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Chat ${id}`, brain: "claude-api", jev: false, startedAt: at(min), endedAt: at(min + 2), outcome: "done", ...extra };
}
function task(id: string, extra: Partial<JobTask> = {}): JobTask {
  return {
    id,
    instructions: `Task ${id}`,
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "pending",
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: null,
    failReason: null,
    createdAt: at(-600),
    updatedAt: at(-600),
    ...extra,
  } as JobTask;
}
const jobs = (input: Partial<JobInputs>) => buildJobs({ sessions: [], running: [], tasks: [], ...input }, NOW);
const byKey = (input: Partial<JobInputs>) => new Map(jobs(input).map((j) => [j.key, j]));
const layout = (input: Partial<JobInputs>, query = "") => groupJobs(jobs(input), query).map((g) => [g.label, g.jobs.map((j) => j.key)]);

describe("jobs: what each job is", () => {
  it("a chat is one job; a task and its runs are one job", () => {
    const j = byKey({
      sessions: [session("c1", -30), session("r1", -20, { source: "local", taskId: "t1", seriesId: "t1", title: "Task t1" })],
      tasks: [task("t1", { status: "done", updatedAt: at(-18) })],
    });
    expect([...j.keys()].sort()).toEqual(["chat:c1", "task:t1"]);
    expect(j.get("chat:c1")).toMatchObject({ kind: "chat", title: "Chat c1", state: "done", group: "recent", runs: [expect.objectContaining({ sessionId: "c1" })] });
    expect(j.get("task:t1")).toMatchObject({ kind: "task", title: "Task t1", state: "done", task: expect.objectContaining({ id: "t1" }), session: expect.objectContaining({ sessionId: "r1" }) });
  });

  it("a repeating task shows once: every repeat and run of its series is in the one job, the waiting repeat stands for it", () => {
    const tasks = [
      task("t1", { status: "done", repeat: DAILY, seriesId: "t1", createdAt: at(-3000), updatedAt: at(-2990) }),
      task("t2", { status: "failed", repeat: DAILY, seriesId: "t1", createdAt: at(-1560), updatedAt: at(-1550), failReason: "X was down" }),
      task("t3", { status: "pending", repeat: DAILY, seriesId: "t1", createdAt: at(-120), notBefore: at(1260) }),
    ];
    const sessions = [
      session("r2", -1560, { source: "local", taskId: "t2", seriesId: "t1", outcome: "failed" }),
      // An older run from before tasks had a series: found by its task.
      session("r1", -3000, { source: "local", taskId: "t1" }),
    ];
    const all = jobs({ tasks, sessions });
    expect(all).toHaveLength(1);
    const [j] = all;
    expect(j).toMatchObject({ key: "task:t1", state: "scheduled", group: "scheduled", next: at(1260), repeat: DAILY });
    expect(j!.task!.id).toBe("t3");
    expect(j!.tasks.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);
    expect(j!.runs.map((r) => r.sessionId)).toEqual(["r1", "r2"]);
    expect(j!.session!.sessionId).toBe("r2");
  });

  it("runs of a deleted task stay together, by their series", () => {
    const j = jobs({ sessions: [session("a", -100, { source: "local", taskId: "x1", seriesId: "x" }), session("b", -50, { source: "local", taskId: "x2", seriesId: "x", title: "Post the tip" })] });
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ key: "task:x", kind: "task", task: null, title: "Post the tip", state: "done" });
  });

  it("jobKeyOf: a run belongs to its task's series, a chat to itself", () => {
    expect(jobKeyOf({ sessionId: "c", source: "adhoc" })).toBe("chat:c");
    expect(jobKeyOf({ sessionId: "r", source: "local", taskId: "t2" }, new Map([["t2", "t1"]]))).toBe("task:t1");
    expect(jobKeyOf({ sessionId: "r", source: "cloud", taskId: "q9" })).toBe("task:q9");
    expect(jobKeyOf({ sessionId: "r", source: "local", taskId: "t2", seriesId: "s" })).toBe("task:s");
  });

  it("needs you: a paused task, an approval waiting, a chat that stopped for the user; a chat the user stopped is over", () => {
    const j = byKey({
      tasks: [task("paused", { status: "paused", pauseReason: "Log in to X" })],
      sessions: [
        session("asks", -5, { endedAt: undefined, outcome: undefined }),
        session("dates", -40, { outcome: "paused", reason: "Needs you to pick dates" }),
        session("stopped", -60, { outcome: "paused", reason: USER_STOP_REASON }),
        session("gone", -70, { endedAt: undefined, outcome: undefined }),
      ],
      running: [session("asks", -5, { endedAt: undefined, outcome: undefined })],
      awaitingApproval: ["asks"],
    });
    expect(j.get("task:paused")).toMatchObject({ state: "needs", reason: "Log in to X" });
    expect(j.get("chat:asks")).toMatchObject({ state: "needs", reason: APPROVAL_REASON, running: true });
    expect(j.get("chat:dates")).toMatchObject({ state: "needs", reason: "Needs you to pick dates" });
    expect(j.get("chat:stopped")).toMatchObject({ state: "stopped", group: "recent" });
    // Never ended and not running: its worker stopped under it.
    expect(j.get("chat:gone")).toMatchObject({ state: "stopped", group: "recent" });
  });

  it("running: a run in this browser (the live copy wins), or a task running elsewhere", () => {
    const listed = session("r", -3, { source: "local", taskId: "t1", endedAt: undefined, outcome: undefined, title: "old" });
    const j = byKey({
      tasks: [task("t1", { status: "running" }), task("t9", { status: "running" })],
      sessions: [listed],
      running: [{ ...listed, title: "new" }, session("chat", -1, { endedAt: undefined, outcome: undefined })],
    });
    expect(j.get("task:t1")).toMatchObject({ state: "running", running: true, session: expect.objectContaining({ title: "new" }) });
    expect(j.get("task:t9")).toMatchObject({ state: "running", running: false, session: null });
    // A running session the list does not have yet is a job too.
    expect(j.get("chat:chat")).toMatchObject({ state: "running" });
  });

  it("scheduled: waiting, due now, retrying", () => {
    const j = byKey({
      tasks: [
        task("later", { notBefore: at(60) }),
        task("due", { notBefore: at(-5) }),
        task("asap"),
        task("retry", { retryAfter: at(30), failReason: "Network" }),
      ],
    });
    expect(j.get("task:later")).toMatchObject({ state: "scheduled", next: at(60) });
    expect(j.get("task:due")!.state).toBe("due");
    expect(j.get("task:asap")).toMatchObject({ state: "due", next: null });
    expect(j.get("task:retry")).toMatchObject({ state: "retry", reason: "Network", group: "scheduled" });
  });

  it("the site is its newest run's (www. dropped); a chat without a title is 'Look at this page'", () => {
    const j = byKey({ sessions: [session("c", -5, { url: "https://www.x.com/home", title: "  " })] });
    expect(j.get("chat:c")).toMatchObject({ site: "x.com", title: "Look at this page" });
  });
});

describe("jobs: groups and order", () => {
  const input: Partial<JobInputs> = {
    tasks: [
      task("tomorrow", { notBefore: at(1300), repeat: DAILY }),
      task("soon", { notBefore: at(20) }),
      task("now", { notBefore: at(-1) }),
      task("paused", { status: "paused", updatedAt: at(-10) }),
    ],
    sessions: [
      session("old", -500),
      session("new", -50),
      session("mid", -200, { outcome: "failed" }),
      session("live", -2, { endedAt: undefined, outcome: undefined }),
      session("asking", -30, { outcome: "paused", reason: "Pick a seat" }),
    ],
    running: [session("live", -2, { endedAt: undefined, outcome: undefined })],
  };

  it("Needs you, Running, Scheduled (soonest first, due first), Recent (newest first)", () => {
    expect(layout(input)).toEqual([
      ["Needs you", ["task:paused", "chat:asking"]],
      ["Running", ["chat:live"]],
      ["Scheduled", ["task:now", "task:soon", "task:tomorrow"]],
      ["Recent", ["chat:new", "chat:mid", "chat:old"]],
    ]);
  });

  it("only groups that have jobs", () => {
    expect(layout({ sessions: [session("a", -5)] })).toEqual([["Recent", ["chat:a"]]]);
    expect(layout({})).toEqual([]);
  });

  it("search: every word, in any order, in the title, instructions or site, any case", () => {
    const find = { tasks: [task("t", { instructions: "Post the weekly recap on X" })], sessions: [session("c", -5, { title: "Flights to Lisbon", instructions: "Find the cheapest flight to Lisbon in May", url: "https://www.google.com/travel" }), session("d", -9, { title: "Inbox" })] };
    expect(layout(find, "RECAP weekly")).toEqual([["Scheduled", ["task:t"]]]);
    expect(layout(find, "cheapest may")).toEqual([["Recent", ["chat:c"]]]);
    expect(layout(find, "google.com")).toEqual([["Recent", ["chat:c"]]]);
    expect(layout(find, "lisbon recap")).toEqual([]);
    expect(layout(find, "  ")).toHaveLength(2);
  });
});

describe("jobs: rows and subtitles in words", () => {
  it("a scheduled repeating job: its rule under the title, the next run on the right", () => {
    const [j] = jobs({ tasks: [task("t", { notBefore: at(60), repeat: DAILY })] });
    const row = jobRow(j!, NOW);
    expect(row.meta).toBe("Daily at 9:00 AM");
    // Today: the time alone; later days say which.
    expect(row.when).toMatch(/^(Tomorrow )?\d{1,2}:\d\d/);
    expect(row.label).toContain("Task t, Scheduled, Daily at 9:00 AM, next");
    // Inside a line "today" and "tomorrow" are lower case; only the line starts with a capital.
    expect(jobSubtitle(j!, NOW)).toMatch(/^Daily at 9:00 AM · next (today|tomorrow) /);
  });

  it("a daily 9:00 series: the next run is its waiting row's 9:00, never an earlier run's time", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const daily = { cron: "0 9 * * *", tz: zone };
    // The next 9:00 in this machine's zone after NOW.
    const next = new Date(NOW);
    next.setHours(9, 0, 0, 0);
    if (next.getTime() <= NOW) next.setDate(next.getDate() + 1);
    const tasks = [
      task("s1", { status: "done", repeat: daily, seriesId: "s1", createdAt: at(-1500), updatedAt: at(-1437) }),
      task("s2", { status: "pending", repeat: daily, seriesId: "s1", createdAt: at(-37), updatedAt: at(-37), notBefore: next.toISOString() }),
    ];
    // Its runs ended at odd times (9:03, and 37 minutes ago).
    const sessions = [session("r1", -1440, { source: "local", taskId: "s1", seriesId: "s1" }), session("r2", -40, { source: "local", taskId: "s1", seriesId: "s1" })];
    const [j] = jobs({ tasks, sessions });
    expect(j!.next).toBe(next.toISOString());
    expect(jobSubtitle(j!, NOW)).toMatch(/^Daily at 9:00 AM · next (today|tomorrow) 9:00 AM$/);
    expect(jobRow(j!, NOW).when).toMatch(/^(Tomorrow )?9:00 AM$/);
  });

  it("a one-off due now; a retry", () => {
    const j = byKey({ tasks: [task("due"), task("retry", { retryAfter: at(30) })] });
    expect(jobRow(j.get("task:due")!, NOW).when).toBe("Due now");
    expect(jobSubtitle(j.get("task:due")!, NOW)).toBe("Due now");
    expect(jobRow(j.get("task:retry")!, NOW).when).toMatch(/^Retries \d/);
    expect(jobSubtitle(j.get("task:retry")!, NOW)).toMatch(/^Retries (today|tomorrow) /);
  });

  it("needs you: the reason under the title; recent: the site and how long ago; running: now", () => {
    const j = byKey({
      sessions: [session("n", -40, { outcome: "paused", reason: "Pick a seat" }), session("d", -125, { url: "https://mail.google.com/x" }), session("r", -1, { endedAt: undefined, outcome: undefined })],
      running: [session("r", -1, { endedAt: undefined, outcome: undefined })],
    });
    expect(jobRow(j.get("chat:n")!, NOW)).toMatchObject({ meta: "Pick a seat", when: "38 min ago" });
    expect(jobSubtitle(j.get("chat:n")!, NOW)).toBe("Needs you · Pick a seat");
    expect(jobRow(j.get("chat:d")!, NOW)).toMatchObject({ meta: "mail.google.com", when: "2 h ago", label: "Chat d, Done, 2 h ago, mail.google.com" });
    expect(jobSubtitle(j.get("chat:d")!, NOW)).toBe("Done · 2 h ago");
    expect(jobRow(j.get("chat:r")!, NOW).when).toBe("now");
    expect(jobSubtitle(j.get("chat:r")!, NOW)).toBe("Running");
  });
});

describe("chip hints", () => {
  it("explains every task chip", () => {
    for (const status of ["pending", "running", "done", "failed", "paused", "cancelled"] as const) {
      expect(chipHint(taskChip({ status, notBefore: null, retryAfter: null }).label)).not.toBe("");
    }
    expect(chipHint("retry")).not.toBe("");
    expect(chipHint("scheduled")).not.toBe("");
  });
});
