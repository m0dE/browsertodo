/**
 * Activity Log tab: every run, newest first. Picking a finished one opens it
 * read-only here (with a way back to the list, its raw log, and "Open in
 * Chat" when the conversation can be continued); a running one opens in Chat.
 */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { canOpenInChat, chatActions } from "./chat-actions.js";
import { $, busy, errorText, h } from "./dom.js";
import { describeEvent, turnPicks } from "./event-format.js";
import { pruneContinue, renderEvent, renderSessionHead } from "./event-render.js";
import { brainLabel, chipHint, clockLabel, outcomeChip, sessionMeta } from "./format.js";
import { openRawLog } from "./raw-log.js";

export interface HistoryView {
  /** The tab was opened: reload the list (the open run stays open). */
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
      { type: "button", "data-id": s.sessionId, onclick: () => onOpen(s) },
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
  /** Show this conversation in Chat (a running one, "Open in Chat", or Continue in its end card). */
  onOpenInChat(session: SessionInfo): void;
  /** The open run's title was picked: show its task's details. */
  onDetails?(session: SessionInfo, trigger: HTMLElement): void;
}): HistoryView {
  const listView = $("hist-list");
  const ul = $("history-list");
  const empty = $("history-empty");
  const pastView = $("hist-past");
  const title = $<HTMLButtonElement>("hist-title");
  const meta = $("hist-meta");
  const log = $("hist-log");
  const back = $<HTMLButtonElement>("hist-back");
  const openBtn = $<HTMLButtonElement>("hist-open");
  const rawLog = $<HTMLButtonElement>("hist-rawlog");

  /** The run open read-only, or null for the list. */
  let open: SessionInfo | null = null;
  let loading = 0;

  async function loadList(): Promise<void> {
    const ticket = ++loading;
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: 30 });
      if (ticket !== loading) return;
      ul.replaceChildren(...sessions.map((s) => historyRow(s, pick)));
      empty.hidden = sessions.length > 0;
    } catch (err) {
      ul.replaceChildren(h("li.ev-error", null, errorText(err)));
    }
  }

  function showList(): void {
    open = null;
    pastView.hidden = true;
    listView.hidden = false;
    void loadList();
  }

  function header(s: SessionInfo): void {
    title.textContent = s.title;
    title.title = `${s.title}
Show the full ${s.source === "adhoc" ? "message" : "task"} and its details`;
    meta.textContent = sessionMeta(s);
    meta.title = brainLabel(s.brain, s.jev);
    openBtn.hidden = !canOpenInChat(s);
    rawLog.hidden = chatActions(s, new Set()).rawLog.disabled;
  }

  function renderLog(s: SessionInfo, events: StampedAgentEvent[]): void {
    const cont = (e: StampedAgentEvent) => e.type === "task_end" && isContinuableOutcome(e.outcome) && canOpenInChat(s);
    log.replaceChildren(
      renderSessionHead(s),
      ...events.map((e, i) =>
        renderEvent(describeEvent(e, e.type === "task_end" ? turnPicks(events, i) : undefined), cont(e) ? () => opts.onOpenInChat(s) : undefined),
      ),
    );
    if (!events.length) log.append(h("p.empty", null, "No events were recorded for this run."));
    pruneContinue(log);
    log.scrollTop = log.scrollHeight;
  }

  async function openPast(s: SessionInfo): Promise<void> {
    open = s;
    listView.hidden = true;
    pastView.hidden = false;
    header(s);
    log.replaceChildren(h("p.empty", null, "Loading…"));
    try {
      const res = await uiRequest({ type: "sessions.events", sessionId: s.sessionId });
      if (open?.sessionId !== s.sessionId) return;
      open = res.session ?? s;
      header(open);
      renderLog(open, res.events);
    } catch (err) {
      log.replaceChildren(h("p.ev-error", null, errorText(err)));
    }
  }

  /** A running conversation is watched in Chat; a finished one opens here. */
  function pick(s: SessionInfo): void {
    if (!s.endedAt) opts.onOpenInChat(s);
    else void openPast(s);
  }

  back.addEventListener("click", showList);
  title.addEventListener("click", () => {
    if (open) opts.onDetails?.(open, title);
  });
  openBtn.addEventListener("click", () => {
    if (open) opts.onOpenInChat(open);
  });
  rawLog.addEventListener("click", () => {
    const s = open;
    if (!s) return;
    void busy(rawLog, async () => {
      try {
        await openRawLog(s.sessionId);
      } catch (err) {
        log.append(h("p.ev-error", null, `Raw log: ${errorText(err)}`));
      }
    });
  });

  return {
    refresh() {
      if (!open) void loadList();
    },
    onSession(s) {
      if (!open && !listView.hidden && listView.offsetParent) void loadList();
      else if (open?.sessionId === s.sessionId) header(s);
    },
  };
}
