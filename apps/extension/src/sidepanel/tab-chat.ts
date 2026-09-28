/**
 * A chat per browser tab: which conversation is the panel's tab's own (its own tab, or the active tab of its window
 * for the panel page opened as a tab), and where another conversation lives. Pure.
 */

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
}

/**
 * The conversation a panel that follows its window's active tab shows for tab `tab`: the tab's own, else a running
 * session acting in it that belongs to no tab (a scheduled run). Null: none (the list).
 */
export function chatInTab(tab: number | null, s: TabChatState, local: TabChatLocal = {}): string | null {
  const own = ownChatOfTab(tab, s, local);
  if (own || tab === null) return own;
  for (const [sessionId, tabs] of Object.entries(s.runningTabs ?? {})) if (tabs.includes(tab) && !isBound(sessionId, s)) return sessionId;
  return null;
}

/**
 * The conversation that is the tab's own: bound to it, or just started there. Never a running session that only
 * acts in the tab (a scheduled run, another chat's extra tab): the panel shows it when the tab's chat changes, and
 * hands-free voice talks to and narrates this one only.
 */
export function ownChatOfTab(tab: number | null, s: TabChatState, local: TabChatLocal = {}): string | null {
  if (tab === null) return null;
  const bound = s.tabChats?.[String(tab)];
  if (bound) return bound;
  const p = local.pending;
  if (p && p.tab === tab && !isBound(p.sessionId, s)) return p.sessionId;
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

/**
 * The tab to watch a conversation's agent in, unless the user already looks at it (`viewing`): while it runs, the tab
 * it acts on now; else the tab it belongs to. Null: none, or that is the tab the user sees.
 */
export function agentTabToView(sessionId: string | null, viewing: number | null, s: TabChatState): number | null {
  if (!sessionId) return null;
  const tab = s.runningTabs?.[sessionId]?.[0] ?? tabOfSession(sessionId, s);
  return tab === viewing ? null : tab;
}

/** The tab a conversation lives in: the tab it belongs to, else the tab it runs in. */
export function tabOfSession(sessionId: string, s: TabChatState): number | null {
  for (const [tab, id] of Object.entries(s.tabChats ?? {})) if (id === sessionId) return Number(tab);
  return s.runningTabs?.[sessionId]?.[0] ?? null;
}
