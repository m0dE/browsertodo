/**
 * The jobs list, the panel's first screen: a search field, then the groups that have jobs (Needs you, Running,
 * Scheduled, Recent; jobs.ts), one row each: its state as an icon, its title (and, quietly under it, why it needs
 * you, its repeat rule or its site), and on the right when it ran or runs next. Recent shows a page at a time
 * (Show more). Up and Down move between rows (from the search field too), Home and End to the ends, Enter opens.
 */
import { h } from "../ui/dom.js";
import type { JobData } from "./job-data.js";
import type { ListPlace } from "./job-nav.js";
import { groupJobs, jobRow, STATE_LABELS, type Job, type JobState } from "./jobs.js";

/** Recent shows this many rows at first, and this many more with each Show more. */
export const RECENT_PAGE = 25;

/** The panel's keyboard shortcuts as the user reads them ("Ctrl+.", "Ctrl+,"); null: Chrome assigned none. */
export interface Shortcuts {
  open: string | null;
  voice: string | null;
}

export interface JobListDeps {
  data: JobData;
  /** A row was picked. */
  onOpen(job: Job): void;
  /** "Set a keyboard shortcut" (chrome://extensions/shortcuts), when none is set. */
  onShortcuts(): void;
}

export interface JobList {
  /** The list is on screen again, as it was left. */
  show(place: ListPlace): void;
  /** Where the list is now (its search, scroll and the focused row), to come back to. */
  place(focusKey?: string | null): ListPlace;
  setShortcuts(shortcuts: Shortcuts): void;
  /** The clock moved on (relative times, due tasks). */
  tick(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** One 16px glyph per state, drawn in the state's colour (sidepanel.css .job-icon). */
const ICONS: Record<JobState | "repeat", string> = {
  running: '<circle cx="8" cy="8" r="5.5" opacity=".25"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>',
  needs: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.4M8 10.8v.2"/>',
  scheduled: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  due: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  retry: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.4"/>',
  repeat: '<path d="M3.5 7.2V6.5A2 2 0 0 1 5.5 4.5h6.5M10 2.5l2 2-2 2M12.5 8.8v.7a2 2 0 0 1-2 2H4M6 13.5l-2-2 2-2"/>',
  done: '<path d="M3.5 8.4 6.6 11.3 12.5 4.9"/>',
  failed: '<circle cx="8" cy="8" r="5.5"/><path d="M6 6l4 4M10 6l-4 4"/>',
  stopped: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  cancelled: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>',
};

/** The job's state as a glyph (a waiting repeating job: the repeat arrows). */
export function stateIcon(state: JobState, repeating = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICONS[repeating && state === "scheduled" ? "repeat" : state];
  return svg;
}

function rowOf(job: Job, now: number): HTMLLIElement {
  const r = jobRow(job, now);
  return h(
    "li",
    null,
    h(
      "button.job-row",
      { type: "button", "data-key": job.key, "data-state": job.state, "aria-label": r.label, title: job.title },
      h("span.job-icon", { "data-state": job.state, title: STATE_LABELS[job.state] }, stateIcon(job.state, !!job.repeat)),
      h("span.job-main", null, h("span.job-title", null, r.title), r.meta ? h("span.job-meta", null, r.meta) : null),
      h("span.job-when", null, r.when),
    ),
  );
}

export function initJobList(root: HTMLElement, deps: JobListDeps): JobList {
  const search = root.querySelector<HTMLInputElement>("#job-search")!;
  const groupsEl = root.querySelector<HTMLElement>("#job-groups")!;
  let recentShown = RECENT_PAGE;
  let shortcuts: Shortcuts | undefined;

  const rows = () => [...groupsEl.querySelectorAll<HTMLButtonElement>("button.job-row")];
  const focusedKey = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".job-row")?.dataset.key ?? null;
  const rowFor = (key: string) => groupsEl.querySelector<HTMLButtonElement>(`button.job-row[data-key="${CSS.escape(key)}"]`);

  /**
   * "Ctrl+. to open · Ctrl+, to talk"; with only the open key, "Press Ctrl+. to open BrowserTODO at any time.";
   * without it, a link to set one.
   */
  function shortcutHint(): HTMLElement | null {
    if (!shortcuts) return null;
    const { open, voice } = shortcuts;
    const talk = voice ? [" · ", h("kbd", null, voice), " to talk"] : [];
    if (!open) {
      const link = h("button.link.shortcut-link", { type: "button", onclick: () => deps.onShortcuts() }, "Set a keyboard shortcut");
      return h("p.shortcut-hint", null, link, " to open BrowserTODO at any time", ...(voice ? talk : ["."]));
    }
    if (!voice) return h("p.shortcut-hint", null, "Press ", h("kbd", null, open), " to open BrowserTODO at any time.");
    return h("p.shortcut-hint", null, h("kbd", null, open), " to open", ...talk);
  }

  function emptyState(query: string): HTMLElement {
    if (query.trim()) return h("div.jobs-empty", { role: "status" }, h("p.empty-title", null, "No jobs match"), h("p", null, `Nothing has “${query.trim()}” in its title, request or site.`));
    return h(
      "div.jobs-empty",
      null,
      h("p.empty-title", null, "No jobs yet"),
      h("p", null, "Type below to start one, like “Post ‘good morning’ on X”, or say when: “every day at 9 post a tip on X”."),
      shortcutHint(),
    );
  }

  function render(): void {
    // Hidden, it is drawn when shown again (show()).
    if (root.hidden) return;
    const data = deps.data;
    if (!data.loaded) return;
    const now = Date.now();
    const query = search.value;
    const keep = focusedKey();
    const groups = groupJobs(data.jobs(now), query);
    groupsEl.replaceChildren(
      ...groups.map((g) => {
        const id = `group-${g.id}`;
        const list = g.id === "recent" ? g.jobs.slice(0, recentShown) : g.jobs;
        const more = g.jobs.length - list.length;
        return h(
          "section.job-group",
          { "aria-labelledby": id },
          h("h2.group-head", { id }, g.label, h("span.count", null, String(g.jobs.length))),
          h("ul.job-rows", null, ...list.map((j) => rowOf(j, now))),
          more > 0
            ? h(
                "button.link.show-more",
                {
                  type: "button",
                  onclick: () => {
                    const first = list.length;
                    recentShown += RECENT_PAGE;
                    render();
                    // The first new row takes the focus (the button is gone).
                    groupsEl.querySelectorAll<HTMLButtonElement>('section[aria-labelledby="group-recent"] button.job-row')[first]?.focus();
                  },
                },
                `Show ${Math.min(more, RECENT_PAGE)} more`,
              )
            : null,
        );
      }),
      ...(groups.length ? [] : [emptyState(query)]),
    );
    if (keep) rowFor(keep)?.focus();
  }

  function moveFocus(e: KeyboardEvent): void {
    const all = rows();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = document.activeElement === search;
    let to: number | null = null;
    if (e.key === "ArrowDown") to = inSearch ? 0 : i + 1;
    else if (e.key === "ArrowUp") to = i - 1;
    else if (!inSearch && e.key === "Home") to = 0;
    else if (!inSearch && e.key === "End") to = all.length - 1;
    if (to === null || (i < 0 && !inSearch)) return;
    e.preventDefault();
    // Up from the first row goes back to the search field.
    if (to < 0) return search.focus();
    all[Math.min(to, all.length - 1)]!.focus();
  }

  root.addEventListener("keydown", moveFocus);
  search.addEventListener("input", () => {
    recentShown = RECENT_PAGE;
    render();
    root.scrollTop = 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
  });
  groupsEl.addEventListener("click", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("button.job-row")?.dataset.key;
    const job = key ? deps.data.job(key) : null;
    if (job) deps.onOpen(job);
  });
  deps.data.onChange(() => render());

  return {
    show(place) {
      if (search.value !== place.query) {
        search.value = place.query;
        recentShown = RECENT_PAGE;
      }
      render();
      root.scrollTop = place.scrollTop;
      if (place.focusKey) rowFor(place.focusKey)?.focus({ preventScroll: true });
    },
    place(focusKey = focusedKey()) {
      return { query: search.value, scrollTop: root.scrollTop, focusKey };
    },
    setShortcuts(next) {
      if (shortcuts?.open === next.open && shortcuts.voice === next.voice) return;
      shortcuts = next;
      render();
    },
    tick() {
      // The focused row keeps the focus (render puts it back).
      render();
    },
  };
}
