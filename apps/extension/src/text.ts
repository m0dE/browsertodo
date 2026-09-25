/** Short text for events and tool calls, shared by the background (continue.ts) and the side panel. Pure. */

/** Collapse whitespace and clip. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

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
    case "task_complete": {
      // A long summary (an answer) is shown in the end card; the step stays one quiet line.
      const summary = String(a.summary ?? "");
      return isLongSummary(summary) ? "" : clip(summary, max);
    }
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

/** A task_end text that is really an answer: several lines, or longer than a one-line summary. */
export function isLongSummary(text: string): boolean {
  return text.includes("\n") || text.length > 160;
}
