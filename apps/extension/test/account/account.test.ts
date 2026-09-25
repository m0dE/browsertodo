import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "@browsertodo/shared";
import { ACCOUNT_KEY, AccountService, BILLING_NOT_SET_UP, type AccountLocalTasks } from "../../src/account/account.js";
import { SIGN_IN_NOT_SET_UP } from "../../src/account/google-auth.js";
import { FREE_PLAN, PLUS_PLAN, USER, credit, fakeApi, jwt, memoryStorage, task } from "./fake-api.js";

const CLIENT = "123-abc.apps.googleusercontent.com";
const REDIRECT = "https://bfffghamekalimhllmeeigmmcoghhfke.chromiumapp.org/";

/** A Google that answers with an ID token for whatever nonce and state it was asked for. */
function google(over: { nonce?: string; state?: string; aud?: string } = {}) {
  const launch = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams;
    const token = jwt({ iss: "https://accounts.google.com", aud: over.aud ?? q.get("client_id"), sub: "g1", nonce: over.nonce ?? q.get("nonce") });
    return `${REDIRECT}#id_token=${token}&state=${over.state ?? q.get("state")}&token_type=Bearer`;
  });
  return { redirectUri: () => REDIRECT, launch };
}

function localTasks(): AccountLocalTasks & { rows: any[]; deleted: string[] } {
  const rows: any[] = [];
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    list: async () => rows,
    getMedia: async (ids) => ids.map((id) => ({ id, name: `${id}.jpg`, blob: new Blob(["img"], { type: "image/jpeg" }) })),
    delete: async (id) => {
      deleted.push(id);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    },
  };
}

function setup(opts: { clientId?: string; identity?: ReturnType<typeof google> } = {}) {
  const api = fakeApi();
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, accountApiBase: api.base };
  const storage = memoryStorage();
  const local = localTasks();
  const onChange = vi.fn();
  const identity = opts.identity ?? google();
  const account = new AccountService({
    loadSettings: async () => settings,
    clientId: opts.clientId ?? CLIENT,
    identity,
    localTasks: local,
    storage,
    fetch: api.fetch,
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    timeZone: () => "Asia/Seoul",
    onChange,
  });
  api.on("POST /v1/auth/google", { body: { token: "bt_s_abc", user: USER, expiresAt: "2026-11-23T12:00:00.000Z" } });
  api.on("GET /v1/me", { body: { ...USER, plan: FREE_PLAN, credit: credit(0, 0) } });
  api.on("GET /v1/me/billing", { body: { plan: FREE_PLAN, credit: credit(0, 0), stripeConfigured: true } });
  api.on("POST /v1/auth/logout", { status: 204 });
  return {
    api,
    account,
    storage,
    local,
    onChange,
    identity,
    setSettings: (p: Partial<ExtensionSettings>) => (settings = { ...settings, ...p }),
  };
}

