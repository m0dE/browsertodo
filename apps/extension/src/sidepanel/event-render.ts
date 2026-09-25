/** DOM for one conversation log entry (Chat and the Activity Log) (see event-format.ts for the pure view models). */
import { TASK_END_TOOLS, type SessionInfo } from "@browsertodo/shared";
import { h } from "./dom.js";
import type { EventView } from "./event-format.js";
import { chipHint, sessionHeadline } from "./format.js";
import { MarkdownView } from "./markdown.js";

let topupUrl: string | null = null;

/** Where "Top up" on an "Out of usage credit" end card goes (the account's top-up page). */
export function setTopupUrl(url: string | null): void {
  topupUrl = url;
}

/** The hosted AI refused the run for lack of credit (core's OUT_OF_CREDIT reason). */
const isOutOfCredit = (text: string | undefined) => !!text && /^Out of usage credit\b/.test(text);

/** onContinue: the run ended without finishing and can be continued (task_end cards). */
export function renderEvent(v: EventView, onContinue?: () => void): HTMLElement {
  switch (v.kind) {
    case "status":
      // The end-of-turn picks line is shown in the end card.
      return v.picks ? h("div.ev-status", { hidden: true }, v.text) : h("div.ev-status", null, v.text);
    case "text":
      return renderText(v.text, v.id);
    case "tool":
      // Every tool call is Claude's decision; Jev's own decisions show as Jev lines below it.
      return h("div.ev-tool", { title: `Claude chose: ${v.name} ${v.args}` }, h("b", null, v.name), v.args ? ` ${v.args}` : "");
    case "result": {
      const cls = v.isError ? "err" : "";
      // Long results collapse behind their preview; short ones are just the line.
      const wrap = h(
        "div",
        null,
        v.full && v.full !== v.preview
          ? h("details.ev-result", { class: cls }, h("summary", null, v.preview), h("pre", null, v.full))
          : h("div.ev-result", { class: cls }, h("div.line", null, v.preview)),
      );
      if (v.thumbnail) {
        const img = h("img.thumb", { src: `data:image/jpeg;base64,${v.thumbnail}`, alt: "screenshot", loading: "lazy" });
        img.addEventListener("click", () => img.classList.toggle("big"));
        wrap.append(img);
      }
      return wrap;
    }
    case "jev":
      return h(
        "div.ev-jev",
        { title: v.title },
        h("span.chip", { "data-tone": v.executed ? "accent" : "muted" }, v.label),
        h("span.ms", null, `${v.ms} ms`),
      );
    case "user":
      return h("div.ev-user", null, v.text);
    case "end":
      return h(
        "div.ev-end",
        null,
        // A long text is an answer: it reads as a message, and the outcome line under it stays short.
        v.long ? renderText(v.text) : null,
        h(
          "div.ev-outcome",
          null,
          h("span.chip", { "data-tone": v.chip.tone, title: chipHint(v.chip.label) || null }, v.chip.label),
          v.text && !v.long ? h("span.ev-summary", { title: v.text }, v.text) : null,
        ),
        v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.url) : null,
        v.picks
          ? h("div.ev-picks", { title: "Who chose the element for each click and typing step: Jev (the fast picker), or Claude when Jev was unsure" }, v.picks)
          : null,
        isOutOfCredit(v.text) && topupUrl
          ? h("a.ev-topup", { href: topupUrl, target: "_blank", rel: "noopener", title: "Buy usage credit, then continue" }, "Top up")
          : null,
        onContinue
          ? h(
              "div.ev-actions",
              null,
              h("button.primary.small.ev-continue", { type: "button", title: "Go on from where it stopped (anything typed in the box below is sent along)", onclick: () => onContinue() }, "Continue"),
            )
          : null,
      );
    case "error":
      return h("div.ev-error", null, v.text);
  }
}

/** Claude's text as Markdown. `id`: the streamed block it is (the chat updates it in place). */
export function renderText(text: string, id?: string): HTMLElement {
  const el = h("div.ev-text.md", id ? { "data-stream": id } : null);
  new MarkdownView(el).update(text);
  return el;
}

/** Tool calls and what goes with them: grouped, and folded once a run of them gets long. */
const STEP_KINDS = new Set<EventView["kind"]>(["tool", "result", "jev", "status"]);
/** A group with this many tool calls folds to its summary line. */
export const FOLD_STEPS = 3;

/**
 * Appends an event's element to a conversation log. Tool calls, results,
 * Jev lines and status lines in a row go into one steps group; the group
 * folds to "N steps" once it has FOLD_STEPS tool calls, unless the user
 * opened it.
 */
export function placeEvent(log: HTMLElement, node: HTMLElement, v: EventView): void {
  if (!STEP_KINDS.has(v.kind)) {
    log.append(node);
    return;
  }
  let group = log.lastElementChild as HTMLElement | null;
  if (!group?.classList.contains("ev-steps")) {
    group = newStepsGroup();
    log.append(group);
  }
  // The task_* call and its result say what the end card below says: kept, but not shown or counted.
  const ending = (v.kind === "tool" || v.kind === "result") && (TASK_END_TOOLS as readonly string[]).includes(v.name);
  if (ending) node.hidden = true;
  group.querySelector(":scope > .ev-steps-body")!.append(node);
  if (v.kind === "tool" && !ending) updateStepsGroup(group as HTMLDetailsElement, v.name);
}

function newStepsGroup(): HTMLDetailsElement {
  const d = h(
    "details.ev-steps.few",
    { open: true },
    h("summary", { title: "Show or hide the steps" }, h("span.ev-steps-count", null, ""), h("span.ev-steps-last", null, "")),
    h("div.ev-steps-body"),
  );
  d.dataset.steps = "0";
  // Once the user opens or closes it, it stays that way.
  d.querySelector("summary")!.addEventListener("click", () => (d.dataset.user = "1"));
  return d;
}

function updateStepsGroup(d: HTMLDetailsElement, last: string): void {
  const n = Number(d.dataset.steps ?? "0") + 1;
  d.dataset.steps = String(n);
  d.querySelector(".ev-steps-count")!.textContent = `${n} steps`;
  d.querySelector(".ev-steps-last")!.textContent = last;
  if (n >= FOLD_STEPS && d.classList.contains("few")) {
    d.classList.remove("few");
    if (!d.dataset.user) d.open = false;
  }
}

/** The line at the top of a conversation: which brain and model, Jev on or off. */
export function renderSessionHead(s: SessionInfo): HTMLElement {
  return h(
    "div.ev-head",
    { title: "The agent behind this conversation: brain · model · Jev (a faster helper for simple clicks and typing)" },
    sessionHeadline(s),
  );
}

/** Continue belongs to the conversation's last turn only, and only when that turn ended the thread. */
export function pruneContinue(log: HTMLElement): void {
  const cards = [...log.querySelectorAll(".ev-actions")];
  for (const c of cards.slice(0, -1)) c.remove();
  if (log.lastElementChild && !log.lastElementChild.classList.contains("ev-end")) cards.at(-1)?.remove();
}

