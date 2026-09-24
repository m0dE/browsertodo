/** Pure view models for agent events in the Activity tab. */
import type { AgentEvent } from "@browsertodo/shared";
import { clip, outcomeChip, type Chip } from "./format.js";

export type EventView =
  | { kind: "status"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: string }
  | { kind: "result"; id: string; name: string; preview: string; full: string; isError: boolean; thumbnail?: string }
  | { kind: "jev"; label: string; ms: number; executed: boolean; title: string }
  | { kind: "user"; text: string }
  | { kind: "end"; chip: Chip; text: string; url?: string }
  | { kind: "error"; text: string };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Shorten a URL for display: drop the scheme and "www.". */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

/** One-line summary of a tool call's arguments. */
export function toolArgsSummary(name: string, args: unknown, max = 70): string {
  const a = obj(args);
  const q = (s: unknown) => `"${clip(String(s), max - 2)}"`;
  switch (name) {
    case "navigate":
      return clip(shortUrl(String(a.url ?? "")), max);
    case "read_page":
    case "screenshot":
      return "";
    case "act": {
      const steps = Array.isArray(a.steps) ? a.steps.map(obj) : [];
      if (!steps.length) return "";
      const first = clip(String(steps[0]?.goal ?? ""), max);
      return steps.length > 1 ? `${first} (+${steps.length - 1} more)` : first;
    }
    case "click":
      return `#${String(a.index)}`;
    case "type":
      return clip(`#${String(a.index)} ${q(a.text)}`, max);
    case "paste":
      return q(a.text);
    case "press_key":
      return String(a.key ?? "");
    case "scroll":
      return [a.direction, a.amount ? `×${String(a.amount)}` : "", a.index !== undefined ? `in #${String(a.index)}` : ""]
        .filter(Boolean)
        .join(" ");
    case "upload":
      return clip(
        `#${String(a.index)} ${(Array.isArray(a.paths) ? a.paths : []).map((p) => String(p).split(/[\\/]/).pop()).join(", ")}`,
        max,
      );
    case "switch_x_account":
      return String(a.handle ?? "");
    case "get_credential":
      return String(a.site ?? "");
    case "task_complete":
      return clip(String(a.summary ?? ""), max);
    case "task_fail":
    case "task_pause":
      return clip(String(a.reason ?? ""), max);
    default: {
      if (args === undefined || args === null) return "";
      if (typeof args !== "object") return clip(String(args), max);
      const parts = Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      return clip(parts.join(" "), max);
    }
  }
}

export function describeEvent(ev: AgentEvent): EventView {
  switch (ev.type) {
    case "status":
      return { kind: "status", text: ev.text };
    case "assistant_text":
      return { kind: "text", text: ev.text.trim() };
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
        label: `Jev ${ev.operation}${target} · ${ev.confidence.toFixed(2)}`,
        ms: ev.ms,
        executed: ev.executed,
        title: `${ev.goal}${ev.executed ? "" : " (not confident, left to Claude)"}`,
      };
    }
    case "user_message":
      return { kind: "user", text: ev.text };
    case "task_end": {
      const text = ev.summary || ev.reason || "";
      return { kind: "end", chip: outcomeChip(ev.outcome), text, ...(ev.url ? { url: ev.url } : {}) };
    }
    case "error":
      return { kind: "error", text: ev.text };
  }
}

/** Should a scroll container keep following new content? (within `slack` px of the bottom) */
export function isNearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}
