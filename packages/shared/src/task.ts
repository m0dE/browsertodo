import { z } from "zod";

/** Lifecycle of a task stored in the cloud API. */
export const TaskStatus = z.enum(["pending", "running", "done", "failed", "paused", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_BATCH_TASKS = 100;

/** An X-style handle or any account label the agent should switch to. */
const Account = z.string().trim().min(1).max(100);

/** Body of POST /v1/tasks and each item of POST /v1/tasks/batch. */
export const CreateTaskInput = z.object({
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS),
  account: Account.optional(),
  mediaIds: z.array(z.string().min(1)).max(10).optional(),
  notBefore: z.iso.datetime({ offset: true }).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const BatchCreateInput = z.object({
  tasks: z.array(CreateTaskInput).min(1).max(MAX_BATCH_TASKS),
});
export type BatchCreateInput = z.infer<typeof BatchCreateInput>;

/** Body of PATCH /v1/tasks/:id. Only allowed while pending or paused. */
export const UpdateTaskInput = CreateTaskInput.partial();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

/** Metadata for an uploaded media file. */
export const MediaInfo = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

/** A task as returned by the API. Times are ISO 8601 strings in UTC. */
export const Task = z.object({
  id: z.string(),
  instructions: z.string(),
  account: z.string().nullable(),
  mediaIds: z.array(z.string()),
  notBefore: z.string().nullable(),
  priority: z.number().int(),
  status: TaskStatus,
  attempts: z.number().int(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  retryAfter: z.string().nullable(),
  resultSummary: z.string().nullable(),
  resultUrl: z.string().nullable(),
  resultScreenshotId: z.string().nullable(),
  pauseReason: z.string().nullable(),
  failReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const TaskEvent = z.object({
  id: z.number().int(),
  taskId: z.string(),
  type: z.enum(["created", "updated", "claimed", "heartbeat", "done", "failed", "paused", "cancelled", "retried", "lease_expired"]),
  detail: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/** Body of POST /v1/runner/claim. */
export const ClaimInput = z.object({
  runnerId: z.string().min(1).max(100),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** 200 response of POST /v1/runner/claim. A 204 means nothing is due. */
export const ClaimResponse = z.object({
  task: Task,
  media: z.array(MediaInfo),
  leaseExpiresAt: z.string(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

/** Body of POST /v1/runner/tasks/:id/heartbeat. */
export const HeartbeatInput = z.object({ runnerId: z.string().min(1) });
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** How a task run ended. Shared by the API, the extension and the helper. */
export const TaskOutcome = z.enum(["done", "failed", "paused"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** Body of POST /v1/runner/tasks/:id/result. */
export const ResultInput = z.object({
  runnerId: z.string().min(1),
  outcome: TaskOutcome,
  summary: z.string().max(4000).optional(),
  url: z.string().max(2000).optional(),
  reason: z.string().max(4000).optional(),
  screenshotId: z.string().optional(),
  /** Paused tasks become claimable again after this many minutes. Default 15. */
  retryAfterMinutes: z.number().int().min(1).max(24 * 60).optional(),
});
export type ResultInput = z.infer<typeof ResultInput>;

export const ApiKeyRole = z.enum(["admin", "creator", "runner"]);
export type ApiKeyRole = z.infer<typeof ApiKeyRole>;

export const CreateKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(["creator", "runner"]),
});
export type CreateKeyInput = z.infer<typeof CreateKeyInput>;

/** Standard error body for every non-2xx API response. */
export const ApiError = z.object({ error: z.string(), details: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiError>;
