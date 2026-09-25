import { describe, expect, it, vi } from "vitest";
import { AccountApi } from "../../src/account/account-api.js";
import { AccountTodo, accountRow } from "../../src/account/todo-source.js";
import { fakeApi, task } from "./fake-api.js";

function setup() {
  const api = fakeApi();
  const onChange = vi.fn();
  const todo = new AccountTodo(new AccountApi({ apiBase: api.base, token: "bt_s_tok", fetch: api.fetch }), "Europe/Berlin", onChange);
  return { api, todo, onChange };
}

describe("AccountTodo (the signed-in TODO list)", () => {
  it("lists every page of the account's tasks in the TODO row shape", async () => {
    const t = setup();
    t.api.on("GET /v1/tasks", (c) =>
      c.path.includes("cursor=")
        ? { body: { tasks: [task("t3", { status: "done" })], nextCursor: null } }
        : { body: { tasks: [task("t1", { mediaIds: ["m1", "m2"], repeat: { dailyAt: ["09:00"] }, tz: "Europe/Berlin" }), task("t2")], nextCursor: "c2" } },
    );
    const rows = await t.todo.list();
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
    expect(rows[0]).toMatchObject({ repeat: { dailyAt: ["09:00"] }, media: [{ id: "m1", name: "file 1" }, { id: "m2", name: "file 2" }] });
    expect(rows[1]!.repeat).toBeNull();
    expect(t.api.calls.map((c) => c.path)).toEqual(["/v1/tasks?limit=200", "/v1/tasks?limit=200&cursor=c2"]);
    expect(t.api.calls[0]!.headers.authorization).toBe("Bearer bt_s_tok");
    // The background learns the next due time from the list.
    expect(t.onChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "t1" })]));
  });

  it("adds a task: uploads its files to /v1/media first, sends repeat with the browser's time zone", async () => {
    const t = setup();
    t.api.on("POST /v1/media", { status: 201, body: { id: "M1", filename: "a.png", contentType: "image/png", size: 3 } });
    t.api.on("POST /v1/tasks", (c) => ({ status: 201, body: task("n1", c.body as object) }));
    const created = await t.todo.add({
      instructions: "Post the weekly recap",
      account: " alpha ",
      notBefore: "2026-09-25T07:00:00.000Z",
      repeat: { dailyAt: ["09:00", "18:30"] },
      media: [{ name: "a.png", type: "image/png", dataBase64: "AQID" }],
    });
    expect(created).toMatchObject({ id: "n1", repeat: { dailyAt: ["09:00", "18:30"] } });
    expect(t.api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/media", "POST /v1/tasks"]);
    expect(t.api.calls[1]!.body).toEqual({
      instructions: "Post the weekly recap",
      account: "alpha",
      notBefore: "2026-09-25T07:00:00.000Z",
      mediaIds: ["M1"],
      repeat: { dailyAt: ["09:00", "18:30"] },
      tz: "Europe/Berlin",
    });
    expect(t.onChange).toHaveBeenCalledWith();
  });

  it("a task without repeat sends no tz", async () => {
    const t = setup();
    t.api.on("POST /v1/tasks", (c) => ({ status: 201, body: task("n2", c.body as object) }));
    await t.todo.add({ instructions: "once" });
    expect(t.api.calls[0]!.body).toEqual({ instructions: "once" });
  });

  it("update, retry, cancel and delete call the task routes", async () => {
    const t = setup();
    t.api.on("PATCH /v1/tasks/t1", (c) => ({ body: task("t1", c.body as object) }));
    t.api.on("POST /v1/tasks/t1/retry", { body: task("t1") });
    t.api.on("POST /v1/tasks/t1/cancel", { body: task("t1", { status: "cancelled" }) });
    t.api.on("DELETE /v1/tasks/t1", { status: 204 });
    await t.todo.update("t1", { repeat: { dailyAt: ["07:15"] }, account: null });
    await t.todo.update("t1", { repeat: null });
    await t.todo.retry("t1");
    expect((await t.todo.cancel("t1")).status).toBe("cancelled");
    expect(await t.todo.delete("t1")).toBe(true);
    expect(t.api.calls.map((c) => [`${c.method} ${c.path}`, c.body])).toEqual([
      ["PATCH /v1/tasks/t1", { account: null, repeat: { dailyAt: ["07:15"] }, tz: "Europe/Berlin" }],
      ["PATCH /v1/tasks/t1", { repeat: null }],
      ["POST /v1/tasks/t1/retry", undefined],
      ["POST /v1/tasks/t1/cancel", undefined],
      ["DELETE /v1/tasks/t1", undefined],
    ]);
  });

  it("server errors come through with the server's message", async () => {
    const t = setup();
    t.api.on("DELETE /v1/tasks/t9", { status: 409, body: { error: "task is running" } });
    await expect(t.todo.delete("t9")).rejects.toMatchObject({ status: 409, message: "task is running" });
  });

  it("accountRow keeps the cloud fields", () => {
    expect(accountRow(task("x", { status: "paused", pauseReason: "Out of usage credit" }))).toMatchObject({ status: "paused", pauseReason: "Out of usage credit", media: [] });
  });
});
