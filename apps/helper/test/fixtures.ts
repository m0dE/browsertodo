import type { Task } from "@browsertodo/shared";

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "01TASK",
    instructions: "Post: hello from browsertodo",
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "running",
    attempts: 1,
    leaseOwner: "r1",
    leaseExpiresAt: "2026-09-23T00:15:00.000Z",
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: null,
    failReason: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}
