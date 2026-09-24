/**
 * Compact text form of a PageSnapshot, as returned to Claude by read_page,
 * and a parser for it (used by the ScriptedBrain, which only sees tool text).
 */
import type { ElementInfo, PageSnapshot } from "@browsertodo/shared";

export function formatElement(el: ElementInfo): string {
  const parts: string[] = [el.tag];
  if (el.type) parts.push(`type=${el.type}`);
  if (el.testId) parts.push(`testid=${el.testId}`);
  if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
  if (el.href) parts.push(`href=${el.href}`);
  if (el.disabled) parts.push("disabled");
  if (el.text) parts.push(`text=${JSON.stringify(el.text)}`);
  if (!el.inViewport) parts.push("offscreen");
  return `[${el.index}] ${el.role || el.tag} ${JSON.stringify(el.name ?? "")} (${parts.join(", ")})`;
}

export function formatElements(elements: ElementInfo[], truncated = false): string {
  const lines = elements.map(formatElement);
  if (truncated) lines.push("(element list truncated)");
  return lines.join("\n");
}

export function formatSnapshot(snap: PageSnapshot): string {
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    formatElements(snap.elements, snap.truncated),
    "--- visible text ---",
    snap.text,
  ].join("\n");
}

/** What the ScriptedBrain can recover from read_page text. */
export interface ParsedPage {
  url: string;
  title: string;
  text: string;
  elements: Pick<ElementInfo, "index" | "role" | "name" | "tag" | "type" | "testId" | "disabled" | "href">[];
}

const ELEMENT_LINE = /^\[(\d+)\] (\S+) ("(?:[^"\\]|\\.)*") \((.*)\)$/;

export function parseSnapshotText(text: string): ParsedPage {
  const page: ParsedPage = { url: "", title: "", text: "", elements: [] };
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "--- visible text ---") {
      page.text = lines.slice(i + 1).join("\n");
      break;
    }
    if (line.startsWith("URL: ")) page.url = line.slice(5);
    else if (line.startsWith("Title: ")) page.title = line.slice(7);
    else {
      const m = ELEMENT_LINE.exec(line);
      if (!m) continue;
      const parts = m[4]!.split(", ");
      const el: ParsedPage["elements"][number] = {
        index: Number(m[1]),
        role: m[2]!,
        name: JSON.parse(m[3]!) as string,
        tag: parts[0] ?? "",
      };
      for (const p of parts.slice(1)) {
        if (p.startsWith("type=")) el.type = p.slice(5);
        else if (p.startsWith("testid=")) el.testId = p.slice(7);
        else if (p.startsWith("href=")) el.href = p.slice(5);
        else if (p === "disabled") el.disabled = true;
      }
      page.elements.push(el);
    }
  }
  return page;
}
