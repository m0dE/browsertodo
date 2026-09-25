/** Activity's History list: recent runs, newest first; picking one opens it. */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { $, errorText, h } from "./dom.js";
import { brainLabel, clockLabel, outcomeChip } from "./format.js";

function historyRow(s: SessionInfo, onOpen: (s: SessionInfo) => void): HTMLLIElement {
  const chip = outcomeChip(s.endedAt ? s.outcome : undefined);
  const turns = (s.turns ?? 1) > 1 ? ` · ${s.turns} messages` : "";
  return h(
    "li",
    null,
    h(
      "button",
      { type: "button", onclick: () => onOpen(s) },
      h("span.chip", { "data-tone": chip.tone }, chip.label),
      h(
        "span.s-main",
        null,
        h("div.s-title", null, s.title),
        h("div.meta", null, `${clockLabel(s.startedAt)} · ${brainLabel(s.brain, s.jev)}${s.source === "adhoc" ? " · one-off" : ""}${turns}`),
      ),
    ),
  );
}

/** Fetch the latest runs into #history-list. */
export async function loadHistory(onOpen: (s: SessionInfo) => void): Promise<void> {
  const ul = $("history-list");
  try {
    const { sessions } = await uiRequest({ type: "sessions.list", limit: 30 });
    ul.replaceChildren(...sessions.map((s) => historyRow(s, onOpen)));
    $("history-empty").hidden = sessions.length > 0;
  } catch (err) {
    ul.replaceChildren(h("li.ev-error", null, errorText(err)));
  }
}
