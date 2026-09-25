/** Chats running in other browser tabs: one chip each under the Chat action bar; picking one switches to its tab. */
import type { SessionInfo } from "@browsertodo/shared";
import { h } from "../ui/dom.js";

export function renderSwitcher(el: HTMLElement, running: readonly SessionInfo[], onPick: (s: SessionInfo) => void): void {
  el.replaceChildren(
    h("span.act-switch-label", null, running.length > 1 ? "Other tabs" : "Other tab"),
    ...running.map((s) =>
      h(
        "button.act-chip",
        {
          type: "button",
          title: `${s.title}
Running in another tab: click to switch to it`,
          "data-id": s.sessionId,
          onclick: () => onPick(s),
        },
        h("span.live-dot"),
        h("span.act-chip-text", null, s.title),
      ),
    ),
  );
}
