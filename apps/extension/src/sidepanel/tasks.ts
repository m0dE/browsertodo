/** Tasks tab: the todo list and the add form ("Do this now" lives in the composer). */
import type { LocalTask } from "@browsertodo/shared";
import { uiRequest, type LocalMediaInfo } from "../ui-protocol.js";
import { $, busy, errorText, flash, h } from "./dom.js";
import { filePicker, filesToUploads } from "./files.js";
import {
  accountLabel,
  clockLabel,
  firstLine,
  localInputToIso,
  parseRepeatTimes,
  repeatLabel,
  splitTasks,
  taskChip,
  taskNextTime,
} from "./format.js";
import { shortUrl } from "./event-format.js";

type Row = LocalTask & { media: LocalMediaInfo[] };

export interface TasksView {
  refresh(): Promise<void>;
  /** Re-render relative times without refetching. */
  tick(): void;
}

export function initTasks(opts: { onStarted: () => void; onContinued?: (sessionId: string) => void }): TasksView {
  let tasks: Row[] = [];

  // Add form
  const addForm = $<HTMLFormElement>("add-form");
  const addToggle = $<HTMLButtonElement>("add-toggle");
  const addMsg = $("add-msg");
  const addFiles = filePicker($<HTMLInputElement>("add-files"), $("add-files-list"));
  const setAddOpen = (open: boolean) => {
    addForm.hidden = !open;
    addToggle.setAttribute("aria-expanded", String(open));
    addToggle.hidden = open;
    if (open) $("add-text").focus();
  };
  addToggle.addEventListener("click", () => setAddOpen(true));
  $("add-cancel").addEventListener("click", () => {
    addForm.reset();
    addFiles.clear();
    flash(addMsg, "");
    setAddOpen(false);
  });
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const submit = addForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    void busy(submit, async () => {
      const instructions = $<HTMLTextAreaElement>("add-text").value.trim();
      const account = $<HTMLInputElement>("add-account").value.trim();
      const timeValue = $<HTMLInputElement>("add-time").value;
      const notBefore = localInputToIso(timeValue);
      const repeat = parseRepeatTimes($<HTMLInputElement>("add-repeat").value);
      if (!instructions) return flash(addMsg, "Write what the agent should do.", "bad");
      if (timeValue && !notBefore) return flash(addMsg, "That time is not valid.", "bad");
      if (!repeat.ok) return flash(addMsg, repeat.error, "bad");
      try {
        const media = await filesToUploads(addFiles.files());
        await uiRequest({
          type: "tasks.add",
          instructions,
          ...(account ? { account } : {}),
          ...(notBefore ? { notBefore } : {}),
          ...(repeat.times.length ? { repeat: { dailyAt: repeat.times } } : {}),
          ...(media.length ? { media } : {}),
        });
        addForm.reset();
        addFiles.clear();
        flash(addMsg, "");
        setAddOpen(false);
        await refresh();
      } catch (err) {
        flash(addMsg, errorText(err), "bad");
      }
    });
  });

  // Run due
  const tasksMsg = $("tasks-msg");
  const runDue = $<HTMLButtonElement>("run-due");
  runDue.addEventListener("click", () =>
    void busy(runDue, async () => {
      try {
        const res = await uiRequest({ type: "run.due" });
        if (res.started) opts.onStarted();
        else flash(tasksMsg, res.detail || "Nothing is due right now.", "");
      } catch (err) {
        flash(tasksMsg, errorText(err), "bad");
      }
    }),
  );

  // Close open overflow menus on outside click.
  document.addEventListener("click", (e) => {
    for (const m of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
      if (!m.contains(e.target as Node)) m.open = false;
    }
  });

  async function act(req: { type: "tasks.retry" | "tasks.delete"; id: string }): Promise<void> {
    try {
      await uiRequest(req);
      await refresh();
    } catch (err) {
      flash(tasksMsg, errorText(err), "bad");
    }
  }

  /** Continues a paused or failed task from its latest run. */
  async function continueTask(t: Row): Promise<void> {
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: 200 });
      const last = sessions.find((s) => s.taskId === t.id && s.source === "local" && s.endedAt);
      if (!last) return flash(tasksMsg, "No earlier run of this task to continue. Use Run again.", "bad");
      const { sessionId } = await uiRequest({ type: "run.continue", sessionId: last.sessionId });
      if (opts.onContinued) opts.onContinued(sessionId);
      else opts.onStarted();
    } catch (err) {
      flash(tasksMsg, errorText(err), "bad");
    }
  }

  function row(t: Row, now: number): HTMLLIElement {
    const chip = taskChip(t, now);
    const meta: (HTMLElement | string)[] = [];
    const account = accountLabel(t.account);
    if (account) meta.push(account);
    const next = taskNextTime(t);
    if (next && Date.parse(next) > now) meta.push(clockLabel(next, now));
    const rep = repeatLabel(t.repeat);
    if (rep) meta.push(rep);
    if (t.media.length) meta.push(t.media.length === 1 ? "1 file" : `${t.media.length} files`);
    if (t.status === "done" && t.resultUrl) {
      meta.push(h("a", { href: t.resultUrl, target: "_blank", rel: "noopener", title: t.resultUrl }, shortUrl(t.resultUrl)));
    } else if (t.status !== "pending" && t.status !== "running" && !t.resultUrl) {
      meta.push(clockLabel(t.updatedAt, now));
    }
    const reason = t.status === "failed" ? t.failReason : t.status === "paused" ? t.pauseReason : null;

    const items: HTMLButtonElement[] = [];
    if ((t.status === "paused" || t.status === "failed") && t.attempts > 0) {
      items.push(h("button", { type: "button", title: "Pick up where the last run stopped", onclick: () => void continueTask(t) }, "Continue"));
    }
    if (t.status !== "running" && t.status !== "pending") {
      items.push(h("button", { type: "button", onclick: () => void act({ type: "tasks.retry", id: t.id }) }, "Run again"));
    }
    items.push(h("button.bad", { type: "button", onclick: () => void act({ type: "tasks.delete", id: t.id }) }, "Delete"));

    return h(
      "li.task",
      null,
      h("span.chip", { "data-tone": chip.tone }, chip.label),
      h(
        "div.task-main",
        null,
        h("div.task-title", { title: t.instructions }, firstLine(t.instructions) || "(no instructions)"),
        meta.length ? h("div.task-meta", null, ...meta.map((m) => (typeof m === "string" ? h("span", null, m) : m))) : null,
        reason ? h("div.task-reason", { title: reason }, reason) : null,
      ),
      h("details.menu", null, h("summary", { "aria-label": "More actions", title: "More" }, "⋯"), h("div.menu-pop", null, ...items)),
    );
  }

  function render(): void {
    const now = Date.now();
    const { active, finished } = splitTasks(tasks);
    $("task-list").replaceChildren(...active.map((t) => row(t, now)));
    $("tasks-empty").hidden = active.length > 0;
    $("todo-count").textContent = active.length ? String(active.length) : "";
    const fin = $<HTMLDetailsElement>("finished");
    fin.hidden = finished.length === 0;
    $("finished-count").textContent = String(finished.length);
    $("finished-list").replaceChildren(...finished.slice(0, 50).map((t) => row(t, now)));
  }

  async function refresh(): Promise<void> {
    try {
      tasks = (await uiRequest({ type: "tasks.list" })).tasks;
      render();
    } catch (err) {
      flash(tasksMsg, errorText(err), "bad");
    }
  }

  return { refresh, tick: render };
}
