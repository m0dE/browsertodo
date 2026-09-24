/** Sorts failure reasons into temporary (retry later) and permanent. */
import type { FailureKind } from "./types.js";

const TRANSIENT: RegExp[] = [
  // Usage and rate limits, overload.
  /\b429\b/,
  /\b529\b/,
  /rate[ _-]?limit/i,
  /usage[ _-]?limit/i,
  /overloaded/i,
  /too many requests/i,
  // Server-side errors reported as HTTP 5xx.
  /\bHTTP 5\d\d\b/i,
  /\b50[234]\b.*\b(bad gateway|unavailable|gateway)\b/i,
  // Network problems.
  /\bECONN[A-Z]*\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /fetch failed/i,
  /network ?error/i,
  /failed to fetch/i,
  /socket hang up/i,
  /\btimeout\b/i,
  /timed out/i,
  // Crashes and lost connections around the agent.
  /helper disconnected/i,
  /agent exited without reporting a result/i,
  /agent ended without reporting a result/i,
  /could not verify the post/i,
];

const DEBUGGER_DETACHED = /debugger (was )?detached/i;
const BY_USER = /by (the )?user|canceled_by_user|cancelled by user/i;

export function classifyFailure(reason: string): FailureKind {
  const r = reason ?? "";
  if (DEBUGGER_DETACHED.test(r)) return BY_USER.test(r) ? "permanent" : "transient";
  return TRANSIENT.some((re) => re.test(r)) ? "transient" : "permanent";
}
