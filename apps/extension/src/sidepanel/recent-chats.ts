/**
 * The new chat's recent chats: while a tab has no chat, the few most recent conversations sit above the box, so
 * the user can go on with one (running ones first). Each row: its title, when it last ran, how it ended and the
 * site it ended on; picking one opens it here (sidepanel.ts openHere: a running chat of another tab is switched
 * to, any other is bound to this tab), See all opens History. Titles are the chats' own (chat-titles.ts); a chat
 * still titled with its request gets one in the background when listed (the router asks for it).
 */
import { chipHint, formatRelative, isChatSession, type Chip, type SessionInfo } from "@browsertodo/shared";
import { uiRequest } from "../ui-protocol.js";
import { h } from "../ui/dom.js";
import { outcomeChip } from "./format.js";

/** How many recent chats the new chat offers. */
export const RECENT_CHATS_SHOWN = 6;

export interface RecentChat {
  session: SessionInfo;
  title: string;
  /** "5 min ago"; "now" while it runs. */
  when: string;
  chip: Chip;
  /** The site its latest turn ended on ("x.com"), or where it runs; "" when unknown. */
  where: string;
  running: boolean;
}

/** The site of an address, without "www."; "" when it has none. */
function siteOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/**
 * The rows: running chats first (as the runner has them now), then the rest newest first, at most `limit`. A chat
 * not running and never ended (its worker stopped) shows as stopped.
 */
export function recentChatsView(sessions: readonly SessionInfo[], running: readonly SessionInfo[], now = Date.now(), limit = RECENT_CHATS_SHOWN): RecentChat[] {
  const live = new Map(running.filter(isChatSession).map((s) => [s.sessionId, s]));
  const rows = sessions.map((listed): RecentChat => {
    const s = live.get(listed.sessionId) ?? listed;
    const isRunning = live.has(s.sessionId);
    return {
      session: s,
      title: s.title.trim() || "Look at this page",
      when: isRunning ? "now" : formatRelative(s.endedAt ?? s.startedAt, now),
      chip: isRunning ? outcomeChip(undefined) : outcomeChip(s.outcome ?? "stopped"),
      where: isRunning ? "another tab" : siteOf(s.url),
      running: isRunning,
    };
  });
  const at = (r: RecentChat) => r.session.endedAt ?? r.session.startedAt;
  rows.sort((a, b) => Number(b.running) - Number(a.running) || (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  return rows.slice(0, limit);
}

export interface RecentChatsDeps {
  /** A chat was picked: go on with it here. */
  onOpen(session: SessionInfo): void;
  /** See all: the History tab. */
  onSeeAll(): void;
}

export interface RecentChats {
  /** The list (the new chat shows it under its title; hidden while there is nothing to offer). */
  readonly el: HTMLElement;
  /** Reload the list (the new chat is shown). */
  refresh(): void;
  /** The running sessions changed. */
  setRunning(sessions: readonly SessionInfo[]): void;
  /** A session changed (a title was written, a turn ended): the list follows while it is on screen. */
  onSession(session: SessionInfo): void;
}

/** Up and Down move between the rows, Home and End to the first and last. */
function moveFocus(list: HTMLElement, e: KeyboardEvent): void {
  const rows = [...list.querySelectorAll<HTMLButtonElement>("button.recent-row")];
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : null;
  if (to === null || !rows[to]) return;
  e.preventDefault();
  rows[to].focus();
}

function row(r: RecentChat, onOpen: (s: SessionInfo) => void): HTMLLIElement {
  const label = `${r.title}, ${r.chip.label}, ${r.when}${r.where ? `, ${r.where}` : ""}`;
  return h(
    "li",
    null,
    h(
      "button.recent-row",
      { type: "button", "data-id": r.session.sessionId, "aria-label": label, title: r.running ? "Running in another tab: switch to it" : "Go on with this chat here", onclick: () => onOpen(r.session) },
      h("span.recent-title", null, r.title),
      h("span.recent-when", null, r.when),
      h(
        "span.recent-meta",
        null,
        h("span.chip", { "data-tone": r.chip.tone, title: chipHint(r.chip.label) || r.chip.label }, r.chip.label),
        r.where ? h("span.recent-where", null, r.where) : null,
      ),
    ),
  );
}

export function initRecentChats(deps: RecentChatsDeps): RecentChats {
  const list = h("ul.recent-list", { "aria-labelledby": "recent-chats-title" });
  list.addEventListener("keydown", moveFocus.bind(null, list));
  const el = h(
    "section.recent-chats",
    { "aria-labelledby": "recent-chats-title", hidden: true },
    h(
      "div.recent-head",
      null,
      h("h2.recent-heading", { id: "recent-chats-title" }, "Recent chats"),
      h("button.link.recent-all", { type: "button", title: "Every chat and run, in History", onclick: () => deps.onSeeAll() }, "See all"),
    ),
    list,
  );
  let sessions: SessionInfo[] = [];
  let running: readonly SessionInfo[] = [];
  let loading = 0;

  function render(): void {
    const rows = recentChatsView(sessions, running);
    list.replaceChildren(...rows.map((r) => row(r, deps.onOpen)));
    el.hidden = !rows.length;
  }

  async function load(): Promise<void> {
    const ticket = ++loading;
    try {
      // A few more than shown: running chats of other tabs may be older than the newest ended ones.
      const r = await uiRequest({ type: "sessions.list", chats: true, limit: RECENT_CHATS_SHOWN * 2 });
      if (ticket !== loading) return;
      sessions = r.sessions;
      render();
    } catch (err) {
      // The new chat still works without its list.
      console.warn("[browsertodo] recent chats not loaded:", err);
    }
  }

  return {
    el,
    refresh() {
      void load();
    },
    setRunning(all) {
      const next = all.filter(isChatSession);
      const changed = next.length !== running.length || next.some((s, i) => s.sessionId !== running[i]?.sessionId);
      running = next;
      if (!el.isConnected) return;
      // A chat that started or ended moves in the list; one not listed yet is loaded.
      if (changed && next.some((s) => !sessions.some((x) => x.sessionId === s.sessionId))) void load();
      else if (changed) render();
    },
    onSession(s) {
      if (!el.isConnected || !isChatSession(s)) return;
      const i = sessions.findIndex((x) => x.sessionId === s.sessionId);
      if (i < 0) return void load();
      sessions = sessions.map((x) => (x.sessionId === s.sessionId ? s : x));
      render();
    },
  };
}
