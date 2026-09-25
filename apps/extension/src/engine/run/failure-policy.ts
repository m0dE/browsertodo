/**
 * What a scheduled run's end means for the due loop: failures in a row are
 * counted and pause scheduled runs at maxConsecutiveFailures; a task that
 * paused (it needs the user) is told about and ends the due run. Also the
 * user's own pause and resume of scheduled runs.
 */
import type { ExtensionSettings } from "@browsertodo/shared";
import type { Ended } from "./lifecycle.js";
import type { RunnerStateStore } from "./state.js";

export interface FailurePolicyDeps {
  state: RunnerStateStore;
  loadSettings(): Promise<ExtensionSettings>;
  saveSettings(patch: Partial<ExtensionSettings>): Promise<unknown>;
  notify(title: string, message: string): void | Promise<void>;
  /** The user asked the due loop to stop. */
  stopping(): boolean;
}

export class FailurePolicy {
  /** Serializes the bookkeeping of parallel jobs. */
  private accounting: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: FailurePolicyDeps) {}

  /** Pauses scheduled runs; the reason shows in the side panel. */
  async pause(reason?: string): Promise<void> {
    await this.deps.saveSettings({ paused: true });
    await this.deps.state.patch({ pausedReason: reason });
  }

  async resume(): Promise<void> {
    await this.deps.saveSettings({ paused: false });
    await this.deps.state.patch({ pausedReason: undefined, consecutiveFailures: 0 });
  }

  /** After a scheduled run. True: start no more tasks in this due run. */
  afterScheduled({ result, stop }: Ended, settings: ExtensionSettings): Promise<boolean> {
    const next = this.accounting.then(async () => {
      const { state } = this.deps;
      if (result.outcome === "done") await state.patch({ consecutiveFailures: 0 });
      else if (result.outcome === "failed" || result.outcome === "retry") {
        const n = (await state.get()).consecutiveFailures + 1;
        await state.patch({ consecutiveFailures: n });
        const max = settings.maxConsecutiveFailures;
        if (max > 0 && n >= max) {
          if (!(await this.deps.loadSettings()).paused) {
            const reason = `Paused after ${n} failed tasks in a row. Last: ${result.reason ?? result.outcome}`;
            await this.pause(reason);
            await this.deps.notify("Runs paused", reason);
          }
          return true;
        }
      }
      // The user stopped it: nothing to tell them, and the other tasks go on.
      if (stop?.kind === "user-stop") return this.deps.stopping();
      if (result.outcome === "paused") {
        if (!this.deps.stopping()) await this.deps.notify("Task paused", result.reason ?? "The task needs your attention.");
        return true;
      }
      return false;
    });
    this.accounting = next.catch(() => {});
    return next;
  }
}
