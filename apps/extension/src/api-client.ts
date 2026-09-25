import { ClaimResponse, MediaInfo, type ResultInput } from "@browsertodo/shared";
import { errText } from "./errors.js";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiClientOptions {
  apiBase: string;
  runnerKey: string;
  fetch?: typeof fetch;
}

/** Runner-side client of the task API. */
export class ApiClient {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.base = opts.apiBase.replace(/\/+$/, "");
    this.key = opts.runnerKey;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Claims the next due task, or null when nothing is due (204). */
  async claim(runnerId: string): Promise<ClaimResponse | null> {
    const res = await this.request("POST", "/v1/runner/claim", { runnerId });
    if (res.status === 204) return null;
    const parsed = ClaimResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error(`Unexpected claim response: ${parsed.error.message}`);
    return parsed.data;
  }

  async heartbeat(taskId: string, runnerId: string): Promise<{ leaseExpiresAt: string }> {
    const res = await this.request("POST", `/v1/runner/tasks/${encodeURIComponent(taskId)}/heartbeat`, { runnerId });
    return (await res.json()) as { leaseExpiresAt: string };
  }

  /** Reports how a claimed task ended. outcome "retry" sends it back to pending after retryAfterMinutes. */
  async result(taskId: string, body: ResultInput): Promise<void> {
    await this.request("POST", `/v1/runner/tasks/${encodeURIComponent(taskId)}/result`, body);
  }

  async uploadMedia(blob: Blob, filename: string): Promise<MediaInfo> {
    const form = new FormData();
    form.append("file", blob, filename);
    const res = await this.request("POST", "/v1/media", form);
    return MediaInfo.parse(await res.json());
  }

  /** Download URL of a media file; fetch it with authHeaders(). */
  mediaUrl(mediaId: string): string {
    return `${this.base}/v1/media/${encodeURIComponent(mediaId)}`;
  }

  authHeaders(): { name: string; value: string }[] {
    return [{ name: "Authorization", value: `Bearer ${this.key}` }];
  }

  /** Checks that the API is reachable and accepts the runner key. */
  async check(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.request("GET", "/", undefined, false);
      // An unknown media ID answers 404 for a valid key and 401/403 otherwise.
      await this.request("GET", `/v1/media/browsertodo-check-${Date.now()}`).catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 404) return;
        throw err;
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  private async request(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    if (!this.base) throw new Error("API base URL is not set");
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${this.key}`;
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
      throw new Error(`Cannot reach API at ${this.base}: ${errText(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 300) || res.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
        /* not JSON */
      }
      throw new ApiRequestError(res.status, `API ${res.status}: ${message}`);
    }
    return res;
  }
}
