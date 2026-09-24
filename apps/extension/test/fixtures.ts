import type { ClaimResponse } from "@browsertodo/shared";

export function claimFixture(id: string, extra: Partial<ClaimResponse["task"]> = {}): ClaimResponse {
  const now = "2026-09-23T00:00:00.000Z";
  return {
    task: {
      id,
      instructions: `Post: hello from ${id}`,
      account: "@me",
      mediaIds: [],
      notBefore: null,
      priority: 0,
      status: "running",
      attempts: 1,
      leaseOwner: "runner-1",
      leaseExpiresAt: "2026-09-23T00:15:00.000Z",
      retryAfter: null,
      resultSummary: null,
      resultUrl: null,
      resultScreenshotId: null,
      pauseReason: null,
      failReason: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
    media: [],
    leaseExpiresAt: "2026-09-23T00:15:00.000Z",
  };
}
