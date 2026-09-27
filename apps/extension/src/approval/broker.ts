/**
 * Approval requests waiting for the user: the gate asks (request), the chat's
 * approval card or hands-free voice answers (answer), and a request with no
 * answer in APPROVAL_TIMEOUT_MS counts as denied. Each request and how it
 * ended are events of the conversation (approval_request, approval_resolved),
 * so the card shows in the thread, survives a panel reload, and the Raw view
 * has it. When the turn ends first (Stop, time limit), end() settles its
 * requests as "ended".
 */
import { APPROVAL_TIMEOUT_MS, type AgentEvent, type ApprovalAnswer, type ApprovalOutcome, type ApprovalRequest } from "@browsertodo/shared";

export interface ApprovalBrokerDeps {
  /** Adds an event to the conversation (SessionStore.note). */
  note(sessionId: string, event: AgentEvent): void | Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  newId?: () => string;
  /** A request was made (e.g. a system notification when the side panel may be closed). */
  onRequest?(sessionId: string, request: ApprovalRequest): void;
}

interface Pending {
  sessionId: string;
  request: ApprovalRequest;
  settle(outcome: ApprovalOutcome, by?: "voice"): void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly newId: () => string;

  constructor(private readonly deps: ApprovalBrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Asks the user; resolves with their answer, "timeout" (after opts.timeoutMs, default APPROVAL_TIMEOUT_MS), or "ended". */
  request(sessionId: string, ask: Omit<ApprovalRequest, "id" | "expiresAt">, opts: { timeoutMs?: number } = {}): Promise<ApprovalOutcome> {
    const timeoutMs = Math.min(opts.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const request: ApprovalRequest = { ...ask, id: this.newId(), expiresAt: new Date(this.now() + timeoutMs).toISOString() };
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), timeoutMs);
      const settle = (outcome: ApprovalOutcome, by?: "voice") => {
        if (!this.pending.delete(request.id)) return;
        clearTimeout(timer);
        void this.emit(sessionId, { type: "approval_resolved", id: request.id, outcome, ...(by ? { by } : {}) });
        resolve(outcome);
      };
      this.pending.set(request.id, { sessionId, request, settle });
      // A request the user cannot see would only wait out its timeout: it ends at once instead.
      void this.emit(sessionId, { type: "approval_request", request }).then((shown) => (shown ? this.deps.onRequest?.(sessionId, request) : settle("ended")));
    });
  }

  /** The user's answer to a request of this conversation. False when it is not waiting (answered, timed out, or not this conversation's). */
  answer(sessionId: string, id: string, answer: ApprovalAnswer, by?: "voice"): boolean {
    const p = this.pending.get(id);
    if (!p || p.sessionId !== sessionId) return false;
    p.settle(answer, by);
    return true;
  }

  /** The turn ended: its waiting requests end unanswered (the actions are not done). */
  end(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) p.settle("ended");
  }

  /** Requests waiting now, oldest first (all conversations, or one). */
  waiting(sessionId?: string): ApprovalRequest[] {
    return [...this.pending.values()].filter((p) => !sessionId || p.sessionId === sessionId).map((p) => p.request);
  }

  /** Adds the event to the conversation; false when that failed. */
  private async emit(sessionId: string, e: AgentEvent): Promise<boolean> {
    try {
      await this.deps.note(sessionId, e);
      return true;
    } catch {
      return false;
    }
  }
}
