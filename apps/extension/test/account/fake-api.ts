/** A scripted fake of the browsertodo API over fetch, for account tests. */
import type { Task } from "@browsertodo/shared";
import type { StorageLike } from "../../src/engine/kv.js";

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | undefined;

export function fakeApi(base = "https://api.test") {
  const calls: Call[] = [];
  const routes = new Map<string, Handler>();
  const on = (key: string, h: Handler | { status?: number; body?: unknown }) => {
    routes.set(key, typeof h === "function" ? h : () => h);
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== base) throw new TypeError(`fetch to unexpected origin ${url.origin}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (init?.body instanceof FormData) {
      const f = init.body.get("file") as File | null;
      body = { file: f ? { name: f.name, size: f.size, type: f.type } : null };
    } else if (typeof init?.body === "string") body = JSON.parse(init.body);
    const call: Call = { method: init?.method ?? "GET", path: url.pathname + url.search, headers, body };
    calls.push(call);
    const h = routes.get(`${call.method} ${url.pathname}`) ?? routes.get(`${call.method} ${call.path}`);
    const r = h?.(call) ?? { status: 404, body: { error: "not found" } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, on, base };
}

export function memoryStorage(): StorageLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: string) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}

/** A base64url JWT with these claims (unsigned: the extension only reads it). */
export function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "RS256", kid: "k" })}.${enc(claims)}.c2ln`;
}

export function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    instructions: `task ${id}`,
    account: null,
    mediaIds: [],
    notBefore: null,
    priority: 0,
    status: "pending",
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    resultSummary: null,
    resultUrl: null,
    resultScreenshotId: null,
    pauseReason: null,
    failReason: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    repeat: null,
    tz: null,
    ownerId: "u1",
    ...extra,
  };
}

export const USER = { id: "u1", email: "ada@example.com", name: "Ada", pictureUrl: "https://lh3.googleusercontent.com/a/ada" };
export const FREE_PLAN = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } as const;
export const PLUS_PLAN = { id: "plus", status: "active", currentPeriodEnd: "2026-10-24T00:00:00.000Z", cancelAtPeriodEnd: false } as const;
export const credit = (sub: number, top: number) => ({
  subscriptionCents: sub,
  topupCents: top,
  totalCents: sub + top,
  periodGrantCents: sub ? 2000 : 0,
  periodEnd: sub ? "2026-10-24T00:00:00.000Z" : null,
});