describe("AccountService sign-in", () => {
  it("exchanges the Google ID token for a session, stores it, and loads plan and credit", async () => {
    const t = setup();
    await t.account.signIn();
    const auth = t.api.calls.find((c) => c.path === "/v1/auth/google")!;
    expect(auth.method).toBe("POST");
    expect(auth.headers.authorization).toBeUndefined();
    expect((auth.body as { idToken: string }).idToken.split(".")).toHaveLength(3);
    expect((t.storage.data[ACCOUNT_KEY] as any).session).toMatchObject({ token: "bt_s_abc", apiBase: t.api.base, user: { email: USER.email } });
    // The session token authenticates the follow-up calls.
    const me = t.api.calls.find((c) => c.path === "/v1/me")!;
    expect(me.headers.authorization).toBe("Bearer bt_s_abc");
    const view = await t.account.view();
    expect(view).toMatchObject({ signedIn: true, user: { email: USER.email }, plan: FREE_PLAN, stripeConfigured: true, dashboardUrl: "https://api.test/" });
    expect(t.onChange).toHaveBeenCalled();
  });

  it("asks Google for an ID token with openid email profile, a nonce and the chromiumapp redirect", async () => {
    const t = setup();
    await t.account.signIn();
    const url = new URL(t.identity.launch.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT, response_type: "id_token", scope: "openid email profile", redirect_uri: REDIRECT });
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses an ID token whose nonce does not match, and stores nothing", async () => {
    const t = setup({ identity: google({ nonce: "someone-elses" }) });
    await expect(t.account.signIn()).rejects.toThrow(/nonce/);
    expect(t.api.calls).toHaveLength(0);
    expect(t.storage.data[ACCOUNT_KEY]).toBeUndefined();
  });

  it("refuses a mismatched state and a token for another client", async () => {
    await expect(setup({ identity: google({ state: "x" }) }).account.signIn()).rejects.toThrow(/state/);
    await expect(setup({ identity: google({ aud: "other.apps.googleusercontent.com" }) }).account.signIn()).rejects.toThrow(/another app/);
  });

  it("without a built-in client ID, says sign-in is not set up (and never opens Google)", async () => {
    const t = setup({ clientId: "" });
    await expect(t.account.signIn()).rejects.toThrow(SIGN_IN_NOT_SET_UP);
    expect(t.identity.launch).not.toHaveBeenCalled();
    expect(await t.account.view()).toMatchObject({ signedIn: false, signInConfigured: false });
  });

  it("503 from the server (no GOOGLE_CLIENT_ID there) is shown plainly", async () => {
    const t = setup();
    t.api.on("POST /v1/auth/google", { status: 503, body: { error: "Google sign-in is not configured on this server" } });
    await expect(t.account.signIn()).rejects.toThrow("Google sign-in is not configured on this server (https://api.test)");
    expect((await t.account.view()).signedIn).toBe(false);
  });

  it("a cancelled Google window is reported as cancelled", async () => {
    const identity = { redirectUri: () => REDIRECT, launch: vi.fn(async () => Promise.reject(new Error("The user did not approve access."))) };
    await expect(setup({ identity: identity as any }).account.signIn()).rejects.toThrow("Sign-in was cancelled");
  });

  it("sign out revokes the session on the server and forgets it", async () => {
    const t = setup();
    await t.account.signIn();
    await t.account.signOut();
    const logout = t.api.calls.find((c) => c.path === "/v1/auth/logout")!;
    expect(logout.headers.authorization).toBe("Bearer bt_s_abc");
    expect(t.storage.data[ACCOUNT_KEY]).toEqual({});
    expect((await t.account.view()).signedIn).toBe(false);
  });

  it("a session belongs to its server: changing the account server URL signs out", async () => {
    const t = setup();
    await t.account.signIn();
    t.setSettings({ accountApiBase: "https://self-hosted.example" });
    expect((await t.account.view()).signedIn).toBe(false);
    expect(await t.account.runnerApi()).toBeNull();
  });

  it("a 401 from the server ends the session", async () => {
    const t = setup();
    await t.account.signIn();
    t.api.on("GET /v1/me", { status: 401, body: { error: "invalid or expired session" } });
    await t.account.refresh(true);
    expect((await t.account.view()).signedIn).toBe(false);
  });
});

