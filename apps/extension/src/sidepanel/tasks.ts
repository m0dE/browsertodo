/**
 * TODO tab: the task list and the add/edit form ("Do this now" lives in the
 * composer). The list lives in the user's account and is a paid feature:
 * signed out, the tab is one big Log in button; on a plan without it, one
 * Get a plan button (with how many tasks the account keeps for later).
 * After the first sign-in with tasks saved in this browser, it offers to
 * move them into the account; after signing in to another account than this
 * computer's memory was synced with, it asks whether to add that memory
 * (memory-ask.ts).
 *
 * Each row: the task (two lines), when it runs in words, and its state; Run
 * starts it now (Stop while it runs); "⋯" holds Edit, Details, Delete and
 * the rest. "Run due (N)" starts the tasks whose time has come.
 */
import {
  chipHint,
  keptTasksText,
  localTimeZone,
  plural,
  readStoredRepeat,
  repeatLabel,
  splitTasks,
  taskChip,
  TODO_LOCKED,
  taskNextTime,
  whenText,
  type LocalTask,
  type SessionInfo,
} from "@browsertodo/shared";
import { createScheduleFields } from "@browsertodo/shared/schedule-fields";
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { todoAllowed } from "../account/types.js";
import { initMemoryAsk } from "./memory-ask.js";
import { uiRequest, type AccountView, type LocalMediaInfo, type UiState } from "../ui-protocol.js";
import { $, busy, flash, h, restartAnimation, showError } from "../ui/dom.js";
import { signIn, SIGNED_OUT } from "../ui/sign-in.js";
import { runsOfTask } from "./details-sheet.js";
import { filePicker, filesToUploads } from "./files.js";
import { accountLabel, firstLine, runDueButton, todoGate, type TodoGate } from "./format.js";
import { shortUrl } from "../text.js";
import { runControl, taskActions, TRUST, type TaskAction } from "./task-actions.js";

/** The Finished list shows this many, newest first. */
const FINISHED_SHOWN = 50;

type Row = LocalTask & { media: LocalMediaInfo[] };

export interface TasksView {
  refresh(): Promise<void>;
  /** Re-render relative times without refetching. */
  tick(): void;
  /** Settings for Run due's tooltip (check interval, cloud sync), the account (signed in or not) and the runs going on. */
  setState(state: UiState): void;
  /** True when the tab is one call to action only (Log in; Get a plan), with no composer below it. */
  callToActionOnly(): boolean;
  /** Google sign-in, as the tab's Log in button does it (progress shows under that button). */
  signIn(): void;
  /** "Open in TODO": reload, then scroll to this task and focus it. False when the list does not have it. */
  reveal(id: string): Promise<boolean>;
}

