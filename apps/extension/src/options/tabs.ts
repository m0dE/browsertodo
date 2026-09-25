/**
 * The options page's tabs: an accessible tablist (arrow keys, Home / End),
 * the open tab in location.hash (so options.html#ai opens the AI tab) and,
 * for a plain options.html, the tab opened last in this browser.
 */
import { $, h } from "../ui/dom.js";
import { nextTab, TABS, tabFromHash, type TabId } from "./settings-view.js";

const LAST_TAB_KEY = "browsertodo.options.tab";

function readLast(): TabId | null {
  try {
    return tabFromHash(localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return null;
  }
}

function writeLast(id: TabId): void {
  try {
    localStorage.setItem(LAST_TAB_KEY, id);
  } catch {
    /* storage blocked: the hash still works */
  }
}

export interface Tabs {
  current(): TabId;
  show(id: TabId, opts?: { focus?: boolean }): void;
}

export function initTabs(): Tabs {
  const list = $("tabs");
  const buttons = TABS.map((t) =>
    h(
      "button.tab",
      { type: "button", role: "tab", id: `tab-${t.id}`, "aria-controls": `panel-${t.id}`, "aria-selected": "false", tabindex: "-1", "data-tab": t.id },
      t.label,
    ),
  );
  list.replaceChildren(...buttons);
  let current: TabId = TABS[0].id;

  function show(id: TabId, opts: { focus?: boolean } = {}): void {
    current = id;
    for (const b of buttons) {
      const on = b.dataset.tab === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      $(`panel-${b.dataset.tab}`).hidden = !on;
      if (on) {
        if (opts.focus) b.focus();
        b.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    writeLast(id);
  }

  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (b) show(b.dataset.tab as TabId);
  });
  list.addEventListener("keydown", (e) => {
    const to = nextTab(current, e.key);
    if (!to) return;
    e.preventDefault();
    show(to, { focus: true });
  });
  window.addEventListener("hashchange", () => {
    const id = tabFromHash(location.hash);
    if (id && id !== current) show(id);
  });

  show(tabFromHash(location.hash) ?? readLast() ?? TABS[0].id);
  return { current: () => current, show };
}
