/**
 * How long a run may last. The brain has its own limit (maxTaskMinutes); the
 * runner's safety timer gives it a margin on top, then aborts it and waits a
 * grace period for its result. A local task still marked running after all
 * that was left by a crash.
 */
const SAFETY_MARGIN_MINUTES = 2;
/** Extra wait after aborting a stuck brain before giving up on it. */
export const ABORT_GRACE_MS = 30_000;

/** When the safety timer aborts a run that has not reported a result. */
export function safetyTimeoutMinutes(maxTaskMinutes: number): number {
  return maxTaskMinutes + SAFETY_MARGIN_MINUTES;
}

/** No live run lasts longer than this: a task marked running for longer was left by a crash. */
export function crashAfterMs(maxTaskMinutes: number): number {
  return safetyTimeoutMinutes(maxTaskMinutes) * 60_000 + ABORT_GRACE_MS;
}
