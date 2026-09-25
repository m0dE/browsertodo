/** DOM for one Activity log entry (see event-format.ts for the pure view models). */
import type { SessionInfo } from "@browsertodo/shared";
import { h } from "./dom.js";
import type { EventView } from "./event-format.js";
import { sessionHeadline } from "./format.js";

/** onContinue: the run ended without finishing and can be continued (task_end cards). */
export function renderEvent(v: EventView, onContinue?: () => void): HTMLElement {
  switch (v.kind) {
    case "status":
      return h("div.ev-status", null, v.text);
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
        h("div", null, h("span.chip", { "data-tone": v.chip.tone }, v.chip.label), v.text ? ` ${v.text}` : ""),
        v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.url) : null,
        onContinue
          ? h(
              "div.ev-actions",
              null,
              h("button.primary.small.ev-continue", { type: "button", title: "Tell the agent to go on (or type a note in the box below)", onclick: () => onContinue() }, "Continue"),
            )
          : null,
      );
    case "error":
      return h("div.ev-error", null, v.text);
  }
}

/** The line at the top of a conversation: which brain and model, Jev on or off. */
export function renderSessionHead(s: SessionInfo): HTMLElement {
  return h("div.ev-head", { title: "The agent that runs this conversation" }, sessionHeadline(s));
}
