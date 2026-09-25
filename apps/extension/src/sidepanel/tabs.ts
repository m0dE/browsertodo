/** The side panel's tabs (Chat | TODO | Activity log) and the one opened last. */
import { $ } from "../ui/dom.js";

export type TabName = "chat" | "todo" | "history";

export const TAB_NAMES: readonly TabName[] = ["chat", "todo", "history"];

/** Values older panels saved (Tasks / Activity) and what they are called now. */
const RENAMED: Record<string, TabName> = { activity: "chat", tasks: "todo" };

/** The tab to open with, from the value saved in localStorage (Chat when nothing usable was saved). */
export function savedTab(value: string | null | undefined): TabName {
  if (!value) return "chat";
  if ((TAB_NAMES as readonly string[]).includes(value)) return value as TabName;
  return RENAMED[value] ?? "chat";
}

/** The composer sits under Chat and TODO; the Activity log is read-only. */
export const tabHasComposer = (tab: TabName): boolean => tab !== "history";

const LAST_TAB_KEY = "browsertodo.panel.tab";
/** Where older panels kept it; read (and dropped) once. */
const OLD_LAST_TAB_KEY = "tab";

function readLastTab(): TabName {
  try {
    const old = localStorage.getItem(OLD_LAST_TAB_KEY);
    if (old !== null) localStorage.removeItem(OLD_LAST_TAB_KEY);
    return savedTab(old ?? localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return "chat"; // storage blocked: open Chat
  }
}

function writeLastTab(name: TabName): void {
  try {
    localStorage.setItem(LAST_TAB_KEY, name);
  } catch {
    // Storage blocked: the tab just is not remembered.
  }
}

export interface PanelTabs {
  show(name: TabName): void;
}

/**
 * The tablist (arrow keys move between tabs). Opens the tab used last;
 * onShow runs for every tab shown, the first one included.
 */
export function initPanelTabs(onShow: (name: TabName) => void): PanelTabs {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")];

  function show(name: TabName): void {
    for (const btn of buttons) {
      const on = btn.dataset.tab === name;
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
      $(`tab-${btn.dataset.tab}`).hidden = !on;
    }
    writeLastTab(name);
    onShow(name);
  }

  for (const btn of buttons) {
    btn.addEventListener("click", () => show(btn.dataset.tab as TabName));
    btn.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = buttons[(buttons.indexOf(btn) + step + buttons.length) % buttons.length]!;
      next.focus();
      show(next.dataset.tab as TabName);
    });
  }

  show(readLastTab());
  return { show };
}
