/**
 * chrome.debugger wrapper for the agent tab. Reattaches once on the next send
 * after an unexpected detach; a detach by the user (infobar "Cancel") is final
 * until reset() is called for the next task.
 */
export class Cdp {
  private tabId: number | null = null;
  private attached = false;
  private canceledByUser = false;
  /** Called when the user cancels debugging from Chrome's infobar. */
  onUserCancel: (() => void) | null = null;

  get attachedTabId(): number | null {
    return this.attached ? this.tabId : null;
  }

  async attach(tabId: number): Promise<void> {
    if (this.canceledByUser) throw new Error("debugger detached by user");
    if (this.attached && this.tabId === tabId) return;
    if (this.attached && this.tabId !== null) await this.detach();
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      // Left over from a previous service worker lifetime: detach and retry once.
      if (!/already attached/i.test(String(err instanceof Error ? err.message : err))) throw err;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, "1.3");
    }
    this.tabId = tabId;
    this.attached = true;
    // Let pages behave as focused even when the agent tab is in the background.
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  async send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.canceledByUser) throw new Error("debugger detached by user");
    if (this.tabId === null) throw new Error("debugger is not attached");
    if (!this.attached) await this.attach(this.tabId);
    return (await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params)) as T;
  }

  async detach(): Promise<void> {
    const tabId = this.tabId;
    this.attached = false;
    if (tabId !== null) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  /** chrome.debugger.onDetach handler. */
  handleDetach(source: { tabId?: number }, reason: string): void {
    if (source.tabId === undefined || source.tabId !== this.tabId) return;
    this.attached = false;
    if (reason === "canceled_by_user") {
      this.canceledByUser = true;
      this.onUserCancel?.();
    }
  }

  /** Clear a user cancel before the next task. */
  reset(): void {
    this.canceledByUser = false;
  }
}
