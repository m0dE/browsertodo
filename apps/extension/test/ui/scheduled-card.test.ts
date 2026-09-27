/** The chat's card for a task the agent scheduled (schedule_task): its line, View in TODO, Undo, and undone. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@browsertodo/shared";
import { scheduledView } from "../../src/sidepanel/event-format.js";
import { renderEvent, type ScheduledCardActions } from "../../src/sidepanel/event-render.js";
import { installMiniDom, type MiniElement } from "./mini-dom.js";

const EVENT = { type: "task_scheduled", taskId: "t9", instructions: "Check the order status\nat https://shop.example.com/orders/42", schedule: { at: "2026-09-26T22:45:00Z" } } satisfies AgentEvent;
/** Seen at 15:45 in New York, the same day. */
const SEEN = { now: new Date("2026-09-26T19:45:00Z"), timeZone: "America/New_York", hour12: true };
const card = (undone: boolean, actions?: ScheduledCardActions) => renderEvent(scheduledView(EVENT, undone, SEEN), undefined, actions) as unknown as MiniElement;
const byClass = (el: MiniElement, c: string) => el.all().find((e) => e.classList.contains(c));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("scheduled card", () => {
  beforeAll(installMiniDom);

  it("one line: Scheduled, the task's first line, its schedule; the whole task in the tooltip", () => {
    const el = card(false, { view: vi.fn(), undo: vi.fn(async () => {}) });
    expect(el.classList.contains("ev-scheduled")).toBe(true);
    expect(el.getAttribute("data-task-id")).toBe("t9");
    expect(byClass(el, "sched-line")!.textContent).toBe("Scheduled:Check the order status· Once, today at 6:45 PM");
    expect(byClass(el, "sched-line")!.title).toContain("https://shop.example.com/orders/42");
    expect(el.all("button").map((b) => b.textContent)).toEqual(["View in TODO", "Undo"]);
  });

  it("View in TODO and Undo name the task", async () => {
    const actions = { view: vi.fn(), undo: vi.fn(async () => {}) };
    const el = card(false, actions);
    byClass(el, "sched-view")!.click();
    expect(actions.view).toHaveBeenCalledWith("t9");
    byClass(el, "sched-undo")!.click();
    await settle();
    expect(actions.undo).toHaveBeenCalledWith("t9");
  });

  it("a failed undo says why under the line and keeps Undo", async () => {
    const el = card(false, { view: vi.fn(), undo: vi.fn(async () => Promise.reject(new Error("the task is running"))) });
    byClass(el, "sched-undo")!.click();
    await settle();
    const note = byClass(el, "sched-note")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Couldn't undo: the task is running");
    expect(byClass(el, "sched-undo")).toBeDefined();
  });

  it("undone: says so, no buttons", () => {
    const el = card(true, { view: vi.fn(), undo: vi.fn(async () => {}) });
    expect(el.classList.contains("undone")).toBe(true);
    expect(byClass(el, "sched-label")!.textContent).toBe("Undone:");
    expect(el.all("button")).toEqual([]);
    expect(el.textContent).toContain("Removed from your TODO list.");
  });
});
