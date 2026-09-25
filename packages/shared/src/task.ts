import { z } from "zod";

/** Lifecycle of a task stored in the cloud API. */
export const TaskStatus = z.enum(["pending", "running", "done", "failed", "paused", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const MAX_INSTRUCTIONS_CHARS = 8000;
export const MAX_BATCH_TASKS = 100;
/** Files one task can carry (images, videos, documents the agent uses). */
export const MAX_MEDIA_PER_TASK = 10;
/** Times a day a repeating task can run. */
export const MAX_REPEAT_TIMES = 24;
/** Length of a task's account label. */
export const MAX_ACCOUNT_CHARS = 100;
/** Lengths of a reported result's fields (ResultInput). */
export const MAX_RESULT_SUMMARY = 4000;
export const MAX_RESULT_URL = 2000;
export const MAX_RESULT_REASON = 4000;

/** An X-style handle or any account label the agent should switch to. */
const Account = z.string().trim().min(1).max(MAX_ACCOUNT_CHARS);

/**
 * Repeat rule: run again every day at these local times ("HH:MM", 24 h).
 * Local tasks use the browser's time zone; cloud tasks use the task's `tz`.
 */
export const RepeatRule = z.object({
  dailyAt: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(MAX_REPEAT_TIMES),
});
export type RepeatRule = z.infer<typeof RepeatRule>;

/** True when `tz` is an IANA time zone name this runtime knows (e.g. "America/New_York"). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name. */
export const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, "unknown IANA time zone");

/** Body of POST /v1/tasks and each item of POST /v1/tasks/batch. */
export const CreateTaskInput = z.object({
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS),
  account: Account.optional(),
  mediaIds: z.array(z.string().min(1)).max(MAX_MEDIA_PER_TASK).optional(),
  notBefore: z.iso.datetime({ offset: true }).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  /** Cloud only: when the task ends done or failed, the next occurrence is created. null = no repeat. */
  repeat: RepeatRule.nullable().optional(),
  /** IANA time zone for `repeat`. Default "UTC". */
  tz: TimeZone.nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const BatchCreateInput = z.object({
  tasks: z.array(CreateTaskInput).min(1).max(MAX_BATCH_TASKS),
});
export type BatchCreateInput = z.infer<typeof BatchCreateInput>;

/**
 * Body of PATCH /v1/tasks/:id. Only allowed while pending or paused.
 * `account: null` and `notBefore: null` clear them (omit a field to keep it).
 */
export const UpdateTaskInput = CreateTaskInput.extend({
  account: Account.nullable(),
  notBefore: z.iso.datetime({ offset: true }).nullable(),
}).partial();
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
  /** Daily repeat rule (cloud tasks; optional so older producers still validate). */
  repeat: RepeatRule.nullable().optional(),
  /** IANA time zone of the repeat rule. */
  tz: z.string().nullable().optional(),
  /** Owning user id; null for legacy (admin-owned) cloud tasks. */
  ownerId: z.string().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

/**
 * GET /v1/tasks: a page of tasks, newest first. `locked`: the plan of the user
 * the list belongs to does not include the TODO list, so the list is read-only
 * (writes, claims and uploads answer 403 plan_required) until they subscribe.
 */
export const TaskListResponse = z.object({ tasks: z.array(Task), nextCursor: z.string().nullable(), locked: z.boolean() });
export type TaskListResponse = z.infer<typeof TaskListResponse>;

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

/**
 * done: finished. failed: will not be retried. paused: needs a human; retried
 * after retryAfterMinutes. retry: temporary problem (usage limit, network,
 * crash); goes back to pending after retryAfterMinutes, and fails once the
 * attempt limit is reached.
 */
export const TaskOutcome = z.enum(["done", "failed", "paused", "retry"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** Body of POST /v1/runner/tasks/:id/result. */
export const ResultInput = z.object({
  runnerId: z.string().min(1),
  outcome: TaskOutcome,
  summary: z.string().max(MAX_RESULT_SUMMARY).optional(),
  url: z.string().max(MAX_RESULT_URL).optional(),
  reason: z.string().max(MAX_RESULT_REASON).optional(),
  screenshotId: z.string().optional(),
  /** Paused and retry tasks become claimable again after this many minutes. Default 15. */
  retryAfterMinutes: z.number().int().min(1).max(24 * 60).optional(),
});
export type ResultInput = z.infer<typeof ResultInput>;

export const ApiKeyRole = z.enum(["admin", "creator", "runner"]);
export type ApiKeyRole = z.infer<typeof ApiKeyRole>;

/** The roles a new key can have (admin is the ADMIN_KEY's alone). */
export const IssuableKeyRole = ApiKeyRole.exclude(["admin"]);
export type IssuableKeyRole = z.infer<typeof IssuableKeyRole>;

export const CreateKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  role: IssuableKeyRole,
});
export type CreateKeyInput = z.infer<typeof CreateKeyInput>;

/** Body of POST /v1/me/keys: a key scoped to the signed-in user's data (same shape as the admin's). */
export const CreateOwnKeyInput = CreateKeyInput;
export type CreateOwnKeyInput = CreateKeyInput;

/** A signed-in user (Google account). */
export const User = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  pictureUrl: z.string().nullable(),
});
export type User = z.infer<typeof User>;

/** Body of POST /v1/auth/google: a Google ID token (JWT) issued for this server's client id. */
export const AuthGoogleInput = z.object({
  idToken: z.string().min(1).max(8192),
  /** Dashboard (same origin): also set the HttpOnly `bt_session` cookie. */
  cookie: z.boolean().optional(),
});
export type AuthGoogleInput = z.infer<typeof AuthGoogleInput>;

/** 200 response of POST /v1/auth/google. `token` is a session bearer token (bt_s_...). */
export const AuthResponse = z.object({
  token: z.string(),
  user: User,
  expiresAt: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** Standard error body for every non-2xx API response. */
export const ApiError = z.object({ error: z.string(), details: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiError>;

/**
 * A task stored in the extension (no cloud needed). Same shape as a cloud
 * Task plus a repeat rule. mediaIds refer to files stored in the extension.
 * When a repeating task finishes, the extension creates the next occurrence
 * as a new pending task and keeps the finished one as history.
 */
export const LocalTask = Task.extend({
  repeat: RepeatRule.nullable(),
});
export type LocalTask = z.infer<typeof LocalTask>;

/** Where a task came from. "adhoc" is a one-off "do this now" request. */
export const TaskSource = z.enum(["local", "cloud", "adhoc"]);
export type TaskSource = z.infer<typeof TaskSource>;

const X_HOST = /\b(?:x|twitter)\.com\b/i;
/** An @handle as X writes it (not the @ inside an email address). */
const X_HANDLE = /(?:^|[^\w.@])@[A-Za-z0-9_]{1,15}(?![\w@.]*\.[A-Za-z])\b/;

/**
 * True when a task acts as an X account: it names one (account, or an
 * @handle in the instructions) or works on x.com. Such tasks never run at the
 * same time: every X account shares one login session in the browser, so
 * switching accounts in one tab switches it in every tab.
 */
export function isXTask(task: { instructions: string; account?: string | null }): boolean {
  if (task.account?.trim()) return true;
  return X_HOST.test(task.instructions) || X_HANDLE.test(task.instructions);
}

/**
 * An empty message in Chat: "look at the page and do what's needed". It is
 * the request itself (AgentTask.instructions, with screenHelp set), so the
 * chat shows it as the user's turn and the session title; @browsertodo/core
 * buildTaskPrompt tells the agent what it means.
 */
export const SCREEN_HELP_TEXT = "Figure out what to do based on the current screen";
