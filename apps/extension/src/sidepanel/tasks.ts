/**
 * TODO tab: the task list and the add form ("Do this now" lives in the
 * composer). The list lives in the user's account: signed out, the tab is
 * one big Log In button. After the first sign-in with tasks saved in this
 * browser, it offers to move them into the account.
 */
import type { LocalTask } from "@browsertodo/shared";
import { SIGN_IN_NOT_SET_UP } from "../account/google-auth.js";
import { uiRequest, type AccountView, type LocalMediaInfo, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash, h } from "./dom.js";
import { filePicker, filesToUploads } from "./files.js";
import {
  accountLabel,
  chipHint,
  clockLabel,
  firstLine,
  localInputToIso,
  parseRepeatTimes,
  repeatLabel,
  runNowButton,
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
  /** Settings for Run now's tooltip (check interval, cloud sync) and the account (signed in or not). */
  setState(state: UiState): void;
  /** True when the tab is the Log In button only (no composer below it). */
  signedOut(): boolean;
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
}): TasksView {
  let tasks: Row[] = [];
  let loaded = false;
  let settings: UiState["settings"] | null = null;
  let account: AccountView | null = null;
  /** Where the loaded list came from. */
  let source: "local" | "account" = "local";
  const tab = $("tab-todo");
  const tasksMsg = $("tasks-msg");

  // Signed out: the Log In button.
  const loginBtn = $<HTMLButtonElement>("login-btn");
  const loginMsg = $("login-msg");
  loginBtn.addEventListener("click", () => {
    if (account && !account.signInConfigured) return flash(loginMsg, SIGN_IN_NOT_SET_UP, "bad");
    void busy(loginBtn, async () => {
      flash(loginMsg, "Continue in the Google window…");
      try {
        const state = await uiRequest({ type: "account.signIn" });
        flash(loginMsg, "");
        opts.onState?.(state);
        await refresh();
      } catch (err) {
        flash(loginMsg, errorText(err), "bad");
      }
    });
  });

  // First sign-in with tasks in this browser: move them into the account.
  const migrate = $("migrate");
  const migrateGo = $<HTMLButtonElement>("migrate-go");
  const migrateMsg = $("migrate-msg");
  migrateGo.addEventListener("click", () =>
    void busy(migrateGo, async () => {
      flash(migrateMsg, "Moving…");
      try {
        const r = await uiRequest({ type: "account.migrate" });
        if (r.failed) flash(migrateMsg, `Moved ${r.moved}; ${r.failed} could not be moved: ${r.errors[0] ?? ""}`, "bad");
        else {
          flash(migrateMsg, "");
          flash(tasksMsg, `Moved ${r.moved} ${r.moved === 1 ? "task" : "tasks"} to your account.`, "ok");
        }
        opts.onState?.(r.state);
        await refresh();
      } catch (err) {
        flash(migrateMsg, errorText(err), "bad");
      }
    }),
  );
  $("migrate-later").addEventListener("click", () =>
    void uiRequest({ type: "account.dismissMigration" })
      .then((state) => opts.onState?.(state))
      .catch((err: unknown) => flash(migrateMsg, errorText(err), "bad")),
  );

  const renderAccount = () => {
    const signedIn = !!account?.signedIn;
    tab.dataset.auth = account ? (signedIn ? "in" : "out") : "loading";
    loginBtn.title = account && !account.signInConfigured ? SIGN_IN_NOT_SET_UP : "Sign in with Google";
    const n = signedIn ? (account?.localTasks ?? 0) : 0;
    migrate.hidden = n === 0;
    if (n) {
      const one = n === 1;
      $("migrate-text").textContent = `You have ${n} ${one ? "task" : "tasks"} saved in this browser. Move ${one ? "it" : "them"} to your account so ${one ? "it runs" : "they run"} from there?`;
      migrateGo.textContent = `Move ${n} ${one ? "task" : "tasks"} to your account`;
    }
  };

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

  // Run now: the tasks whose time has come, without waiting for the next check.
  const runNow = $<HTMLButtonElement>("run-now");
  const renderRunNow = () => {
    // Until the list arrives nothing is known to be due: say what the button does.
    const acct = source === "account";
    const b = loaded ? runNowButton(tasks, settings, Date.now(), acct) : runNowButton([{ status: "pending", notBefore: null, retryAfter: null }], settings, Date.now(), acct);
    // aria-disabled, not disabled: the tooltip saying why still shows.
    runNow.setAttribute("aria-disabled", String(b.disabled));
    runNow.title = b.title;
  };
  runNow.addEventListener("click", () => {
    if (runNow.getAttribute("aria-disabled") === "true") return;
    void busy(runNow, async () => {
      try {
        const res = await uiRequest({ type: "run.due" });
        if (res.started) opts.onStarted();
        else flash(tasksMsg, res.detail || "Nothing is due right now.", "");
      } catch (err) {
        flash(tasksMsg, errorText(err), "bad");
      }
    });
  });

  // Close open overflow menus on outside click.
  document.addEventListener("click", (e) => {
    for (const m of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
      if (!m.contains(e.target as Node)) m.open = false;
    }
  });

  async function act(req: { type: "tasks.retry" | "tasks.delete" | "tasks.cancel"; id: string }): Promise<void> {
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
      const tabId = opts.tabId?.() ?? null;
      const { sessionId } = await uiRequest({ type: "run.continue", sessionId: last.sessionId, ...(tabId === null ? {} : { tabId }) });
      if (opts.onContinued) opts.onContinued(sessionId);
      else opts.onStarted();
    } catch (err) {
      flash(tasksMsg, errorText(err), "bad");
    }
  }

  function row(t: Row, now: number): HTMLLIElement {
    const chip = taskChip(t, now);
    const meta: HTMLElement[] = [];
    const span = (text: string, title: string) => h("span", { title }, text);
    const account = accountLabel(t.account);
    if (account) meta.push(span(account, "The account the agent uses for this task"));
    const next = taskNextTime(t);
    if (next && Date.parse(next) > now) {
      const retrying = !!t.retryAfter && Date.parse(t.retryAfter) > now && next === t.retryAfter;
      meta.push(span(clockLabel(next, now), retrying ? "When it is tried again" : "It waits until this time"));
    }
    const rep = repeatLabel(t.repeat);
    if (rep) meta.push(span(rep, "Runs again every day at these times"));
    if (t.media.length) meta.push(span(t.media.length === 1 ? "1 file" : `${t.media.length} files`, t.media.map((m) => m.name).join(", ")));
    if (t.status === "done" && t.resultUrl) {
      meta.push(h("a", { href: t.resultUrl, target: "_blank", rel: "noopener", title: t.resultUrl }, shortUrl(t.resultUrl)));
    } else if (t.status !== "pending" && t.status !== "running" && !t.resultUrl) {
      meta.push(span(clockLabel(t.updatedAt, now), "Last changed"));
    }
    const reason = t.status === "failed" ? t.failReason : t.status === "paused" ? t.pauseReason : null;

    const items: HTMLButtonElement[] = [];
    if (source === "account") {
      // The account's queue: retry failed tasks, continue paused ones (e.g. after a top-up), cancel waiting ones.
      // Runs go on from the queue, not the panel.
      if (t.status === "failed") {
        items.push(h("button", { type: "button", title: "Put it back in the queue to run again", onclick: () => void act({ type: "tasks.retry", id: t.id }) }, "Retry"));
      }
      if (t.status === "paused") {
        items.push(h("button", { type: "button", title: "Run it again now instead of waiting", onclick: () => void act({ type: "tasks.retry", id: t.id }) }, "Continue"));
      }
      if (t.status === "pending" || t.status === "paused") {
        items.push(h("button", { type: "button", title: "It will not run; it moves to Finished", onclick: () => void act({ type: "tasks.cancel", id: t.id }) }, "Cancel"));
      }
      if (t.status !== "running") items.push(h("button.bad", { type: "button", onclick: () => void act({ type: "tasks.delete", id: t.id }) }, "Delete"));
    } else {
      if ((t.status === "paused" || t.status === "failed") && t.attempts > 0) {
        items.push(h("button", { type: "button", title: "Pick up where the last run stopped", onclick: () => void continueTask(t) }, "Continue"));
      }
      if (t.status !== "running" && t.status !== "pending") {
        items.push(h("button", { type: "button", title: "Put it back in the list to run again from the start", onclick: () => void act({ type: "tasks.retry", id: t.id }) }, "Run again"));
      }
      items.push(h("button.bad", { type: "button", onclick: () => void act({ type: "tasks.delete", id: t.id }) }, "Delete"));
    }

    return h(
      "li.task",
      null,
      h("span.chip", { "data-tone": chip.tone, title: chipHint(chip.label) || null }, chip.label),
      h(
        "div.task-main",
        null,
        h(
          "button.task-title.title-btn",
          {
            type: "button",
            "aria-haspopup": "dialog",
            "data-task-id": t.id,
            title: `${t.instructions}

Show the full task and its details`,
            onclick: (e: Event) => opts.onDetails?.(t, source, e.currentTarget as HTMLElement),
          },
          firstLine(t.instructions) || "(no instructions)",
        ),
        meta.length ? h("div.task-meta", null, ...meta) : null,
        reason ? h("div.task-reason", { title: reason }, reason) : null,
      ),
      items.length ? h("details.menu", null, h("summary", { "aria-label": "More actions", title: "More" }, "⋯"), h("div.menu-pop", null, ...items)) : h("span"),
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
    renderRunNow();
  }

  async function refresh(): Promise<void> {
    try {
      const res = await uiRequest({ type: "tasks.list" });
      tasks = res.tasks;
      source = res.source ?? "local";
      loaded = true;
      render();
    } catch (err) {
      flash(tasksMsg, errorText(err), "bad");
    }
  }

  async function reveal(id: string): Promise<boolean> {
    await refresh();
    const btn = tab.querySelector<HTMLButtonElement>(`[data-task-id="${CSS.escape(id)}"]`);
    if (!btn) return false;
    const fin = $<HTMLDetailsElement>("finished");
    if (fin.contains(btn)) fin.open = true;
    const li = btn.closest("li")!;
    li.scrollIntoView({ block: "nearest" });
    btn.focus();
    li.classList.remove("found");
    void li.offsetWidth; // restart the highlight
    li.classList.add("found");
    return true;
  }

  renderRunNow();
  return {
    refresh,
    reveal,
    tick: render,
    setState(state) {
      settings = state.settings;
      const before = account;
      account = state.account ?? { signedIn: false, signInConfigured: false, apiBase: "", dashboardUrl: "" };
      renderAccount();
      renderRunNow();
      // Signed in or out: the list comes from somewhere else now.
      if (before && (before.signedIn !== account.signedIn || before.user?.email !== account.user?.email)) void refresh();
    },
    signedOut: () => !!account && !account.signedIn,
  };
}
