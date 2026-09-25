/**
 * The sessions running right now and what each one holds while it runs: its
 * agent slot (tab), the X turn, its local task.
 */
import type { SessionInfo } from "@browsertodo/shared";
import type { AgentSlot, SlotPool } from "../../agent-slots.js";
import type { AbortOutcome } from "../brains.js";
import { MAX_SLOTS, Signal, SlotTable, XTurn } from "./scheduling.js";
import type { ActiveSession } from "./turn.js";

export class ActiveSessions {
  /** Oldest first. */
  private readonly byId = new Map<string, ActiveSession>();
  readonly slots: SlotTable;
  readonly xTurn = new XTurn();
  /** Local tasks picked by the due loop that have not ended yet. */
  readonly localRunning = new Set<string>();
  /** Woken whenever a session ends (or on stop): the due loop waits on it for capacity. */
  readonly ended = new Signal();

  /** pool: agent slots (MAX_SLOTS of them); without one, every session uses singleSlot(). */
  constructor(
    private readonly pool: SlotPool | undefined,
    private readonly singleSlot: () => AgentSlot,
  ) {
    this.slots = new SlotTable(pool ? MAX_SLOTS : 1);
  }

  get size(): number {
    return this.byId.size;
  }

  has(sessionId: string): boolean {
    return this.byId.has(sessionId);
  }

  get(sessionId: string): ActiveSession | undefined {
    return this.byId.get(sessionId);
  }

  /** Oldest first. */
  all(): ActiveSession[] {
    return [...this.byId.values()];
  }

  /** The session started last. */
  last(): ActiveSession | undefined {
    return this.all().at(-1);
  }

  /** Registers a running session in its slot. */
  activate(session: SessionInfo, slotIndex: number, x: boolean, scheduled: boolean, localTaskId: string | null): ActiveSession {
    const sessionId = session.sessionId;
    this.slots.bind(slotIndex, sessionId);
    const slot = this.pool ? this.pool.take(slotIndex, sessionId) : this.singleSlot();
    const active: ActiveSession = { session, slot, run: null, forced: null, said: [], typed: [], x, scheduled, localTaskId };
    this.byId.set(sessionId, active);
    return active;
  }

  /** The session ended: its slot, X turn and local task are free again. */
  deactivate(active: ActiveSession): void {
    const sessionId = active.session.sessionId;
    if (this.byId.get(sessionId) === active) this.byId.delete(sessionId);
    const index = this.slots.release(sessionId);
    if (index !== null) this.pool?.release(index, sessionId);
    this.xTurn.release(sessionId);
    if (active.localTaskId) this.localRunning.delete(active.localTaskId);
    this.ended.notify();
  }

  /** A session that never became active: gives back the slot, X turn and local task taken for it. */
  abandon(slotIndex: number, sessionId: string, localTaskId: string | null): void {
    this.slots.unassign(slotIndex);
    this.xTurn.release(sessionId);
    if (localTaskId) this.localRunning.delete(localTaskId);
    this.ended.notify();
  }

  /** Stops a session with this outcome (the brain is asked to stop; an X wait ends). */
  force(a: ActiveSession, outcome: AbortOutcome, reason: string): void {
    if (a.forced) return;
    a.forced = { outcome, reason };
    a.run?.abort(reason, outcome);
    this.xTurn.wake();
  }
}
