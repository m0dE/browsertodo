/**
 * "Continue" for a run that stopped before finishing (stopped by the user,
 * paused, failed, retry): which runs can be continued, and the instructions
 * for the new run that picks up where the old one left off. Pure; shared by
 * the background runner and the side panel.
 */
import type { SessionInfo, StampedAgentEvent, TaskOutcome } from "@browsertodo/shared";
import { toolArgsSummary } from "./sidepanel/event-format.js";
import { clip } from "./sidepanel/format.js";

/** How many earlier steps the continuation instructions list. */
export const CONTINUE_STEPS = 15;

const CONTINUABLE: readonly TaskOutcome[] = ["paused", "failed", "retry"];

/** An outcome a run can be continued from. */
export function isContinuableOutcome(outcome: TaskOutcome | undefined): boolean {
  return !!outcome && CONTINUABLE.includes(outcome);
}

/**
 * The run ended without finishing and can be continued on this machine.
 * Cloud runs continue from the server's queue instead.
 */
export function isContinuable(s: Pick<SessionInfo, "endedAt" | "outcome" | "source"> | null | undefined): boolean {
  return !!s && !!s.endedAt && s.source !== "cloud" && isContinuableOutcome(s.outcome);
}

/** "Continue: <title>" without stacking the prefix on repeated continues. */
export function continueTitle(title: string): string {
  return clip(`Continue: ${title.replace(/^(Continue: )+/, "")}`, 80);
}

const bare = (name: string) => name.replace(/^mcp__browsertodo__/, "");

function argsOf(name: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  // Typed text matters most for not typing it twice: keep more of it.
  if ((name === "type" || name === "paste") && typeof a.text === "string") {
    const where = a.index !== undefined ? `#${String(a.index)} ` : "";
    return `${where}"${clip(a.text, 600)}"`;
  }
  return toolArgsSummary(name, args, 160);
}

/**
 * A compact list of what a run did: tool calls with short arguments and the
 * first line of their results, plus what the user typed. Oldest first, the
 * last `max` entries. `skipped` counts the older ones left out.
 */
export function doneSoFar(events: readonly StampedAgentEvent[], max = CONTINUE_STEPS): { steps: string[]; skipped: number } {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) {
    if (e.type === "tool_result") {
      const line = (e.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? (e.thumbnail ? "(screenshot)" : "");
      results.set(e.id, { text: clip(line, 140), isError: !!e.isError });
    }
  }
  const all: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call") {
      const name = bare(e.name);
      const args = argsOf(name, e.args);
      const r = results.get(e.id);
      const out = r ? ` → ${r.isError ? "error: " : ""}${r.text || "ok"}` : " → (no result)";
      all.push(`${name}${args ? ` ${args}` : ""}${out}`);
    } else if (e.type === "user_message") {
      all.push(`the user said: "${clip(e.text, 300)}"`);
    }
  }
  const steps = all.slice(-max);
  return { steps, skipped: all.length - steps.length };
}

/** The last thing the agent wrote in the run, if anything. */
export function lastAssistantText(events: readonly StampedAgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant_text" && e.text.trim()) return clip(e.text, 600);
  }
  return null;
}

/** Why the run stopped, in words. */
export function stopReason(s: Pick<SessionInfo, "outcome" | "reason">): string {
  if (s.reason?.trim()) return s.reason.trim();
  switch (s.outcome) {
    case "paused":
      return "it paused for the user";
    case "retry":
      return "a temporary problem";
    case "failed":
      return "it failed";
    default:
      return "unknown";
  }
}

export interface ContinueInput {
  /** The original task instructions. */
  instructions: string;
  session: Pick<SessionInfo, "outcome" | "reason">;
  events: readonly StampedAgentEvent[];
  /** The user's optional note. */
  note?: string | null;
}

/** Instructions for the run that continues a stopped one. */
export function buildContinueInstructions(input: ContinueInput): string {
  const { steps, skipped } = doneSoFar(input.events);
  const last = lastAssistantText(input.events);
  const note = input.note?.trim();
  const lines = [
    input.instructions.trim(),
    "",
    "--- Continuing a stopped run ---",
    `An earlier run of this task stopped before it finished (reason: ${stopReason(input.session)}).`,
  ];
  if (steps.length) {
    lines.push(
      skipped
        ? `What it already did (the last ${steps.length} steps, oldest first; ${skipped} earlier step(s) not shown):`
        : "What it already did (oldest first):",
      ...steps.map((s) => `- ${s}`),
    );
  } else {
    lines.push("It did not get to use any tools.");
  }
  if (last) lines.push(`Its last message: "${last}"`);
  if (note) lines.push(`The user adds: ${note}`);
  lines.push(
    "",
    "The browser tab is as that run left it (if it was closed, you are in a fresh tab). " +
      "First look at the current page (read_page or screenshot) and continue from there. " +
      "Do not repeat steps that are already done: for example, text already typed into a composer is still there, so do not type it again. " +
      "Never post twice: if the post (or message) was already published, do not publish it again; finish with its URL instead.",
  );
  return lines.join("\n");
}