describe("AccountService plan, credit and billing", () => {
  async function signedIn(me: object, billing?: { status?: number; body?: unknown }) {
    const t = setup();
    t.api.on("GET /v1/me", { body: { ...USER, ...me } });
    if (billing) t.api.on("GET /v1/me/billing", billing);
    await t.account.signIn();
    return t;
  }

  it("brainAccount: credit or an active paid plan makes the hosted AI usable", async () => {
    const free0 = await signedIn({ plan: FREE_PLAN, credit: credit(0, 0) }, { body: { plan: FREE_PLAN, credit: credit(0, 0), stripeConfigured: true } });
    expect(free0.account.brainAccount()).toEqual({ signedIn: true, hostedUsable: false, outOfCredit: true });
    const topped = await signedIn({}, { body: { plan: FREE_PLAN, credit: credit(0, 1000), stripeConfigured: true } });
    expect(topped.account.brainAccount()).toEqual({ signedIn: true, hostedUsable: true, outOfCredit: false });
    const plus = await signedIn({}, { body: { plan: PLUS_PLAN, credit: credit(0, 0), stripeConfigured: true } });
    expect(plus.account.brainAccount().hostedUsable).toBe(true);
    expect(setup().account.brainAccount()).toEqual({ signedIn: false, hostedUsable: false, outOfCredit: false });
  });

  it("a 402 marks the account out of credit with the top-up link until the credit is back", async () => {
    const t = await signedIn({}, { body: { plan: FREE_PLAN, credit: credit(0, 500), stripeConfigured: true } });
    await t.account.markOutOfCredit("https://api.test/billing");
    expect(t.account.brainAccount()).toMatchObject({ hostedUsable: false, outOfCredit: true });
    expect((await t.account.view()).outOfCredit).toEqual({ topupUrl: "https://api.test/billing" });
    t.api.on("GET /v1/me/billing", { body: { plan: FREE_PLAN, credit: credit(0, 2500), stripeConfigured: true } });
    await t.account.refresh(true);
    expect((await t.account.view()).outOfCredit).toBeUndefined();
    expect(t.account.brainAccount().hostedUsable).toBe(true);
  });

  it("a server without billing (404 on /v1/me/billing) reports stripeConfigured false and uses /v1/me's plan", async () => {
    const t = await signedIn({ plan: FREE_PLAN, credit: credit(0, 0) }, { status: 404, body: { error: "not found" } });
    expect(await t.account.view()).toMatchObject({ stripeConfigured: false, plan: FREE_PLAN });
  });

  it("billing links: checkout, top-up and portal send returnUrl; 503 says billing is not set up", async () => {
    const t = await signedIn({});
    const ret = "chrome-extension://bfff/options.html";
    t.api.on("POST /v1/billing/checkout", { body: { url: "https://checkout.stripe.test/c1" } });
    t.api.on("POST /v1/billing/topup", { body: { url: "https://checkout.stripe.test/t1" } });
    t.api.on("POST /v1/billing/portal", { body: { url: "https://billing.stripe.test/p1" } });
    expect(await t.account.billingLink({ action: "checkout", plan: "plus", returnUrl: ret })).toBe("https://checkout.stripe.test/c1");
    expect(await t.account.billingLink({ action: "topup", amountCents: 2500, returnUrl: ret })).toBe("https://checkout.stripe.test/t1");
    expect(await t.account.billingLink({ action: "portal", returnUrl: ret })).toBe("https://billing.stripe.test/p1");
    const bodies = t.api.calls.filter((c) => c.path.startsWith("/v1/billing/")).map((c) => [c.path, c.body]);
    expect(bodies).toEqual([
      ["/v1/billing/checkout", { plan: "plus", returnUrl: ret }],
      ["/v1/billing/topup", { amountCents: 2500, returnUrl: ret }],
      ["/v1/billing/portal", { returnUrl: ret }],
    ]);
    t.api.on("POST /v1/billing/topup", { status: 503, body: { error: "Billing is not set up on this server yet" } });
    await expect(t.account.billingLink({ action: "topup", amountCents: 1000, returnUrl: ret })).rejects.toThrow(BILLING_NOT_SET_UP);
    expect((await t.account.view()).stripeConfigured).toBe(false);
  });

  it("changing an existing paid plan: checkout 409 { portal: true } opens the portal instead", async () => {
    const t = await signedIn({});
    t.api.on("POST /v1/billing/checkout", { status: 409, body: { error: "already subscribed", portal: true } });
    t.api.on("POST /v1/billing/portal", { body: { url: "https://billing.stripe.test/p2" } });
    expect(await t.account.billingLink({ action: "checkout", plan: "pro", returnUrl: "chrome-extension://x/options.html" })).toBe("https://billing.stripe.test/p2");
  });

  it("API keys: list, create (the key is returned once), revoke", async () => {
    const t = await signedIn({});
    t.api.on("GET /v1/me/keys", { body: { keys: [{ id: "k1", name: "laptop", role: "runner", createdAt: "2026-09-01T00:00:00Z", revokedAt: null }] } });
    t.api.on("POST /v1/me/keys", (c) => ({ status: 201, body: { id: "k2", ...(c.body as object), key: "bt_newkey" } }));
    t.api.on("DELETE /v1/me/keys/k1", { status: 204 });
    expect(await t.account.listKeys()).toHaveLength(1);
    expect(await t.account.createKey("scheduler", "creator")).toEqual({ id: "k2", name: "scheduler", role: "creator", key: "bt_newkey" });
    await t.account.revokeKey("k1");
    expect(t.api.calls.filter((c) => c.path.startsWith("/v1/me/keys")).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/me/keys",
      "POST /v1/me/keys",
      "DELETE /v1/me/keys/k1",
    ]);
  });
});

