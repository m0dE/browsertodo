/**
 * A chat per browser tab: which conversation the Chat tab shows for the
 * panel's tab (its own tab, or the active tab of its window for the panel
 * page opened as a tab), and where another conversation lives. Pure.
 */
import type { SessionInfo } from "@browsertodo/shared";

/** The parts of UiState this uses. */
export interface TabChatState {
  /** tab id -> the conversation that belongs to it. */
  tabChats?: Record<string, string>;
  /** running session id -> the tabs it acts in. */
  runningTabs?: Record<string, number[]>;
}

/** What the panel knows that the background may not have pushed yet. */
export interface TabChatLocal {
  /** A conversation just started from this tab (until the state shows it bound). */
  pending?: { tab: number; sessionId: string } | null;
  /** Running sessions the user left with New chat in a tab they act in (not bound to it). */
  left?: ReadonlyMap<number, string>;
}

/**
 * The conversation of a browser tab: the one bound to it, else one just
 * started there, else a running session acting in it (a scheduled run, an
 * agent's extra tab). Null: an empty new chat.
 */
export function chatForTab(tab: number | null, s: TabChatState, local: TabChatLocal = {}): string | null {
  if (tab === null) return null;
  const bound = s.tabChats?.[String(tab)];
  if (bound) return bound;
  const p = local.pending;
  if (p && p.tab === tab && !isBound(p.sessionId, s)) return p.sessionId;
  for (const [sessionId, tabs] of Object.entries(s.runningTabs ?? {})) {
    if (tabs.includes(tab) && local.left?.get(tab) !== sessionId && !isBound(sessionId, s)) return sessionId;
  }
  return null;
}

/**
 * The tab whose chat a tab's own side panel shows (see panel-tabs.ts), given the new state: `chatTab`, the one it
 * shows now, until the agent moves the chat shown (`shown`) to a tab it works in (a chat whose tab shows a
 * chrome:// page goes on in a new tab beside it): then that tab, so the panel keeps its conversation. The agent's
 * doing: the chat runs in that tab, or it is the one last sent to from here (`sent`: a quick turn may be over by
 * the time the state shows the move). A chat the user moved elsewhere is not followed.
 */
export function followChat(chatTab: number, shown: string | null, s: TabChatState, sent: { tab: number; sessionId: string } | null = null): number {
  if (!shown || s.tabChats?.[String(chatTab)]) return chatTab;
  const sentHere = sent?.sessionId === shown && sent.tab === chatTab;
  for (const [tab, id] of Object.entries(s.tabChats ?? {})) {
    if (id === shown && (sentHere || s.runningTabs?.[shown]?.includes(Number(tab)))) return Number(tab);
  }
  return chatTab;
}

/** The session is bound to some tab. */
export function isBound(sessionId: string, s: TabChatState): boolean {
  return Object.values(s.tabChats ?? {}).includes(sessionId);
}

/** The tab a conversation lives in: the tab it belongs to, else the tab it runs in. */
export function tabOfSession(sessionId: string, s: TabChatState): number | null {
  for (const [tab, id] of Object.entries(s.tabChats ?? {})) if (id === sessionId) return Number(tab);
  return s.runningTabs?.[sessionId]?.[0] ?? null;
}

/** The running conversations of other tabs (the switcher's chips): every running session but the one shown. */
export function otherRunning(running: readonly SessionInfo[], shownId: string | null): SessionInfo[] {
  return running.filter((s) => s.sessionId !== shownId);
}
