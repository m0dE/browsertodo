/** The side panel's tabs and the remembered one. Pure. */

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

/** The composer sits under Chat and TODO; the Activity Log is read-only. */
export const tabHasComposer = (tab: TabName): boolean => tab !== "history";