describe("AccountService: moving local tasks into the account", () => {
  it("offers the pending and paused local tasks, uploads them with their files, then deletes them locally", async () => {
    const t = setup();
    t.local.rows.push(
      { id: "L1", status: "pending", instructions: "Post gm", account: "alpha", notBefore: "2026-09-25T09:00:00.000Z", mediaIds: ["m1"], repeat: { dailyAt: ["09:00"] } },
      { id: "L2", status: "paused", instructions: "Check mail", account: null, notBefore: null, mediaIds: [], repeat: null },
      { id: "L3", status: "done", instructions: "Old", account: null, notBefore: null, mediaIds: [], repeat: null },
    );
    await t.account.signIn();
    expect((await t.account.view()).localTasks).toBe(2);
    let n = 0;
    t.api.on("POST /v1/media", () => ({ status: 201, body: { id: `M${++n}`, filename: "m1.jpg", contentType: "image/jpeg", size: 3 } }));
    t.api.on("POST /v1/tasks", (c) => ({ status: 201, body: task(`A${n}`, c.body as object) }));
    const r = await t.account.migrateLocalTasks();
    expect(r).toEqual({ moved: 2, failed: 0, errors: [] });
    const creates = t.api.calls.filter((c) => c.path === "/v1/tasks").map((c) => c.body);
    expect(creates).toEqual([
      { instructions: "Post gm", account: "alpha", notBefore: "2026-09-25T09:00:00.000Z", mediaIds: ["M1"], repeat: { dailyAt: ["09:00"] }, tz: "Asia/Seoul" },
      { instructions: "Check mail" },
    ]);
    expect(t.api.calls.find((c) => c.path === "/v1/media")!.body).toEqual({ file: { name: "m1.jpg", size: 3, type: "image/jpeg" } });
    expect(t.local.deleted).toEqual(["L1", "L2"]);
    expect((await t.account.view()).localTasks).toBeUndefined();
  });

  it("keeps the tasks that failed to upload, and keeps offering", async () => {
    const t = setup();
    t.local.rows.push(
      { id: "L1", status: "pending", instructions: "ok", account: null, notBefore: null, mediaIds: [], repeat: null },
      { id: "L2", status: "pending", instructions: "bad", account: null, notBefore: null, mediaIds: [], repeat: null },
    );
    await t.account.signIn();
    t.api.on("POST /v1/tasks", (c) => ((c.body as any).instructions === "bad" ? { status: 400, body: { error: "invalid" } } : { status: 201, body: task("A1") }));
    const r = await t.account.migrateLocalTasks();
    expect(r.moved).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toMatch(/bad: .*invalid/);
    expect(t.local.deleted).toEqual(["L1"]);
    expect((await t.account.view()).localTasks).toBe(1);
  });

  it("Not now hides the offer until the next sign-in", async () => {
    const t = setup();
    t.local.rows.push({ id: "L1", status: "pending", instructions: "x", account: null, notBefore: null, mediaIds: [], repeat: null });
    await t.account.signIn();
    await t.account.dismissMigration();
    expect((await t.account.view()).localTasks).toBeUndefined();
    await t.account.signOut();
    await t.account.signIn();
    expect((await t.account.view()).localTasks).toBe(1);
  });
});

describe("AccountService.runnerApi", () => {
  it("claims with the session token as the bearer; a 401 signs out", async () => {
    const t = setup();
    await t.account.signIn();
    t.api.on("POST /v1/runner/claim", { status: 204 });
    const runner = (await t.account.runnerApi())!;
    expect(await runner.claim("r1")).toBeNull();
    expect(t.api.calls.at(-1)!.headers.authorization).toBe("Bearer bt_s_abc");
    t.api.on("POST /v1/runner/claim", { status: 401, body: { error: "expired" } });
    await expect(runner.claim("r1")).rejects.toThrow(/401/);
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.account.runnerApi()).toBeNull();
  });
});
