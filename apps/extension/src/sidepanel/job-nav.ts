/**
 * Where the side panel is: the jobs list, or one job's page. Going back to the list gives back what it was left
 * with (its search, its scroll, the row that was opened), so the user lands where they were. DOM-free.
 */

export type PanelView = { kind: "list" } | { kind: "job"; key: string };

/** What the list was left with when a job was opened. */
export interface ListPlace {
  query: string;
  scrollTop: number;
  /** The row that was opened (its job key): focus goes back to it. */
  focusKey: string | null;
}

const LIST: PanelView = { kind: "list" };

/**
 * Where older panels kept their last tab (Chat | TODO | History). Their URL hashes (#todo, #history) need nothing:
 * every panel opens on the list.
 */
const OLD_TAB_KEYS = ["browsertodo.panel.tab", "tab"];

export class JobNav {
  private current: PanelView = LIST;
  private place: ListPlace = { query: "", scrollTop: 0, focusKey: null };
  private readonly listeners = new Set<(view: PanelView, before: PanelView) => void>();

  get view(): PanelView {
    return this.current;
  }

  /** The job shown (null: the list). */
  get jobKey(): string | null {
    return this.current.kind === "job" ? this.current.key : null;
  }

  /** Opens a job's page; `from` is the list as it is now (kept for back()), when the list is what is left. */
  open(key: string, from?: ListPlace): void {
    if (this.current.kind === "list" && from) this.place = { ...from };
    this.go({ kind: "job", key });
  }

  /** Back to the list; returns where it was left. */
  back(): ListPlace {
    this.go(LIST);
    return { ...this.place };
  }

  /** The list as it was last left (its search stays when the page shows another job). */
  listPlace(): ListPlace {
    return { ...this.place };
  }

  onChange(fn: (view: PanelView, before: PanelView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private go(next: PanelView): void {
    const before = this.current;
    if (before.kind === next.kind && (before.kind === "list" || (next.kind === "job" && before.key === next.key))) return;
    this.current = next;
    for (const fn of this.listeners) fn(next, before);
  }
}

/** What a screen reader hears when the view changes. */
export function viewAnnouncement(view: PanelView, jobTitle: string | null): string {
  return view.kind === "list" ? "Jobs" : `Job: ${jobTitle ?? "loading"}`;
}

/** Drops the last tab older panels kept: the panel always opens on the list now. */
export function forgetOldTabs(storage: Pick<Storage, "removeItem">): void {
  try {
    for (const k of OLD_TAB_KEYS) storage.removeItem(k);
  } catch {
    // Storage blocked: nothing was kept either.
  }
}
