/** Chats running in other browser tabs: one chip each under the Chat action bar; picking one switches to its tab. */
import type { SessionInfo } from "@browsertodo/shared";
import { h } from "./dom.js";

export function renderSwitcher(
  el: HTMLElement,
  running: readonly SessionInfo[],
  watchedId: string | undefined,
  onWatch: (s: SessionInfo) => void,
): void {
  el.replaceChildren(
    h("span.act-switch-label", null, running.length > 1 ? "Other tabs" : "Other tab"),
    ...running.map((s) =>
      h(
        "button.act-chip",
        {
          type: "button",
          title: `${s.title}
Running in another tab: click to switch to it`,
          "aria-pressed": String(s.sessionId === watchedId),
          "data-id": s.sessionId,
          onclick: () => onWatch(s),
        },
        h("span.live-dot"),
        h("span.act-chip-text", null, s.title),
      ),
    ),
  );
}
