/**
 * Compact text form of a PageSnapshot, as returned to the model by read_page,
 * and a parser for it (used by the helper's scripted brain, which only sees
 * tool text).
 */
import type { AgentTabInfo, ElementInfo, PageSnapshot } from "@browsertodo/shared";

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

/** Compact text form of a snapshot, as returned by read_page. */
export function formatSnapshot(snap: PageSnapshot): string {
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    formatElements(snap.elements, snap.truncated),
    "--- visible text ---",
    snap.text,
  ].join("\n");
}

/** URL, title and the element list, without the page text (used when act stops). */
export function formatCompact(snap: PageSnapshot): string {
  return [`URL: ${snap.url}`, `Title: ${snap.title}`, formatElements(snap.elements, snap.truncated)].join("\n");
}

/** Elements listed per tab when read_page reads several tabs (the full list is one switch_tab + read_page away). */
export const MULTI_TAB_ELEMENTS = 80;

/** One line per agent tab: "t2 (current) https://... "Title"". */
export function formatTabs(tabs: AgentTabInfo[]): string {
  if (!tabs.length) return "(no tabs)";
  return tabs
    .map((t) => `${t.id}${t.current ? " (current)" : ""} ${t.url} ${JSON.stringify(t.title)}${t.error ? ` [${t.error}]` : ""}`)
    .join("\n");
}

/** read_page with `tabs`: each tab's snapshot (or error) under its own header. */
export function formatTabSnapshots(reads: ({ tab: string; snap: PageSnapshot } | { tab: string; error: string })[]): string {
  return reads
    .map((r) => {
      const header = `===== Tab ${r.tab} =====`;
      if ("error" in r) return `${header}\nCould not read this tab: ${r.error}`;
      const { snap } = r;
      const extra = snap.elements.length - MULTI_TAB_ELEMENTS;
      if (extra <= 0) return `${header}\n${formatSnapshot(snap)}`;
      const note = `(${extra} more elements; switch_tab to ${r.tab} and call read_page for the full list)`;
      const body = [`URL: ${snap.url}`, `Title: ${snap.title}`, formatElements(snap.elements.slice(0, MULTI_TAB_ELEMENTS)), note, "--- visible text ---", snap.text];
      return `${header}\n${body.join("\n")}`;
    })
    .join("\n\n");
}

/** What a scripted brain can recover from read_page text. */
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
  for (let i = 0; i < lines.length; i++) {
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
