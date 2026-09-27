/**
 * The chat's note of a change to the agent's memory (a `memory` event):
 * "Remembered: Work email · admin@runhq.io is ..." with Undo, "Updated
 * memory: ...", or "Forgot: ...". A note added to a task's record shows
 * that note. Once undone it says so. Pure.
 */
import { isMemoryRecord, MEMORY_KIND_TEXT, type AgentEvent, type MemoryEntry } from "@browsertodo/shared";

export interface MemoryNoteView {
  kind: "memory";
  changeId: string;
  /** "Remembered", "Updated memory", "Forgot". */
  label: string;
  subject: string;
  text: string;
  /** The whole entry in words, for the tooltip: its kind, site and text (and what it replaced). */
  title: string;
  undone?: true;
}

/** What a memory change's note says; undone: the user undid it since. */
export function memoryNoteView(ev: Extract<AgentEvent, { type: "memory" }>, undone: boolean): MemoryNoteView {
  const shown = (ev.after ?? ev.before)!;
  const label = !ev.before ? "Remembered" : ev.after ? "Updated memory" : "Forgot";
  const record = isMemoryRecord(shown);
  const where = (e: MemoryEntry) => `${record ? "Task record" : MEMORY_KIND_TEXT[e.kind].label}${e.domain ? ` · ${e.domain}` : ""}${e.taskTitle ? ` · ${e.taskTitle}` : ""}`;
  // A record grows by dated notes: what changed is its newest note (its summary is in the tooltip).
  const added = record && ev.before && ev.after ? ev.after.notes?.at(-1)?.text : undefined;
  const was = !record && ev.before && ev.after && ev.before.text !== ev.after.text ? `\n\nWas: ${ev.before.text}` : "";
  const notes = (shown.notes ?? []).map((n) => `\n${n.at.slice(0, 10)}: ${n.text}`).join("");
  const v: MemoryNoteView = {
    kind: "memory",
    changeId: ev.changeId,
    label,
    subject: shown.subject,
    text: added ?? shown.text,
    title: `${where(shown)}\n${shown.subject}: ${shown.text}${notes}${was}`,
  };
  return undone ? { ...v, undone: true } : v;
}

/** What an undone note says under its line. */
export function undoneText(v: Pick<MemoryNoteView, "label">): string {
  return v.label === "Remembered" ? "Not kept." : v.label === "Forgot" ? "Kept after all." : "Back to what it was.";
}
