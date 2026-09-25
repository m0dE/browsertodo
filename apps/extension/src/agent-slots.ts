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

/** What the runner needs of a slot (see RunnerDeps.slots). */
export interface AgentSlot {
  readonly index: number;
  /** Picks the slot's main tab for a run and attaches the debugger (see AgentTab.prepare). */
  prepare(opts: { show?: boolean; mode?: TabMode }): Promise<void>;
  /** Browser calls in this slot's tabs (the Claude API brain, post verification). */
  readonly browser: BrowserCaller;
  isAgentTab(tabId: number): Promise<boolean>;
  screenshot(): Promise<Screenshot>;
}

export interface SlotPool {
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
  private readonly slots = new Map<number, Slot>();

  constructor(
    private readonly cdp: Cdp,
    private readonly vault: VaultLike,
  ) {}

  /** Slot n, created on first use. Slot 0 is the first agent tab. */
  get(index: number): Slot {
    let s = this.slots.get(index);
    if (s) return s;
    const tab = new AgentTab(index, { isTaken: (tabId) => this.takenByOther(index, tabId) });
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
        await tab.prepare(opts.mode ?? "own-tab");
        await driver.ready();
        if (opts.show) await tab.show().catch(() => false);
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
