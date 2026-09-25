/** The signed-in account's API client: sign-in, profile, billing, keys, tasks and media, with the session token. */
import { AuthResponse, MediaInfo, Task, type CreateTaskInput, type UpdateTaskInput } from "@browsertodo/shared";
import { ApiRequestError } from "../api-client.js";
import { errText } from "../errors.js";
import type { ApiKeyInfo, BillingInfo, Me } from "./types.js";

/** An API error with the parsed JSON body (e.g. 409 { portal: true }). */
export class AccountApiError extends ApiRequestError {
  constructor(
    status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(status, message);
    this.name = "AccountApiError";
  }
}

export interface AccountApiOptions {
  apiBase: string;
  token?: string;
  fetch?: typeof fetch;
  /** Called on 401 for an authenticated request (the session expired or was revoked). */
  onUnauthorized?: () => void;
}

export class AccountApi {
  readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: AccountApiOptions) {
    this.base = opts.apiBase.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** POST /v1/auth/google (public). */
  async signIn(idToken: string): Promise<AuthResponse> {
    const res = await this.request("POST", "/v1/auth/google", { idToken }, false);
    return AuthResponse.parse(await res.json());
  }

  async logout(): Promise<void> {
    await this.request("POST", "/v1/auth/logout");
  }

  async me(): Promise<Me> {
    return (await (await this.request("GET", "/v1/me")).json()) as Me;
  }

  async billing(): Promise<BillingInfo> {
    return (await (await this.request("GET", "/v1/me/billing")).json()) as BillingInfo;
  }

  /** POST /v1/billing/checkout | topup | portal: the Stripe page to open. */
  async billingLink(kind: "checkout" | "topup" | "portal", body: Record<string, unknown>): Promise<string> {
    const res = await this.request("POST", `/v1/billing/${kind}`, body);
    const { url } = (await res.json()) as { url?: unknown };
    if (typeof url !== "string" || !url) throw new Error("The server did not return a billing page");
    return url;
  }

  async listKeys(): Promise<ApiKeyInfo[]> {
    return ((await (await this.request("GET", "/v1/me/keys")).json()) as { keys: ApiKeyInfo[] }).keys;
  }

  async createKey(name: string, role: "creator" | "runner"): Promise<{ id: string; name: string; role: string; key: string }> {
    return (await (await this.request("POST", "/v1/me/keys", { name, role })).json()) as { id: string; name: string; role: string; key: string };
  }

  async revokeKey(id: string): Promise<void> {
    await this.request("DELETE", `/v1/me/keys/${encodeURIComponent(id)}`);
  }

  /** Every task of the account (a few pages of 200). */
  async listTasks(maxPages = 5): Promise<Task[]> {
    const out: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ limit: "200" });
      if (cursor) q.set("cursor", cursor);
      const body = (await (await this.request("GET", `/v1/tasks?${q}`)).json()) as { tasks?: unknown[]; nextCursor?: string | null };
      for (const t of body.tasks ?? []) out.push(Task.parse(t));
      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    return Task.parse(await (await this.request("POST", "/v1/tasks", input)).json());
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<Task> {
    return Task.parse(await (await this.request("PATCH", `/v1/tasks/${encodeURIComponent(id)}`, patch)).json());
  }

  async deleteTask(id: string): Promise<void> {
    await this.request("DELETE", `/v1/tasks/${encodeURIComponent(id)}`);
  }

  async retryTask(id: string): Promise<Task> {
    return Task.parse(await (await this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/retry`)).json());
  }

  async cancelTask(id: string): Promise<Task> {
    return Task.parse(await (await this.request("POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`)).json());
  }

  async uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    const form = new FormData();
    form.append("file", blob, filename);
    return MediaInfo.parse(await (await this.request("POST", "/v1/media", form)).json());
  }

  private async request(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    if (!this.base) throw new Error("The account server URL is not set (Settings > Advanced)");
    const headers: Record<string, string> = {};
    if (auth) {
      if (!this.opts.token) throw new Error("Not signed in");
      headers.authorization = `Bearer ${this.opts.token}`;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, { method, headers, body: payload });
    } catch (err) {
      throw new Error(`Cannot reach ${this.base}: ${errText(err)}`);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const message = typeof parsed?.error === "string" ? parsed.error : text.slice(0, 300) || res.statusText || `HTTP ${res.status}`;
    if (res.status === 401 && auth) this.opts.onUnauthorized?.();
    throw new AccountApiError(res.status, message, parsed);
  }
}
