/** The signed-in account's API client: sign-in, profile, billing, keys, tasks and media, with the session token. */
import {
  AuthResponse,
  MeBillingResponse,
  RedirectUrlResponse,
  SESSION_HEADER,
  Task,
  TRANSCRIBE_CONTENT_TYPE,
  TRANSCRIBE_PATH,
  TRANSCRIBE_QUERY,
  TranscribeResponse,
  type CreateTaskInput,
  type MediaInfo,
  type UpdateTaskInput,
} from "@browsertodo/shared";
import { HttpClient } from "../http-client.js";
import { Me, type ApiKeyInfo, type BillingAction, type CreatedApiKey, type KeyRole } from "./types.js";

export interface AccountApiOptions {
  apiBase: string;
  token?: string;
  fetch?: typeof fetch;
  /** Called on 401 for an authenticated request (the session expired or was revoked). */
  onUnauthorized?: () => void;
}

/** Tasks listed per page (GET /v1/tasks). */
const TASK_PAGE_SIZE = 200;

export class AccountApi {
  private readonly http: HttpClient;

  constructor(opts: AccountApiOptions) {
    this.http = new HttpClient({ ...opts, missingBase: "The account server URL is not set (Settings > Advanced)" });
  }

  get base(): string {
    return this.http.base;
  }

  /** A session token is set (authenticated calls can be made). */
  get signedIn(): boolean {
    return this.http.hasToken;
  }

  /** POST /v1/auth/google (public). */
  signIn(idToken: string): Promise<AuthResponse> {
    return this.http.json(AuthResponse, "POST", "/v1/auth/google", { idToken }, { auth: false });
  }

  async logout(): Promise<void> {
    await this.http.request("POST", "/v1/auth/logout");
  }

  me(): Promise<Me> {
    return this.http.json(Me, "GET", "/v1/me");
  }

  billing(): Promise<MeBillingResponse> {
    return this.http.json(MeBillingResponse, "GET", "/v1/me/billing");
  }

  /** POST /v1/billing/checkout | topup | portal: the Stripe page to open. */
  async billingLink(kind: BillingAction, body: Record<string, unknown>): Promise<string> {
    const res = await this.http.request("POST", `/v1/billing/${kind}`, body);
    const parsed = RedirectUrlResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success || !parsed.data.url) throw new Error("The server did not return a billing page");
    return parsed.data.url;
  }

  async listKeys(): Promise<ApiKeyInfo[]> {
    return ((await (await this.http.request("GET", "/v1/me/keys")).json()) as { keys: ApiKeyInfo[] }).keys;
  }

  async createKey(name: string, role: KeyRole): Promise<CreatedApiKey> {
    return (await (await this.http.request("POST", "/v1/me/keys", { name, role })).json()) as CreatedApiKey;
  }

  async revokeKey(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/me/keys/${encodeURIComponent(id)}`);
  }

  /** Every task of the account (a few pages). */
  async listTasks(maxPages = 5): Promise<Task[]> {
    const out: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ limit: String(TASK_PAGE_SIZE) });
      if (cursor) q.set("cursor", cursor);
      const body = (await (await this.http.request("GET", `/v1/tasks?${q}`)).json()) as { tasks?: unknown[]; nextCursor?: string | null };
      for (const t of body.tasks ?? []) out.push(Task.parse(t));
      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.http.json(Task, "POST", "/v1/tasks", input);
  }

  updateTask(id: string, patch: UpdateTaskInput): Promise<Task> {
    return this.http.json(Task, "PATCH", `/v1/tasks/${encodeURIComponent(id)}`, patch);
  }

  async deleteTask(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/tasks/${encodeURIComponent(id)}`);
  }

  retryTask(id: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/retry`);
  }

  cancelTask(id: string): Promise<Task> {
    return this.http.json(Task, "POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`);
  }

  uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    return this.http.uploadMedia(blob, filename);
  }

  /** POST /v1/ai/transcribe: a WAV clip to text (voice input; paid plans). */
  transcribe(
    wav: Uint8Array,
    opts: { language?: string; speechMs?: number; context?: string; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<TranscribeResponse> {
    const q = new URLSearchParams();
    if (opts.language) q.set(TRANSCRIBE_QUERY.language, opts.language);
    if (opts.speechMs !== undefined) q.set(TRANSCRIBE_QUERY.speechMs, String(Math.round(opts.speechMs)));
    if (opts.context) q.set(TRANSCRIBE_QUERY.context, opts.context);
    const path = q.size ? `${TRANSCRIBE_PATH}?${q}` : TRANSCRIBE_PATH;
    const body = new Blob([wav as BlobPart], { type: TRANSCRIBE_CONTENT_TYPE });
    return this.http.json(TranscribeResponse, "POST", path, body, {
      ...(opts.sessionId ? { headers: { [SESSION_HEADER]: opts.sessionId } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
}
