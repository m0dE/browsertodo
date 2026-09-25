/** Pure view models for agent events in Chat and the Activity log. */
import { picksText, SCREEN_HELP_TEXT, type AgentEvent, type Chip, type ElementPicks } from "@browsertodo/shared";
import { clip, isLongSummary, toolArgsSummary } from "../text.js";
import { outcomeChip } from "./format.js";

export type EventView =
  /** picks: the end-of-turn "Jev chose ..." line, shown in the end card instead of on its own. */
  | { kind: "status"; text: string; picks?: true }
  /** Claude's text (Markdown). id: the streamed block it completes. */
  | { kind: "text"; text: string; id?: string }
  | { kind: "tool"; id: string; name: string; args: string }
  | { kind: "result"; id: string; name: string; preview: string; full: string; isError: boolean; thumbnail?: string }
  | { kind: "jev"; label: string; ms: number; executed: boolean; title: string }
  /** screen: an empty message, "look at the page and do what is needed" (shown quieter, with an eye). */
  | { kind: "user"; text: string; screen?: true }
  /**
   * picks: who picked the turn's elements ("Jev chose 9 of 11 element picks ...").
   * long: the text is an answer (several lines or long), shown as a message above the outcome line.
   */
  | { kind: "end"; chip: Chip; text: string; url?: string; picks?: string; long?: true }
  | { kind: "error"; text: string };

/**
 * The element picks of the turn that `events[endIndex]` (a task_end) closes:
 * the status line with picks since the previous task_end.
 */
export function turnPicks(events: readonly AgentEvent[], endIndex: number): ElementPicks | undefined {
  for (let i = endIndex - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "task_end") return undefined;
    if (e.type === "status" && e.picks) return e.picks;
  }
  return undefined;
}

/** picks: for a task_end, the turn's element picks (see turnPicks). */
export function describeEvent(ev: AgentEvent, picks?: ElementPicks): EventView {
  switch (ev.type) {
    case "status":
      return ev.picks ? { kind: "status", text: ev.text, picks: true } : { kind: "status", text: ev.text };
    case "assistant_text":
      return ev.id ? { kind: "text", text: ev.text.trim(), id: ev.id } : { kind: "text", text: ev.text.trim() };
    case "assistant_text_delta":
      // Live text is shown by the chat as it streams (see chat.ts); as an event it is its block's text so far.
      return { kind: "text", text: ev.text, id: ev.id };
    case "tool_call":
      return { kind: "tool", id: ev.id, name: ev.name, args: toolArgsSummary(ev.name, ev.args) };
    case "tool_result": {
      const full = ev.text ?? "";
      const preview = clip(full, 90) || (ev.thumbnail ? "image" : ev.isError ? "error" : "ok");
      return {
        kind: "result",
        id: ev.id,
        name: ev.name,
        preview,
        full,
        isError: !!ev.isError,
        ...(ev.thumbnail ? { thumbnail: ev.thumbnail } : {}),
      };
    }
    case "jev": {
      const target = ev.index === null ? "" : ` #${ev.index}`;
      return {
        kind: "jev",
        // Say plainly who made the decision: Jev did it, or Jev was unsure and Claude takes over.
        label: ev.executed ? `Jev: ${ev.operation}${target} · ${ev.confidence.toFixed(2)}` : `Jev unsure (${ev.confidence.toFixed(2)}) · Claude decides`,
        ms: ev.ms,
        executed: ev.executed,
        title: `Jev (a faster helper for simple clicks and typing): ${ev.goal}${ev.executed ? "" : " (not confident, left to Claude)"}`,
      };
    }
    case "user_message":
      return isScreenHelp(ev.text) ? { kind: "user", text: ev.text, screen: true } : { kind: "user", text: ev.text };
    case "task_end": {
      const text = (ev.summary || ev.reason || "").trim();
      return {
        kind: "end",
        chip: outcomeChip(ev.outcome),
        text,
        ...(ev.url ? { url: ev.url } : {}),
        ...(picks ? { picks: picksText(picks) } : {}),
        ...(isLongSummary(text) ? { long: true as const } : {}),
      };
    }
    case "error":
      return { kind: "error", text: ev.text };
  }
}

/** The user's turn was an empty message in Chat: look at the page (SCREEN_HELP_TEXT). */
export function isScreenHelp(text: string | undefined): boolean {
  return text?.trim() === SCREEN_HELP_TEXT;
}

/** Should a scroll container keep following new content? (within `slack` px of the bottom) */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}
