/**
 * The browser tab a hands-free session belongs to. Each tab has its own side
 * panel, showing that tab's chat (Chrome hides it on other tabs and keeps its
 * page running); the panel page opened as a tab follows its window's
 * active tab instead. A session stays with the tab it started in: what is
 * said goes to its chat and its answers are narrated from there, whichever
 * tab the panel shows. On another tab the voice bar
 * says where it listens, with Go to tab and Use this tab (the only way to move
 * it); the voice key and the mic always end a session that is on, wherever
 * it listens. Closing its tab ends it. Pure.
 */

/** What the voice shortcut (or the mic) does to hands-free voice: start one, or end the one that is on. */
export type VoiceKeyAction = "start" | "stop";

/** `on`: a session is on in this panel (its own state; which tab it listens in does not matter). */
export function voiceKeyAction(on: boolean): VoiceKeyAction {
  return on ? "stop" : "start";
}

/**
 * The tabs a session is at home in: the tab it started in (or was moved to), and every tab its chat lived in
 * during the session (a run started from an extension page works in a tab of its own). The voice bar is the plain
 * one there, and names where it listens elsewhere.
 */
export type SessionTabs = ReadonlySet<number>;

/** The session belongs to tabs other than the one shown (tabs not known: it is here). */
export function listensElsewhere(sessionTabs: SessionTabs, shown: number | null): boolean {
  return sessionTabs.size > 0 && shown !== null && !sessionTabs.has(shown);
}

/** A closed tab ends the session when it was the one the session started in (or was moved to). */
export function endsWithTab(sessionTab: number | null, closed: number): boolean {
  return sessionTab === closed;
}

/** A tab's title in the voice bar is cut to this many characters. */
export const TAB_TITLE_CHARS = 28;

/** The voice bar's words on another tab: where the session listens ("Hands-free on in Inbox – Gmail"). */
export function elsewhereLabel(title: string | null): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  const shown = !t ? "another tab" : t.length > TAB_TITLE_CHARS ? `${t.slice(0, TAB_TITLE_CHARS - 1).trimEnd()}…` : t;
  return `Hands-free on in ${shown}`;
}

export const MOVED_NOTE = "Hands-free moved to this tab.";
export const TAB_CLOSED_NOTE = "Hands-free stopped: its tab was closed.";
