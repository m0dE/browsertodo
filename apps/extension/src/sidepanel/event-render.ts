/** DOM for one conversation log entry (Chat and the Activity Log) (see event-format.ts for the pure view models). */
import type { SessionInfo } from "@browsertodo/shared";
import { h } from "./dom.js";
import type { EventView } from "./event-format.js";
import { chipHint, sessionHeadline } from "./format.js";

let topupUrl: string | null = null;

/** Where "Top up" on an "Out of AI credit" end card goes (the account's top-up page). */
export function setTopupUrl(url: string | null): void {
  topupUrl = url;
}

/** The hosted AI refused the run for lack of credit (core's OUT_OF_CREDIT reason). */
const isOutOfCredit = (text: string | undefined) => !!text && /^Out of AI credit\b/.test(text);

/** onContinue: the run ended without finishing and can be continued (task_end cards). */
export function renderEvent(v: EventView, onContinue?: () => void): HTMLElement {
  switch (v.kind) {
    case "status":
      // The end-of-turn picks line is shown in the end card.
      return v.picks ? h("div.ev-status", { hidden: true }, v.text) : h("div.ev-status", null, v.text);
    case "text":
      return h("p.ev-text", null, v.text);
    case "tool":
      // Every tool call is Claude's decision; Jev's own decisions show as Jev lines below it.
      return h("div.ev-tool", { title: `Claude chose: ${v.name} ${v.args}` }, h("span.who", null, "Claude"), h("b", null, v.name), v.args ? ` ${v.args}` : "");
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
        h("div", null, h("span.chip", { "data-tone": v.chip.tone, title: chipHint(v.chip.label) || null }, v.chip.label), v.text ? ` ${v.text}` : ""),
        v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.url) : null,
        v.picks
          ? h("div.ev-picks", { title: "Who chose the element for each click and typing step: Jev (the fast picker), or Claude when Jev was unsure" }, v.picks)
          : null,
        isOutOfCredit(v.text) && topupUrl
          ? h("a.ev-topup", { href: topupUrl, target: "_blank", rel: "noopener", title: "Buy AI credit, then continue" }, "Top up")
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
