/**
 * Concurrency: which agent slot (tab) each session uses, the X turn, the
 * pause between task starts, and the "a job ended" signal the due loop waits
 * on.
 *
 * X tasks never run at the same time as another X task: every X account
 * shares one login session in the browser, so switching accounts in one tab
 * switches it in all of them.
 */
import { delay, type ExtensionSettings, type Sleep } from "@browsertodo/shared";

/** The most due tasks that run at once, whatever maxParallelTasks says. */
const MAX_PARALLEL_TASKS = 4;
export const X_WAIT_STATUS = "Waiting for the other X task to finish (X accounts share one login in this browser)";

/** How many due tasks may run at once (never more than there are slots). */
export function scheduledCap(settings: ExtensionSettings, slotCount: number): number {
  return Math.max(1, Math.min(MAX_PARALLEL_TASKS, slotCount, settings.maxParallelTasks));
}

/** Slot index -> the session using it (or a placeholder owner reserving it while the session starts). */
export class SlotTable {
  private readonly inUse = new Map<number, string>();
  /** The slot each conversation used last, so its next turn acts in the same tab. */
  private readonly last = new Map<string, number>();

  constructor(readonly count: number) {}

  /** A free slot: `preferred` when it is free, else the lowest free one. */
  free(preferred?: number): number | null {
    if (preferred !== undefined && preferred < this.count && !this.inUse.has(preferred)) return preferred;
    for (let i = 0; i < this.count; i++) if (!this.inUse.has(i)) return i;
    return null;
  }

  /** Takes a free slot for this owner right away (null: none free). */
  reserve(owner: string, preferred?: number): number | null {
    const i = this.free(preferred);
    if (i !== null) this.inUse.set(i, owner);
    return i;
  }

  /** The slot now belongs to this owner (e.g. the session a reservation was for). */
  assign(index: number, owner: string): void {
    this.inUse.set(index, owner);
  }

  /** Gives back a slot nothing ran in. */
  unassign(index: number): void {
    this.inUse.delete(index);
  }

  /** The session runs in this slot; its next turn prefers it. */
  bind(index: number, sessionId: string): void {
    this.inUse.set(index, sessionId);
    this.last.set(sessionId, index);
  }

  /** The session ended: frees its slot. Returns the index it held, or null. */
  release(sessionId: string): number | null {
    const index = this.last.get(sessionId);
    if (index === undefined || this.inUse.get(index) !== sessionId) return null;
    this.inUse.delete(index);
    return index;
  }

  lastOf(sessionId: string): number | undefined {
    return this.last.get(sessionId);
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}

/** The one session that may act as an X account right now; the others wait for it. */
export class XTurn {
  private holder: string | null = null;
  private waiters: (() => void)[] = [];

  get free(): boolean {
    return this.holder === null;
  }

  heldByOther(sessionId: string): boolean {
    return this.holder !== null && this.holder !== sessionId;
  }

  /** Takes the turn when nobody holds it. */
  tryTake(sessionId: string): void {
    if (this.holder === null) this.holder = sessionId;
  }

  take(sessionId: string): void {
    this.holder = sessionId;
  }

  /** Waits until no other session holds the turn, or until cancelled() (checked on every wake). */
  async waitFor(sessionId: string, cancelled: () => boolean): Promise<void> {
    while (this.heldByOther(sessionId) && !cancelled()) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  release(sessionId: string): void {
    if (this.holder !== sessionId) return;
    this.holder = null;
    this.wake();
  }

  /** Wakes every waiter to check again (the turn was freed, or a waiter was stopped). */
  wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

/** Resolves waiters on the next notify(). */
export class Signal {
  private waiters: (() => void)[] = [];

  wait(): Promise<void> {
    return new Promise<void>((r) => this.waiters.push(r));
  }

  notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

/** The random pause between task starts; interrupt() (stop) ends it early. */
export class Pacer {
  private wake: (() => void) | null = null;

  constructor(private readonly sleep?: Sleep) {}

  async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    const woke = new Promise<void>((r) => (this.wake = r));
    const slept = (this.sleep ?? delay)(ms);
    await Promise.race([slept, woke]);
    this.wake = null;
  }

  interrupt(): void {
    this.wake?.();
  }
}
