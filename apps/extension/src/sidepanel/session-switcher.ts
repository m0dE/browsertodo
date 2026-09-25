/** With several sessions running: one chip each in the Activity header, to pick which one to watch. */
import type { SessionInfo } from "@browsertodo/shared";
import { h } from "./dom.js";

export function renderSwitcher(
  el: HTMLElement,
  running: readonly SessionInfo[],
  watchedId: string | undefined,
  onWatch: (s: SessionInfo) => void,
): void {
  el.replaceChildren(
    ...running.map((s) =>
      h(
        "button.act-chip",
        { type: "button", title: s.title, "aria-pressed": String(s.sessionId === watchedId), "data-id": s.sessionId, onclick: () => onWatch(s) },
        h("span.live-dot"),
        h("span.act-chip-text", null, s.title),
      ),
    ),
  );
}
