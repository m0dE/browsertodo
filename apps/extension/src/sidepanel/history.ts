/**
 * History tab: every run, newest first. Picking one opens that
 * conversation in Chat (its steps, its end card and Continue): a running one
 * in the tab it runs in, a finished one bound to the tab the panel shows.
 * A chat can be renamed in place (the pencil): the user's name is kept, the
 * title model never replaces it (chat-titles.ts).
 */
import { chipHint, errorMessage, MAX_CHAT_TITLE_CHARS, type SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { $, h, showError } from "../ui/dom.js";
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

function pencil(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L6 12.1l-3 .8.8-3z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/**
 * A text box takes the row's place: Enter or leaving it saves (an unchanged or empty name keeps the title), Escape
 * puts the row back. A refused name says why above the list.
 */
function startRename(li: HTMLLIElement, s: SessionInfo, say: (err: unknown) => void): void {
  const open = li.querySelector<HTMLButtonElement>("button.s-open");
  const title = open?.querySelector<HTMLElement>(".s-title");
  if (!open || !title || li.querySelector(".s-rename-box")) return;
  const box = h("input.s-rename-box", { type: "text", value: s.title, "aria-label": "Chat name", maxlength: MAX_CHAT_TITLE_CHARS, spellcheck: "false" });
  let done = false;
  const finish = async (save: boolean, refocus = true) => {
    if (done) return;
    done = true;
    const name = box.value.trim();
    box.remove();
    open.hidden = false;
    // By keyboard the focus goes back to the row; a click elsewhere keeps it where it went.
    if (refocus) open.focus();
    if (!save || !name || name === s.title) return;
    title.textContent = name;
    try {
      await uiRequest({ type: "session.rename", sessionId: s.sessionId, title: name });
    } catch (err) {
      title.textContent = s.title;
      say(err);
    }
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void finish(true);
    else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
  box.addEventListener("blur", () => void finish(true, false));
  open.hidden = true;
  li.prepend(box);
  box.focus();
  box.select();
}

function historyRow(s: SessionInfo, onOpen: (s: SessionInfo) => void, say: (err: unknown) => void): HTMLLIElement {
  const chip = outcomeChip(s.endedAt ? s.outcome : undefined);
  const turns = (s.turns ?? 1) > 1 ? ` · ${s.turns} messages` : "";
  const li = h(
    "li",
    null,
    h(
      "button.s-open",
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
  // A TODO run is named by its task; a chat can be renamed.
  if (s.source === "adhoc") {
    li.append(h("button.icon.s-rename", { type: "button", title: "Rename this chat", "aria-label": `Rename "${s.title}"`, onclick: () => startRename(li, s, say) }, pencil()));
  }
  return li;
}

export function initHistory(opts: {
  /** Show this conversation in Chat. */
  onOpenInChat(session: SessionInfo): void;
}): HistoryView {
  const listView = $("hist-list");
  const ul = $("history-list");
  const empty = $("history-empty");
  let loading = 0;
  const say = (err: unknown) => {
    const line = h("li.ev-error", { role: "alert" }, "");
    showError((m) => (line.textContent = `Not renamed: ${m}`), err);
    ul.prepend(line);
  };

  async function loadList(): Promise<void> {
    const ticket = ++loading;
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: RUNS_SHOWN });
      if (ticket !== loading) return;
      // A row being renamed stays as it is until its name is saved.
      if (ul.querySelector(".s-rename-box")) return;
      ul.replaceChildren(...sessions.map((s) => historyRow(s, opts.onOpenInChat, say)));
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
