/**
 * A job's page: its header ("‹" back to the list, the title, one line of where it is, and "⋯" with what can be
 * done with it now: job-actions.ts) over its conversation (chat.ts). A task that ran more than once has its earlier
 * runs above the latest, one collapsed section each (the date and how it ended) that opens to that run's
 * conversation; a task that never ran shows its request and when it will. Under the header, while the job's agent tab
 * is not the one the user looks at: that tab, with View to watch the agent there.
 */
import { chipHint, MAX_CHAT_TITLE_CHARS, type SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { $, h } from "../ui/dom.js";
import { renderPastRun, type ChatView } from "./chat.js";
import { outcomeChip } from "./format.js";
import { jobActions, type JobAction, type JobActionId } from "./job-actions.js";
import type { JobData } from "./job-data.js";
import { jobSubtitle, type Job } from "./jobs.js";
import { formatWhen } from "./task-details.js";

/** Earlier runs listed at first (the newest of them); "Show N earlier runs" lists the rest. */
export const EARLIER_RUNS_SHOWN = 10;

export interface JobPageDeps {
  data: JobData;
  chat: ChatView;
  /** The tab to watch a conversation's agent in, when the user is not looking at it (null: none; see agentTabToView). */
  agentTab(sessionId: string): number | null;
  /** What a tab shows (null: it is gone). */
  tabInfo(tabId: number): Promise<TabInfo | null>;
  goToTab(tabId: number): void;
  /** Resume a stopped conversation (with the note typed in the box, if any). */
  continueNow(sessionId: string): void;
  openSchedule(job: Job, trigger: HTMLElement): void;
  /** The details sheet of a task that never ran (its request, its schedule). */
  onTaskDetails(job: Job, trigger: HTMLElement): void;
  onSessionDetails(session: SessionInfo, trigger: HTMLElement): void;
  onBack(): void;
  /** The job was deleted (the list shows again). */
  onDeleted(): void;
  showError(err: unknown): void;
}

export interface TabInfo {
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface JobPage {
  /** Shows job `key`: its header and its conversation. */
  show(key: string): void;
  /** The data changed: the header, the menu and the earlier runs follow. */
  render(): void;
  /** The job shown (null: not known yet, e.g. a chat that just started). */
  job(): Job | null;
  /** The conversation the page shows (the chat, or the task's newest run); null: none. */
  sessionId(): string | null;
  /** Its title as the header shows it. */
  title(): string;
  /** A tab's title, address or icon changed (the agent's tab row follows). */
  tabUpdated(tabId: number): void;
}

/** A tab without an icon the panel can show. */
const GLOBE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c-3.2 3.6-3.2 9 0 12.6M8 1.7c3.2 3.6 3.2 9 0 12.6"/></svg>';

/** A page's site, as a person reads it ("mail.google.com"); "" for pages without one. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A tab's icon the panel may show: a web or inline image (chrome:// icons do not load in an extension page). */
function safeIcon(url: string | undefined): string | null {
  return url && /^(https?:|data:image\/)/.test(url) ? url : null;
}

export function initJobPage(deps: JobPageDeps): JobPage {
  const { data, chat } = deps;
  const titleEl = $("job-title");
  const sub = $("job-sub");
  const menu = $<HTMLDetailsElement>("job-menu");
  const pop = $("job-menu-pop");
  const agentRow = $("job-agent-tab");
  const said = $("job-agent-tab-said");
  let key: string | null = null;
  /** What the earlier runs block was built from (rebuilt only when that changes, so open sections stay open). */
  let beforeOf = "";
  let renaming = false;

  const current = (): Job | null => (key ? data.job(key) : null);
  const sessionId = (): string | null => {
    const job = current();
    if (job) return job.session?.sessionId ?? null;
    return key?.startsWith("chat:") ? key.slice("chat:".length) : null;
  };

  $("job-back").addEventListener("click", () => deps.onBack());

  // The menu is built as it opens (what the job offers at that moment: on the click, before it shows), and emptied
  // when it closes.
  menu.querySelector("summary")!.addEventListener("click", () => {
    if (!menu.open) buildMenu();
  });
  menu.addEventListener("toggle", () => {
    if (!menu.open) return pop.replaceChildren();
    if (!pop.childElementCount) buildMenu();
    pop.querySelector<HTMLButtonElement>("button")?.focus();
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...pop.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length]!.focus();
    }
  });

  function item(a: JobAction): HTMLButtonElement {
    const b = h(a.danger ? "button.bad" : "button", { type: "button", role: "menuitem", "data-action": a.id, title: a.title }, a.id === "raw" && chat.rawOpen ? "Close raw" : a.label);
    b.addEventListener("click", (e) => {
      // The confirmation takes the item's place: the click must not count as one outside the menu (which closes it).
      if (a.id === "delete") {
        e.stopPropagation();
        return confirmDelete();
      }
      menu.open = false;
      void act(a.id);
    });
    return b;
  }

  function buildMenu(): void {
    const job = current();
    const actions = job ? jobActions(job, data.source) : [];
    pop.replaceChildren(...actions.map(item));
    if (menu.open) pop.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** Delete asks once, in the menu: this cannot be undone. */
  function confirmDelete(): void {
    const job = current();
    if (!job) return;
    const yes = h("button.bad", { type: "button", role: "menuitem", "data-action": "delete-confirm" }, "Delete");
    const no = h("button", { type: "button", role: "menuitem" }, "Keep");
    yes.addEventListener("click", () => {
      menu.open = false;
      void act("delete");
    });
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      buildMenu();
    });
    pop.replaceChildren(h("p.menu-note", { role: "alert" }, job.kind === "task" ? "Delete this job and all its runs? This can't be undone." : "Delete this chat? This can't be undone."), yes, no);
    no.focus();
  }

  async function act(id: JobActionId): Promise<void> {
    const job = current();
    if (!job) return;
    const t = job.task;
    const s = job.session;
    try {
      switch (id) {
        case "run":
          if (t) await uiRequest({ type: "tasks.run", id: t.id });
          await data.loadTasks();
          break;
        case "pause":
          if (s) await uiRequest({ type: "run.stop", sessionId: s.sessionId });
          break;
        case "resume":
          if (t && data.source === "account") {
            await uiRequest({ type: "tasks.retry", id: t.id });
            await data.loadTasks();
          } else if (s) deps.continueNow(s.sessionId);
          break;
        case "schedule":
          deps.openSchedule(job, menu.querySelector("summary")!);
          break;
        case "trust":
          if (t) await uiRequest({ type: "tasks.update", id: t.id, patch: { agentAuthored: false } });
          await data.loadTasks();
          break;
        case "raw":
          chat.setRaw(!chat.rawOpen);
          break;
        case "rename":
          startRename();
          break;
        case "cancel":
          if (t) await uiRequest({ type: "tasks.cancel", id: t.id });
          await data.loadTasks();
          break;
        case "delete":
          await remove(job);
          break;
      }
    } catch (err) {
      deps.showError(err);
    }
  }

  /** A chat goes with its conversation; a task with every repeat of it and every run. */
  async function remove(job: Job): Promise<void> {
    for (const t of job.tasks) if (t.status !== "running") await uiRequest({ type: "tasks.delete", id: t.id });
    for (const r of job.runs) {
      if (job.running && r.sessionId === job.session?.sessionId) continue;
      await uiRequest({ type: "session.delete", sessionId: r.sessionId });
      data.forget(r.sessionId);
    }
    if (job.tasks.length) await data.loadTasks();
    deps.onDeleted();
  }

  /** The title becomes a text box: Enter or leaving it saves (an unchanged or empty name keeps it), Escape cancels. */
  function startRename(): void {
    const s = current()?.session;
    if (!s || renaming) return;
    renaming = true;
    const box = h("input.job-rename", { type: "text", value: titleEl.textContent ?? "", "aria-label": "Job name", maxlength: MAX_CHAT_TITLE_CHARS, spellcheck: "false" });
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = box.value.trim();
      box.replaceWith(titleEl);
      renaming = false;
      titleEl.focus();
      if (!save || !name || name === s.title) return render();
      titleEl.textContent = name;
      try {
        data.onSession((await uiRequest({ type: "session.rename", sessionId: s.sessionId, title: name })).session);
      } catch (err) {
        deps.showError(err);
        render();
      }
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void finish(true);
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void finish(false);
      }
    });
    box.addEventListener("blur", () => void finish(true));
    titleEl.replaceWith(box);
    box.focus();
    box.select();
  }

  /**
   * The agent's tab, while the user is not looking at it: its icon, title and site, and View (that tab, in front, to
   * watch the agent there). Screen readers hear it when it appears, not each page the agent opens there.
   */
  function renderAgentTab(job: Job | null): void {
    const id = sessionId();
    const tab = id ? deps.agentTab(id) : null;
    if (tab === null) {
      agentRow.hidden = true;
      delete agentRow.dataset.tab;
      return;
    }
    const lead = job?.running ? "Working in" : "Ran in";
    if (agentRow.dataset.tab !== String(tab)) {
      agentRow.dataset.tab = String(tab);
      agentRow.hidden = true;
      const view = h("button.job-tab-view", { type: "button", title: "Switch to this tab to watch the agent", "aria-label": "View the agent's tab" }, "View");
      view.addEventListener("click", () => deps.goToTab(tab));
      agentRow.replaceChildren(h("span.job-tab-icon", { "aria-hidden": "true" }), h("span.job-tab-text", null, h("span.job-tab-lead"), " ", h("b.job-tab-name"), h("span.job-tab-host")), view);
    }
    agentRow.querySelector(".job-tab-lead")!.textContent = lead;
    void fillTab(tab);
  }

  /** The row's tab as it is now; shown once known (hidden if the tab is gone). */
  async function fillTab(tab: number): Promise<void> {
    const info = await deps.tabInfo(tab);
    if (agentRow.dataset.tab !== String(tab)) return;
    if (!info) {
      agentRow.hidden = true;
      return;
    }
    const host = hostOf(info.url);
    const title = info.title || host || "another tab";
    const name = agentRow.querySelector<HTMLElement>(".job-tab-name")!;
    name.textContent = title;
    name.title = info.url ? `${title} (${info.url})` : title;
    agentRow.querySelector(".job-tab-host")!.textContent = host && host !== title ? host : "";
    agentRow.querySelector(".job-tab-view")!.setAttribute("aria-label", `View the agent's tab: ${title}`);
    const icon = agentRow.querySelector<HTMLElement>(".job-tab-icon")!;
    const src = safeIcon(info.favIconUrl) ?? "";
    if (icon.dataset.src !== src || !icon.firstChild) {
      icon.dataset.src = src;
      if (!src) icon.innerHTML = GLOBE_ICON;
      else {
        const img = h("img", { src, alt: "", width: 16, height: 16 }) as HTMLImageElement;
        img.addEventListener("error", () => (icon.innerHTML = GLOBE_ICON));
        icon.replaceChildren(img);
      }
    }
    if (agentRow.hidden) {
      agentRow.hidden = false;
      said.textContent = `${agentRow.querySelector(".job-tab-lead")!.textContent} ${title}. View shows it.`;
    }
  }

  /** One earlier run: its date and how it ended; opened, its conversation (loaded then). */
  function earlierRun(run: SessionInfo): HTMLElement {
    const chip = outcomeChip(run.endedAt ? (run.outcome ?? "stopped") : "stopped");
    const body = h("div.job-run-body");
    const section = h(
      "details.job-run",
      { "data-session": run.sessionId },
      h(
        "summary",
        null,
        h("span.run-when", null, formatWhen(run.firstStartedAt ?? run.startedAt)),
        h("span.chip", { "data-tone": chip.tone, title: chipHint(chip.label) || chip.label }, chip.label),
        run.summary ? h("span.run-line", null, run.summary) : null,
      ),
      body,
    );
    section.addEventListener("toggle", () => {
      if (!section.open || body.dataset.loaded) return;
      body.dataset.loaded = "1";
      body.replaceChildren(h("p.empty", null, "Loading…"));
      uiRequest({ type: "sessions.events", sessionId: run.sessionId }).then(
        (r) => body.replaceChildren(renderPastRun(r.session, r.events, deps.onSessionDetails)),
        (err: unknown) => {
          delete body.dataset.loaded;
          body.replaceChildren(h("p.empty", null, `Couldn't load this run: ${err instanceof Error ? err.message : String(err)}`));
        },
      );
    });
    return section;
  }

  /** Above the conversation: a task's earlier runs, or (never run) its request and when it runs. */
  function renderBefore(job: Job | null): void {
    if (!job || job.kind !== "task") {
      beforeOf = "";
      return chat.setBefore(null);
    }
    const shown = job.session?.sessionId ?? null;
    const earlier = job.runs.filter((r) => r.sessionId !== shown);
    const sig = shown ? `${job.key}|${shown}|${earlier.map((r) => `${r.sessionId}:${r.outcome ?? ""}`).join()}` : `${job.key}|intro|${job.task?.instructions ?? ""}`;
    if (sig === beforeOf) return;
    beforeOf = sig;
    if (!shown && job.task) {
      const task = job.task;
      const bubble = h("div.ev-user.ev-first", { role: "button", tabindex: "0", title: "Show the full task and its details" }, h("span.ev-origin", null, "Scheduled"), h("span.ev-user-text", null, task.instructions));
      const open = () => deps.onTaskDetails(job, bubble);
      bubble.addEventListener("click", open);
      bubble.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      return chat.setBefore(h("div.job-intro", null, h("div.ev-opening", null, bubble, h("div.ev-when", null, "Not run yet"))));
    }
    if (!earlier.length) return chat.setBefore(null);
    const newestFirst = [...earlier].reverse();
    const list = h("div.job-runs-list", null, ...newestFirst.slice(0, EARLIER_RUNS_SHOWN).reverse().map(earlierRun));
    const hidden = newestFirst.slice(EARLIER_RUNS_SHOWN);
    const more = hidden.length ? h("button.link.job-runs-more", { type: "button" }, `Show ${hidden.length} earlier run${hidden.length === 1 ? "" : "s"}`) : null;
    more?.addEventListener("click", () => {
      list.prepend(...[...hidden].reverse().map(earlierRun));
      more.remove();
    });
    chat.setBefore(
      h(
        "section.job-runs",
        { "aria-label": "Earlier runs" },
        h("h2.job-runs-head", null, `Earlier runs · ${earlier.length}`),
        more,
        list,
        h("h2.job-runs-head.latest", null, `Latest run · ${formatWhen(job.session!.firstStartedAt ?? job.session!.startedAt)}`),
      ),
    );
  }

  function render(): void {
    if (!key) return;
    const job = current();
    const shown = chat.shown();
    if (!renaming) titleEl.textContent = job?.title ?? shown?.title ?? "";
    titleEl.title = titleEl.textContent ?? "";
    sub.textContent = job ? jobSubtitle(job) : "";
    menu.hidden = !!job && jobActions(job, data.source).length === 0;
    renderAgentTab(job);
    renderBefore(job);
    chat.show(sessionId());
  }

  return {
    show(next) {
      if (next !== key) {
        key = next;
        beforeOf = "";
        menu.open = false;
        chat.setRaw(false);
        chat.setBefore(null);
      }
      render();
    },
    render,
    job: current,
    sessionId,
    title: () => titleEl.textContent ?? "",
    tabUpdated(tab) {
      if (!agentRow.hidden && agentRow.dataset.tab === String(tab)) void fillTab(tab);
    },
  };
}