export function initTasks(opts: {
  onStarted: () => void;
  onContinued?: (sessionId: string) => void;
  /** The browser tab the panel shows: a continued run goes on there. */
  tabId?: () => number | null;
  /** Sign-in and the move of local tasks return a fresh state. */
  onState?: (state: UiState) => void;
  /** A task's title was picked: show its details. */
  onDetails?: (task: Row, source: "local" | "account", trigger: HTMLElement) => void;
  /** Get a plan: the dashboard's Billing page. */
  openBilling?: () => void;
  /** The tab switched between its list and a call to action (the composer shows only with the list). */
  onGateChange?: () => void;
}): TasksView {
  let tasks: Row[] = [];
  let loaded = false;
  let settings: UiState["settings"] | null = null;
  let account: AccountView | null = null;
  /** The runs going on now (a row's Stop). */
  let running: readonly SessionInfo[] = [];
  /** Where the loaded list came from. */
  let source: "local" | "account" = "local";
  /** The last list said the account's plan does not include the TODO list; null: no list for this account yet. */
  let listLocked: boolean | null = null;
  let gate: TodoGate = "loading";
  const tab = $("tab-todo");
  const tasksMsg = $("tasks-msg");
  const titleOf = (id: string) => tab.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);

  // Signed out: the Log in button.
  const loginBtn = $<HTMLButtonElement>("login-btn");
  const loginMsg = $("login-msg");
  const startSignIn = () =>
    signIn(loginBtn, loginMsg, account, async (state) => {
      opts.onState?.(state);
      await refresh();
    });
  loginBtn.addEventListener("click", startSignIn);

  // First sign-in with tasks in this browser: move them into the account.
  const migrate = $("migrate");
  const migrateGo = $<HTMLButtonElement>("migrate-go");
  const migrateMsg = $("migrate-msg");
  migrateGo.addEventListener("click", () =>
    void busy(
      migrateGo,
      async () => {
        flash(migrateMsg, "Moving…");
        const r = await uiRequest({ type: "account.migrate" });
        if (r.failed) flash(migrateMsg, `Moved ${r.moved}; ${r.failed} could not be moved: ${r.errors[0] ?? ""}`, "bad");
        else {
          flash(migrateMsg, "");
          flash(tasksMsg, `Moved ${plural(r.moved, "task")} to your account.`, "ok");
        }
        opts.onState?.(r.state);
        await refresh();
      },
      migrateMsg,
    ),
  );
  $("migrate-later").addEventListener("click", () =>
    void uiRequest({ type: "account.dismissMigration" })
      .then((state) => opts.onState?.(state))
      .catch((err: unknown) => showError(migrateMsg, err)),
  );

  // A plan without the TODO list: the way to get one.
  $("todo-locked-title").textContent = TODO_LOCKED.title;
  $("todo-locked-why").textContent = TODO_LOCKED.why;
  const planBtn = $("todo-plan-btn");
  planBtn.textContent = TODO_LOCKED.action;
  planBtn.addEventListener("click", () => opts.openBilling?.());

  const renderAccount = () => {
    const signedIn = !!account?.signedIn;
    const next = todoGate(account, source === "account" ? listLocked : null);
    tab.dataset.auth = next;
    const kept = $("todo-kept");
    kept.textContent = next === "locked" && loaded && source === "account" ? keptTasksText(tasks.length) : "";
    kept.hidden = !kept.textContent;
    if (next !== gate) {
      gate = next;
      opts.onGateChange?.();
    }
    loginBtn.title = account && !account.signInConfigured ? SIGN_IN_NOT_SET_UP : "Sign in with Google";
    const n = signedIn ? (account?.localTasks ?? 0) : 0;
    migrate.hidden = n === 0;
    if (n) {
      const one = n === 1;
      $("migrate-text").textContent = `You have ${plural(n, "task")} saved in this browser. Move ${one ? "it" : "them"} to your account so ${one ? "it runs" : "they run"} from there?`;
      migrateGo.textContent = `Move ${plural(n, "task")} to your account`;
    }
  };

  const memoryAsk = initMemoryAsk({ onState: (s) => opts.onState?.(s), onAnswered: (text) => flash(tasksMsg, text, "ok") });

  // Add / edit form: the task, when it runs (the shared schedule fields), files.
  const addForm = $<HTMLFormElement>("add-form");
  const addToggle = $<HTMLButtonElement>("add-toggle");
  const addMsg = $("add-msg");
  const addText = $<HTMLTextAreaElement>("add-text");
  const addSubmit = $<HTMLButtonElement>("add-submit");
  const addAttach = $<HTMLButtonElement>("add-attach");
  const addKept = $("add-kept");
  const addFiles = filePicker($<HTMLInputElement>("add-files"), $("add-files-list"));
  const schedule = createScheduleFields({ id: "add-sched" });
  $("add-schedule").replaceWith(schedule.element);
  addAttach.addEventListener("click", () => $<HTMLInputElement>("add-files").click());
  /** The task being edited; null: a new one. */
  let editing: Row | null = null;

  function setAddOpen(open: boolean, task: Row | null = null): void {
    editing = open ? task : null;
    addForm.hidden = !open;
    addToggle.setAttribute("aria-expanded", String(open));
    addToggle.hidden = open;
    $("add-title").textContent = task ? "Edit task" : "New task";
    addSubmit.textContent = task ? "Save" : "Add";
    // A saved task keeps its files; new ones go with a new task.
    addAttach.hidden = !!task;
    addKept.textContent = task?.media.length ? `${plural(task.media.length, "file")} attached` : "";
    addKept.hidden = !addKept.textContent;
    flash(addMsg, "");
    if (!open) {
      addForm.reset();
      addFiles.clear();
      schedule.set(null);
      return;
    }
    addText.value = task?.instructions ?? "";
    schedule.set(task ? { at: task.notBefore, repeat: task.repeat } : null);
    addForm.scrollIntoView({ block: "nearest" });
    addText.focus();
  }
  const closeForm = () => {
    const back = editing;
    setAddOpen(false);
    (back ? titleOf(back.id) : addToggle)?.focus();
  };
  addToggle.addEventListener("click", () => setAddOpen(true));
  // What was wrong is fixed as the user types: the old message goes.
  addForm.addEventListener("input", () => flash(addMsg, ""));
  $("add-cancel").addEventListener("click", closeForm);
  addForm.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      closeForm();
    }
  });
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(
      addSubmit,
      async () => {
        const instructions = addText.value.trim();
        if (!instructions) {
          addText.focus();
          return flash(addMsg, "Write what the agent should do.", "bad");
        }
        const when = schedule.read();
        if (!when.ok) {
          when.focus.focus();
          return flash(addMsg, when.error, "bad");
        }
        const { at, repeat } = when.value;
        const saved = editing;
        if (saved) {
          await uiRequest({ type: "tasks.update", id: saved.id, patch: { instructions, notBefore: at, repeat } });
        } else {
          const media = await filesToUploads(addFiles.files());
          await uiRequest({
            type: "tasks.add",
            instructions,
            ...(at ? { notBefore: at } : {}),
            ...(repeat ? { repeat } : {}),
            ...(media.length ? { media } : {}),
          });
        }
        setAddOpen(false);
        await refresh();
        (saved ? titleOf(saved.id) : addToggle)?.focus();
      },
      addMsg,
    );
  });

  // Run due (N): the tasks whose time has come, without waiting for the next check.
  const runNow = $<HTMLButtonElement>("run-now");
  const renderRunNow = () => {
    const b = runDueButton(loaded ? tasks : [], settings, Date.now(), source === "account");
    runNow.hidden = !loaded || b.hidden;
    runNow.textContent = b.label;
    runNow.title = b.title;
  };
  runNow.addEventListener("click", () => {
    void busy(
      runNow,
      async () => {
        const res = await uiRequest({ type: "run.due" });
        if (res.started) opts.onStarted();
        else flash(tasksMsg, res.detail || "Nothing is due right now.", "");
      },
      tasksMsg,
    );
  });

  async function act(req: { type: "tasks.retry" | "tasks.delete" | "tasks.cancel"; id: string } | { type: "run.stop"; sessionId: string }): Promise<void> {
    try {
      await uiRequest(req);
      await refresh();
    } catch (err) {
      showError(tasksMsg, err);
    }
  }

  /** Trust on a task the agent wrote: its instructions become the user's word (Task.agentAuthored). */
  async function trust(t: Row): Promise<void> {
    try {
      await uiRequest({ type: "tasks.update", id: t.id, patch: { agentAuthored: false } });
      await refresh();
    } catch (err) {
      showError(tasksMsg, err);
    }
  }

  /** Run on a row: that task now; its run shows in Chat. */
  function runTask(t: Row, button: HTMLButtonElement): void {
    void busy(
      button,
      async () => {
        const { sessionId } = await uiRequest({ type: "tasks.run", id: t.id });
        if (opts.onContinued) opts.onContinued(sessionId);
        else opts.onStarted();
        await refresh();
      },
      tasksMsg,
    );
  }

  /** Continues a paused or failed task from its latest run. */
  async function continueTask(t: Row): Promise<void> {
    try {
      const last = (await runsOfTask(t.id)).find((s) => s.source === "local" && s.endedAt);
      if (!last) return flash(tasksMsg, "No earlier run of this task to continue. Use Run again.", "bad");
      const tabId = opts.tabId?.() ?? null;
      const { sessionId } = await uiRequest({ type: "run.continue", sessionId: last.sessionId, ...(tabId === null ? {} : { tabId }) });
      if (opts.onContinued) opts.onContinued(sessionId);
      else opts.onStarted();
    } catch (err) {
      showError(tasksMsg, err);
    }
  }

  function actionButton(t: Row, a: TaskAction): HTMLButtonElement {
    const run = (e: Event) => {
      (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
      if (a.run === "continue") void continueTask(t);
      else if (a.run === "edit") setAddOpen(true, t);
      else if (a.run === "details") opts.onDetails?.(t, source, titleOf(t.id) ?? tab);
      else if (a.run === "trust") void trust(t);
      else void act({ type: a.run, id: t.id });
    };
    return h(a.danger ? "button.bad" : "button", { type: "button", title: a.title ?? null, onclick: run }, a.label);
  }

  /** The row's Run / Stop button. */
  function runButton(t: Row): HTMLButtonElement | null {
    const c = runControl(t, running);
    if (!c) return null;
    const what = firstLine(t.instructions, 60);
    if (c.kind === "stop") {
      return h("button.small.run-btn.stop", { type: "button", title: c.title, "aria-label": `Stop: ${what}`, onclick: () => void act({ type: "run.stop", sessionId: c.sessionId }) }, "Stop");
    }
    const b = h("button.small.run-btn", { type: "button", title: c.title, "aria-label": `Run now: ${what}`, "aria-disabled": c.disabled ? "true" : null }, "Run");
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") !== "true") runTask(t, b);
    });
    return b;
  }

  /** When it runs, in words: "Due now", "Once · Today 3:00 PM", "Daily at 9:00 AM · Next Tomorrow 9:00 AM". */
  function whenLine(t: Row, now: number): { text: string; due: boolean } {
    const rule = repeatLabel(t.repeat);
    if (t.status !== "pending") return { text: rule || "Once", due: false };
    const next = taskNextTime(t);
    if (!next || Date.parse(next) <= now) return { text: rule ? `Due now · ${rule}` : "Due now", due: true };
    const at = whenText(next, now);
    if (t.retryAfter === next) return { text: `${rule || "Once"} · Retries ${at}`, due: false };
    return { text: rule ? `${rule} · Next ${at}` : `Once · ${at}`, due: false };
  }

  function row(t: Row, now: number): HTMLLIElement {
    const chip = taskChip(t, now);
    const when = whenLine(t, now);
    const meta: HTMLElement[] = [];
    // A waiting task says it with its time; any other state gets its chip.
    if (t.status !== "pending" || chip.label === "retry") {
      meta.push(h("span.chip", { "data-tone": chip.tone, title: chipHint(chip.label) || null }, chip.label));
    }
    const ruleTitle = t.repeat ? `Repeats ${repeatLabel(t.repeat).replace(/^./, (c) => c.toLowerCase())} (${t.repeat.tz})` : "Runs once";
    meta.push(h(when.due ? "span.when.due" : "span.when", { title: ruleTitle }, when.text));
    if (t.agentAuthored && (t.status === "pending" || t.status === "paused")) {
      meta.push(h("span.chip", { "data-tone": "warn", title: `${TRUST.title}. Until then, posting, sending, paying or deleting waits for your OK.` }, "By the agent"));
    }
    const account = accountLabel(t.account);
    if (account) meta.push(h("span", { title: "The account the agent uses for this task" }, account));
    if (t.media.length) meta.push(h("span", { title: t.media.map((m) => m.name).join(", ") }, plural(t.media.length, "file")));

    // The last result: its link and summary when done, the reason when it stopped.
    const reason = t.status === "failed" ? t.failReason : t.status === "paused" ? t.pauseReason : null;
    let last: HTMLElement | null = null;
    if (reason) last = h("div.task-reason", { title: reason, "data-tone": t.status === "failed" ? "bad" : "warn" }, reason);
    else if (t.status === "done" && (t.resultUrl || t.resultSummary)) {
      last = h(
        "div.task-result",
        { title: t.resultSummary ?? t.resultUrl },
        t.resultUrl ? h("a", { href: t.resultUrl, target: "_blank", rel: "noopener" }, shortUrl(t.resultUrl)) : null,
        t.resultSummary ? h("span", null, t.resultSummary) : null,
      );
    }

    const items = taskActions(t, source).map((a) => actionButton(t, a));
    return h(
      "li.task",
      { "data-status": t.status },
      h(
        "div.task-main",
        null,
        h(
          "button.task-title.title-btn",
          {
            type: "button",
            "aria-haspopup": "dialog",
            "data-task-id": t.id,
            title: `${t.instructions}\n\nShow the full task and its details`,
            onclick: (e: Event) => opts.onDetails?.(t, source, e.currentTarget as HTMLElement),
          },
          t.instructions.trim() || "(no instructions)",
        ),
        h("div.task-meta", null, ...meta),
        last,
      ),
      h(
        "div.task-actions",
        null,
        runButton(t),
        h("details.menu", null, h("summary", { "aria-label": "More actions", title: "More" }, "⋯"), h("div.menu-pop", null, ...items)),
      ),
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
    $("finished-list").replaceChildren(...finished.slice(0, FINISHED_SHOWN).map((t) => row(t, now)));
    renderRunNow();
  }

  async function refresh(): Promise<void> {
    try {
      const res = await uiRequest({ type: "tasks.list" });
      // A rule stored before rules became cron ({ dailyAt }) reads as the same rule, in rows, the form and details.
      tasks = res.tasks.map((t) => ({ ...t, repeat: readStoredRepeat(t.repeat, localTimeZone()) }));
      source = res.source ?? "local";
      listLocked = res.locked;
      loaded = true;
      renderAccount();
      render();
    } catch (err) {
      showError(tasksMsg, err);
    }
  }

  async function reveal(id: string): Promise<boolean> {
    await refresh();
    const btn = titleOf(id);
    if (!btn) return false;
    const fin = $<HTMLDetailsElement>("finished");
    if (fin.contains(btn)) fin.open = true;
    const li = btn.closest("li")!;
    li.scrollIntoView({ block: "nearest" });
    btn.focus();
    restartAnimation(li, "found");
    return true;
  }

  renderRunNow();
  return {
    refresh,
    reveal,
    tick: () => {
      // An open menu or a focused control is not pulled out from under the user.
      if (tab.querySelector("details.menu[open]") || tab.querySelector(".task-actions :focus")) return;
      render();
    },
    setState(state) {
      memoryAsk.render(state);
      settings = state.settings;
      const before = running.map((r) => `${r.sessionId}:${r.taskId}`).join();
      running = state.runningSessions ?? [];
      const runsChanged = before !== running.map((r) => `${r.sessionId}:${r.taskId}`).join();
      const was = account;
      const now = state.account ?? SIGNED_OUT;
      account = now;
      // Signed in or out: the list comes from somewhere else. Another plan: it is (un)locked now.
      const otherAccount = !!was && (was.signedIn !== now.signedIn || was.user?.email !== now.user?.email);
      const otherPlan = !!was && todoAllowed(was.plan) !== todoAllowed(now.plan);
      if (otherAccount || otherPlan) listLocked = null;
      renderAccount();
      renderRunNow();
      if (otherAccount || otherPlan) void refresh();
      // A run started or ended: its row's Run / Stop and state change.
      else if (runsChanged && loaded) void refresh();
    },
    callToActionOnly: () => gate === "out" || gate === "locked",
    signIn: startSignIn,
  };
}
