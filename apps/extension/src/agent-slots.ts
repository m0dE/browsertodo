/**
 * Agent slots: runs that happen at the same time each act in their own tab.
 * A slot is an AgentTab (its tabs in the browsertodo group) plus a Driver on
 * the shared debugger. The runner takes a slot for a session and gives it
 * back when the turn ends; browser calls from the helper name their session
 * (BrowserCallContext) and are served by that session's slot.
 */
import type { BrowserCaller } from "@browsertodo/core";
import type { Screenshot } from "@browsertodo/shared";
import { AgentTab, type TabMode } from "./agent-tab.js";
import type { Cdp } from "./cdp.js";
import { Driver } from "./driver.js";
import { createBrowserCaller, type VaultLike } from "./engine/browser-caller.js";
import { isRestrictedError } from "./restricted.js";

/** What the runner needs of a slot (see RunnerDeps.slots). */
export interface AgentSlot {
  readonly index: number;
  /**
   * Picks the slot's main tab for a run and attaches the debugger (see
   * AgentTab.prepare). tabId: with mode current-tab, the tab the run belongs
   * to. Returns the tab picked.
   */
  prepare(opts: { mode?: TabMode; tabId?: number }): Promise<number>;
  /** Browser calls in this slot's tabs (the Claude API brain, post verification). */
  readonly browser: BrowserCaller;
  isAgentTab(tabId: number): Promise<boolean>;
  screenshot(): Promise<Screenshot>;
}

/** Agent slots (tabs) in use at most: maxParallelTasks due tasks plus one-off runs beside them. */
export const MAX_SLOTS = 6;

export interface SlotPool {
  /** How many slots there are (indexes 0 .. size - 1). */
  readonly size: number;
  /** The slot with this index, now used by this session (its browser calls go there). */
  take(index: number, sessionId: string): AgentSlot;
  /** The session's turn ended: its browser calls are refused, tabs it opened are closed. */
  release(index: number, sessionId: string): void;
}

interface Slot extends AgentSlot {
  tab: AgentTab;
  driver: Driver;
  /** The session using the slot right now. */
  sessionId: string | null;
}

export class AgentSlots implements SlotPool {
  readonly size = MAX_SLOTS;
  private readonly slots = new Map<number, Slot>();

  constructor(
    private readonly cdp: Cdp,
    private readonly vault: VaultLike,
    /** Tabs that belong to a conversation: scheduled runs do not take them over. */
    private readonly isChatTab?: (tabId: number) => Promise<boolean>,
  ) {}

  /** Slot n, created on first use. Slot 0 is the first agent tab. */
  get(index: number): Slot {
    let s = this.slots.get(index);
    if (s) return s;
    const isChatTab = this.isChatTab;
    const tab = new AgentTab(index, { isTaken: (tabId) => this.takenByOther(index, tabId), ...(isChatTab ? { isChatTab } : {}) });
    const driver = new Driver(this.cdp, tab, { knownTabs: () => this.allTabIds() });
    const cdp = this.cdp;
    s = {
      index,
      tab,
      driver,
      sessionId: null,
      browser: createBrowserCaller(driver, this.vault),
      async prepare(opts) {
        cdp.reset();
        // The run's tab is picked once; the driver keeps using it for the whole turn.
        const tabId = await tab.prepare(opts.mode ?? "own-tab", opts.tabId === undefined ? {} : { tabId: opts.tabId });
        // Never brought to the front: the user may be using another tab (only "Show Tab" does that).
        // A page Chrome keeps extensions out of does not end the run: its tools say so, other tabs work.
        await driver.ready().catch((err: unknown) => {
          if (!isRestrictedError(err)) throw err;
        });
        return tabId;
      },
      isAgentTab: (tabId) => tab.isAgentTab(tabId),
      screenshot: () => driver.screenshot(),
    };
    this.slots.set(index, s);
    return s;
  }

  take(index: number, sessionId: string): AgentSlot {
    const s = this.get(index);
    s.sessionId = sessionId;
    return s;
  }

  release(index: number, sessionId: string): void {
    const s = this.slots.get(index);
    if (!s || s.sessionId !== sessionId) return;
    s.sessionId = null;
    // Tabs the agent opened with open_tabs go away with the turn; the main tab stays for the next one.
    void s.driver.closeOpenedTabs().catch(() => 0);
  }

  /**
   * Where a helper browser call goes: the slot of the session that made it.
   * No session (mcp-server --attach): the first agent tab. A session without
   * a slot (its turn ended) is refused.
   */
  browserFor(sessionId: string | undefined): BrowserCaller {
    if (!sessionId) return this.get(0).browser;
    const slot = this.slotUsedBy(sessionId);
    if (slot) return slot.browser;
    throw new Error("This task session has no browser tab right now (its turn has ended). Stop and wait for the user's next message.");
  }

  /** The slot a session uses right now, if any. */
  slotOf(sessionId: string): number | null {
    return this.slotUsedBy(sessionId)?.index ?? null;
  }

  /** Brings the session's tab to the front (default: the first agent tab). */
  async show(sessionId?: string): Promise<boolean> {
    const index = (sessionId && this.slotOf(sessionId)) || 0;
    return this.get(index).tab.show();
  }

  /** The tabs a running session acts in (its main tab first), or none. */
  async tabsOf(sessionId: string): Promise<number[]> {
    return (await this.slotUsedBy(sessionId)?.tab.tabIds()) ?? [];
  }

  /** Every tab of every slot. */
  async allTabIds(): Promise<number[]> {
    const ids = await Promise.all([...this.slots.values()].map((s) => s.tab.tabIds()));
    return ids.flat();
  }

  private slotUsedBy(sessionId: string): Slot | undefined {
    for (const s of this.slots.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  private async takenByOther(index: number, tabId: number): Promise<boolean> {
    for (const s of this.slots.values()) {
      if (s.index === index || s.sessionId === null) continue;
      if (await s.tab.isAgentTab(tabId)) return true;
    }
    return false;
  }
}
