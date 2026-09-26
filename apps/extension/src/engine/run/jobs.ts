/**
 * Where a run's work comes from: due local tasks, cloud claims, one-off
 * requests ("do this now"), and the next turn of a conversation.
 */
import { errorMessage, isXTask, SCREEN_HELP_TEXT, type AgentTask, type ClaimResponse, type MediaInfo, type ResultInput, type SessionInfo } from "@browsertodo/shared";
import type { LocalStore } from "../local-store.js";
import type { StoredLocalTask } from "../local-task-rules.js";
import type { MediaSource } from "../media-files.js";
import type { SessionStore } from "../sessions.js";

const HEARTBEAT_MS = 2 * 60_000;

/** The cloud task API as the runner uses it (ApiClient). */
export interface RunnerApi {
  claim(runnerId: string): Promise<ClaimResponse | null>;
  heartbeat(taskId: string, runnerId: string): Promise<unknown>;
  result(taskId: string, body: ResultInput): Promise<void>;
  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo>;
  mediaUrl(mediaId: string): string;
  authHeaders(): { name: string; value: string }[];
}

export interface AdhocInput {
  instructions: string;
  /** The browser tab it was started from: it acts there, and the conversation belongs to that tab. */
  tabId?: number;
  account?: string | null;
  media?: { name: string; blob: Blob }[];
  /**
   * An empty message in Chat: look at the page and do what is needed. The
   * request is SCREEN_HELP_TEXT (instructions are not used).
   */
  screen?: boolean;
  /** The instructions were spoken (the session's first message is marked). */
  voice?: boolean;
}

export type LocalJob = { source: "local"; task: StoredLocalTask };
export type CloudJob = { source: "cloud"; claim: ClaimResponse; api: RunnerApi; runnerId: string };
export type AdhocJob = { source: "adhoc"; input: AdhocInput };

/** The next turn of an ended conversation. */
export interface TurnJob {
  source: "turn";
  from: SessionInfo;
  /** The user's message (an empty one in Chat: SCREEN_HELP_TEXT). */
  text: string;
  /** An empty message in Chat: look at the page now and continue. */
  screen?: boolean;
  /** The message was spoken (its user_message is marked). */
  voice?: boolean;
  /** The browser tab the message was sent from: the conversation now belongs to it. */
  tabId?: number;
  /** The conversation's local task, when this turn continues its unfinished work (recorded on the task). */
  task: StoredLocalTask | null;
  /** The conversation's first request (for the fresh-session summary and the X rule). */
  first: { instructions: string; account: string | null };
}

/** A job that starts a new session. */
export type FirstJob = LocalJob | CloudJob | AdhocJob;
export type Job = FirstJob | TurnJob;

/** Due local tasks the loop may start now (not running; X tasks only while no X task runs), and how many wait for X. */
export async function dueLocal(
  localStore: LocalStore,
  now: Date,
  running: ReadonlySet<string>,
  xBusy: boolean,
): Promise<{ startable: StoredLocalTask[]; blocked: number }> {
  const due = (await localStore.due(now)).filter((t) => !running.has(t.id));
  const startable = due.filter((t) => !(xBusy && isXTask(t)));
  return { startable, blocked: due.length - startable.length };
}

/** The task a new session runs. Local tasks get their crash marker first, persisted before anything can act. */
export async function openTask(
  job: FirstJob,
  sessionId: string,
  localStore: LocalStore,
): Promise<{ task: AgentTask; taskId?: string; isRetry: boolean }> {
  if (job.source === "local") {
    const marked = await localStore.markStarted(job.task.id);
    return {
      task: { id: marked.id, instructions: marked.instructions, account: marked.account },
      taskId: marked.id,
      isRetry: marked.attempts > 1 || !!job.task.crashed,
    };
  }
  if (job.source === "cloud") {
    const t = job.claim.task;
    return { task: { id: t.id, instructions: t.instructions, account: t.account }, taskId: t.id, isRetry: t.attempts > 1 };
  }
  const account = job.input.account?.trim() || null;
  if (job.input.screen) return { task: { id: sessionId, instructions: SCREEN_HELP_TEXT, account, screenHelp: true }, isRetry: false };
  return { task: { id: sessionId, instructions: job.input.instructions.trim(), account }, isRetry: false };
}

/** The files a new session's task comes with. */
export async function mediaSources(job: FirstJob, localStore: LocalStore): Promise<MediaSource[]> {
  if (job.source === "local") {
    return (await localStore.getMedia(job.task.mediaIds)).map((m) => ({ kind: "blob" as const, name: m.name, blob: m.blob }));
  }
  if (job.source === "cloud") {
    return job.claim.media.map((m) => ({ kind: "url" as const, name: m.filename, url: job.api.mediaUrl(m.id), headers: job.api.authHeaders() }));
  }
  return (job.input.media ?? []).map((m) => ({ kind: "blob" as const, name: m.name, blob: m.blob }));
}

/** The next turn of a conversation, checking that it can take one now. */
export async function turnJob(
  stores: { sessions: SessionStore; localStore: LocalStore },
  sessionId: string,
  text: string,
  opts: { screen?: boolean; voice?: boolean; tabId?: number } = {},
): Promise<TurnJob> {
  const from = await stores.sessions.get(sessionId);
  if (!from) throw new Error(`No session ${sessionId}`);
  if (!from.endedAt) throw new Error("That conversation has not ended yet");
  let task: StoredLocalTask | null = null;
  let first = { instructions: from.instructions ?? from.title, account: from.account ?? null };
  if (from.source === "local" && from.taskId) {
    const t = await stores.localStore.get(from.taskId);
    if (t?.status === "running") throw new Error("The task is already running");
    if (t) first = { instructions: t.instructions, account: t.account };
    // Only unfinished work is recorded on the task; after it is done, the conversation just goes on.
    if (t && t.status !== "done") task = t;
  }
  const job: TurnJob = { source: "turn", from, text, task, first };
  if (opts.screen) job.screen = true;
  if (opts.voice) job.voice = true;
  if (opts.tabId !== undefined) job.tabId = opts.tabId;
  return job;
}

/** The local task whose result this job records, if any. */
export function localTaskOf(job: Job): StoredLocalTask | null {
  return job.source === "local" || job.source === "turn" ? job.task : null;
}

/** Keeps a claimed cloud task's lease while it runs. Returns the function that stops it. */
export function startHeartbeat(job: CloudJob, log: (message: string) => void): () => void {
  const t = setInterval(() => {
    job.api.heartbeat(job.claim.task.id, job.runnerId).catch((err) => log(`heartbeat failed: ${errorMessage(err)}`));
  }, HEARTBEAT_MS);
  return () => clearInterval(t);
}
