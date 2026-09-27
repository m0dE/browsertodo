/**
 * Approvals in hands-free voice: the line that asks for one (said by Standard,
 * passed to the Realtime narrator as a question), the approval the chat is
 * waiting on, and a spoken answer: "yes" / "allow" allows it once, "no" /
 * "deny" refuses it. Anything else is a normal message. Pure.
 */
import type { AgentEvent, ApprovalAnswer, ApprovalRequest } from "@browsertodo/shared";

/** "Approval needed: Click "Post" on x.com; it publishes. Say yes to allow it, or no." */
export function approvalLine(r: Pick<ApprovalRequest, "action" | "site" | "why">): string {
  return `Approval needed: ${r.action}${r.site ? ` on ${r.site}` : ""}; it ${r.why.replace(/^it /, "")}. Say yes to allow it, or no.`;
}

const ALLOW = /^(yes|yeah|yep|sure|ok|okay|allow( it)?|go ahead|do it|approve( it)?|allow once)$/;
const DENY = /^(no|nope|deny( it)?|don'?t|do not|stop|cancel|refuse|don'?t do it)$/;

/** The answer a short utterance gives, or null when it is something else (then it goes to the agent as usual). */
export function spokenApprovalAnswer(text: string): ApprovalAnswer | null {
  const t = text.toLowerCase().replace(/[.!,?]+/g, " ").replace(/\s+/g, " ").trim().replace(/ please$/, "");
  if (ALLOW.test(t)) return "allow_once";
  if (DENY.test(t)) return "deny";
  return null;
}

/** The approval request of each chat that still waits (the newest one). */
export class WaitingApprovals {
  private readonly waiting = new Map<string, string>();

  push(ev: AgentEvent & { sessionId: string }): void {
    if (ev.type === "approval_request") this.waiting.set(ev.sessionId, ev.request.id);
    else if ((ev.type === "approval_resolved" && this.waiting.get(ev.sessionId) === ev.id) || ev.type === "task_end") this.waiting.delete(ev.sessionId);
  }

  of(sessionId: string | null): string | null {
    return sessionId ? (this.waiting.get(sessionId) ?? null) : null;
  }
}
