/**
 * Activity log tab: every run, newest first. Picking one opens that
 * conversation in Chat (its steps, its end card and Continue): a running one
 * in the tab it runs in, a finished one bound to the tab the panel shows.
 */
import { chipHint, errorMessage, type SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { $, h } from "../ui/dom.js";
import { clockLabel, outcomeChip } from "./format.js";
import { brainLabel } from "../ui/labels.js";

/** The list shows this many runs, newest first. */
const RUNS_SHOWN = 30;

export interface HistoryView {
  /** The tab was opened: reload the list. */
  refresh(): void;
  /** A session changed: the list follows while it is on screen. */
  onSession(session: SessionInfo): void;
}

function historyRow(s: SessionInfo, onOpen: (s: SessionInfo) => void): HTMLLIElement {
  const chip = outcomeChip(s.endedAt ? s.outcome : undefined);
  const turns = (s.turns ?? 1) > 1 ? ` · ${s.turns} messages` : "";
  return h(
    "li",
    null,
    h(
      "button",
      { type: "button", "data-id": s.sessionId, title: "Open this conversation in Chat", onclick: () => onOpen(s) },
      h("span.chip", { "data-tone": chip.tone, title: chipHint(chip.label) || null }, chip.label),
      h(
        "span.s-main",
        null,
        h("div.s-title", null, s.title),
        h("div.meta", null, `${clockLabel(s.startedAt)} · ${brainLabel(s.brain, s.jev)}${s.source === "adhoc" ? " · one-off" : ""}${turns}`),
      ),
    ),
  );
}

export function initHistory(opts: {
  /** Show this conversation in Chat. */
  onOpenInChat(session: SessionInfo): void;
}): HistoryView {
  const listView = $("hist-list");
  const ul = $("history-list");
  const empty = $("history-empty");
  let loading = 0;

  async function loadList(): Promise<void> {
    const ticket = ++loading;
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: RUNS_SHOWN });
      if (ticket !== loading) return;
      ul.replaceChildren(...sessions.map((s) => historyRow(s, opts.onOpenInChat)));
      empty.hidden = sessions.length > 0;
    } catch (err) {
      ul.replaceChildren(h("li.ev-error", null, errorMessage(err)));
    }
  }

  return {
    refresh() {
      void loadList();
    },
    onSession() {
      if (listView.offsetParent) void loadList();
    },
  };
}
