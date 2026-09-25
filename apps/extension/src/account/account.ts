/**
 * The browsertodo account in the background: the Google sign-in, the
 * session token (chrome.storage.local), the cached profile, plan and credit,
 * the out-of-credit flag, billing links, API keys, and moving local tasks
 * into the account after the first sign-in.
 *
 * A session belongs to the server it was issued by: when the account server
 * URL setting changes, the extension is signed out of it.
 */
import type { ExtensionSettings } from "@browsertodo/shared";
import { ApiClient } from "../api-client.js";
import { errText } from "../errors.js";
import type { StorageLike } from "../engine/kv.js";
import type { AccountView } from "../ui-protocol.js";
import { AccountApi, AccountApiError } from "./account-api.js";
import { googleIdToken, SIGN_IN_NOT_SET_UP, SignInError } from "./google-auth.js";
import { isPaidActive, type ApiKeyInfo, type BillingInfo, type CreditInfo, type Me, type PlanId, type PlanInfo } from "./types.js";

export const ACCOUNT_KEY = "account";
/** Profile and credit are refetched when older than this (or on demand). */
const INFO_MAX_AGE_MS = 60_000;
export const BILLING_NOT_SET_UP = "Billing is not set up on this server yet";

export interface StoredSession {
  token: string;
  user: { id: string; email: string; name: string | null; pictureUrl: string | null };
  expiresAt: string;
  /** The server that issued it. */
  apiBase: string;
}

export interface StoredAccount {
  session?: StoredSession;
  info?: {
    plan?: PlanInfo;
    credit?: CreditInfo;
    /** undefined: not known (the server has no billing route yet). */
    stripeConfigured?: boolean;
    fetchedAt: string;
    error?: string;
  };
  /** A hosted AI request was refused with 402 (cleared when credit is back). */
  outOfCredit?: { topupUrl: string; at: string };
  /** "Not now" on the offer to move local tasks into the account. */
  migrationDismissed?: boolean;
}

/** What the brain resolver needs to know about the account. */
export interface BrainAccount {
  signedIn: boolean;
  /** Signed in with AI credit left, or on an active paid plan. */
  hostedUsable: boolean;
  outOfCredit: boolean;
}

export interface MigrationResult {
  moved: number;
  failed: number;
  errors: string[];
}

export interface AccountLocalTasks {
  list(): Promise<{ id: string; status: string; instructions: string; account: string | null; notBefore: string | null; mediaIds: string[]; repeat: { dailyAt: string[] } | null }[]>;
  getMedia(ids: string[]): Promise<{ id: string; name: string; blob: Blob }[]>;
  delete(id: string): Promise<boolean>;
}

export interface AccountServiceDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** Built-in Google OAuth client ID ("" = sign-in not set up). */
  clientId: string;
  identity?: { redirectUri(): string; launch(url: string): Promise<string | undefined> };
  localTasks: AccountLocalTasks;
  storage?: StorageLike;
  fetch?: typeof fetch;
  now?(): Date;
  /** The IANA time zone repeats run in (default: the browser's). */
  timeZone?(): string;
  onChange?(): void;
  log?(message: string): void;
}

/** The dashboard lives at the API origin (e.g. https://browsertodo-api.example.com/). */
export function dashboardUrl(apiBase: string): string {
  try {
    return `${new URL(apiBase).origin}/`;
  } catch {
    return "";
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Active local tasks that can move to the account (running ones stay until they end). */
const movable = (t: { status: string }) => t.status === "pending" || t.status === "paused";

export class AccountService {
  private cache: StoredAccount | null = null;
  private loading: Promise<StoredAccount> | null = null;
  private refreshing: Promise<void> | null = null;
  /** The accountApiBase setting as last read (sessions of other servers do not count). */
  private apiBase = "";

  constructor(private readonly deps: AccountServiceDeps) {}

  /** Reads the stored account once; later calls return the cache. */
  async load(): Promise<StoredAccount> {
    if (this.cache) {
      this.apiBase = (await this.deps.loadSettings()).accountApiBase;
      return this.cache;
    }
    this.loading ??= (async () => {
      const [got, settings] = await Promise.all([this.storage().get(ACCOUNT_KEY), this.deps.loadSettings()]);
      this.apiBase = settings.accountApiBase;
      this.cache = (got[ACCOUNT_KEY] as StoredAccount | undefined) ?? {};
      return this.cache;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  /** The usable session (right server, not expired), from the cache. */
  session(): StoredSession | null {
    const s = this.cache?.session;
    if (!s || !this.apiBase || s.apiBase !== this.apiBase) return null;
    if (Date.parse(s.expiresAt) <= this.now().getTime()) return null;
    return s;
  }

  /** Synchronous view for the brain resolver (call load() first). */
  brainAccount(): BrainAccount {
    const s = this.session();
    if (!s) return { signedIn: false, hostedUsable: false, outOfCredit: false };
    const info = this.cache?.info;
    const credit = info?.credit?.totalCents ?? 0;
    const outOfCredit = !!this.cache?.outOfCredit;
    const hostedUsable = (credit > 0 && !outOfCredit) || isPaidActive(info?.plan);
    return { signedIn: true, hostedUsable, outOfCredit: outOfCredit || (!!info?.credit && credit <= 0) };
  }

  /** The account as the UI shows it. */
  async view(): Promise<AccountView> {
    await this.load();
    const base = this.apiBase;
    const view: AccountView = { signedIn: false, signInConfigured: !!this.deps.clientId, apiBase: base, dashboardUrl: dashboardUrl(base) };
    const s = this.session();
    if (!s) return view;
    view.signedIn = true;
    view.user = { email: s.user.email, name: s.user.name, pictureUrl: s.user.pictureUrl };
    const a = this.cache!;
    if (a.info?.plan) view.plan = a.info.plan;
    if (a.info?.credit) view.credit = a.info.credit;
    if (a.info?.stripeConfigured !== undefined) view.stripeConfigured = a.info.stripeConfigured;
    if (a.info?.error) view.error = a.info.error;
    if (a.info?.fetchedAt) view.fetchedAt = a.info.fetchedAt;
    const brain = this.brainAccount();
    if (brain.outOfCredit) view.outOfCredit = { topupUrl: a.outOfCredit?.topupUrl || view.dashboardUrl };
    if (!a.migrationDismissed) {
      try {
        const n = (await this.deps.localTasks.list()).filter(movable).length;
        if (n) view.localTasks = n;
      } catch {
        /* the offer just does not show */
      }
    }
    return view;
  }

  /** The signed-in account's API client. Throws when signed out. */
  async api(): Promise<AccountApi> {
    await this.load();
    const s = this.session();
    if (!s) throw new Error("Not signed in");
    return this.apiFor(s);
  }

  /** The runner's task source for the signed-in account (claim/heartbeat/result with the session token), or null. */
  async runnerApi(): Promise<ApiClient | null> {
    await this.load();
    const s = this.session();
    if (!s) return null;
    const f = this.deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const fetchWatch: typeof fetch = async (input, init) => {
      const res = await f(input, init);
      if (res.status === 401) void this.expire(s.token);
      return res;
    };
    return new ApiClient({ apiBase: s.apiBase, runnerKey: s.token, fetch: fetchWatch });
  }

  async signIn(): Promise<void> {
    const settings = await this.deps.loadSettings();
    if (!this.deps.clientId) throw new SignInError(SIGN_IN_NOT_SET_UP);
    if (!settings.accountApiBase) throw new SignInError("Set the account server URL first (Settings > Advanced)");
    const identity = this.deps.identity;
    if (!identity) throw new SignInError("Sign-in is not available in this browser");
    const idToken = await googleIdToken({ clientId: this.deps.clientId, redirectUri: identity.redirectUri(), launch: (url) => identity.launch(url) });
    const api = new AccountApi(this.apiOpts(settings.accountApiBase));
    let auth;
    try {
      auth = await api.signIn(idToken);
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 503) throw new SignInError(`${err.message} (${settings.accountApiBase})`);
      throw err;
    }
    await this.load();
    this.apiBase = settings.accountApiBase;
    await this.store({
      session: { token: auth.token, user: auth.user, expiresAt: auth.expiresAt, apiBase: settings.accountApiBase },
    });
    await this.refresh(true);
  }

  async signOut(): Promise<void> {
    await this.load();
    const s = this.cache?.session;
    if (s) {
      try {
        await this.apiFor(s).logout();
      } catch (err) {
        this.log(`logout: ${errText(err)}`);
      }
    }
    await this.store({});
  }

  /** Refetches profile, plan, credit and billing (at most once a minute unless forced). */
  async refresh(force = false): Promise<void> {
    await this.load();
    const s = this.session();
    if (!s) return;
    const age = this.now().getTime() - Date.parse(this.cache?.info?.fetchedAt ?? "");
    if (!force && age < INFO_MAX_AGE_MS) return;
    this.refreshing ??= this.doRefresh(s).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(s: StoredSession): Promise<void> {
    const api = this.apiFor(s);
    const fetchedAt = this.now().toISOString();
    let me: Me;
    try {
      me = await api.me();
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 401) return; // expire() signed us out
      await this.store({ ...this.cache, info: { ...this.cache?.info, fetchedAt, error: `Could not load the account: ${errText(err)}` } });
      return;
    }
    let billing: BillingInfo | null = null;
    let stripeConfigured: boolean | undefined;
    try {
      billing = await api.billing();
      stripeConfigured = billing.stripeConfigured;
    } catch (err) {
      // No billing on this server (older API, or Stripe not configured).
      if (err instanceof AccountApiError && (err.status === 404 || err.status === 503)) stripeConfigured = false;
      else this.log(`billing: ${errText(err)}`);
    }
    const plan = billing?.plan ?? me.plan;
    const credit = billing?.credit ?? me.credit;
    const info: NonNullable<StoredAccount["info"]> = { fetchedAt };
    if (plan) info.plan = plan;
    if (credit) info.credit = credit;
    if (stripeConfigured !== undefined) info.stripeConfigured = stripeConfigured;
    const next: StoredAccount = {
      ...this.cache,
      session: { ...s, user: { id: me.id, email: me.email, name: me.name, pictureUrl: me.pictureUrl } },
      info,
    };
    if (credit && credit.totalCents > 0) delete next.outOfCredit;
    await this.store(next);
  }

  /** A hosted request answered 402: show "Out of AI credit" until the credit is back. */
  async markOutOfCredit(topupUrl?: string): Promise<void> {
    await this.load();
    if (!this.session()) return;
    const url = topupUrl || this.cache?.outOfCredit?.topupUrl || dashboardUrl(this.apiBase);
    const info = this.cache?.info;
    const next: StoredAccount = { ...this.cache, outOfCredit: { topupUrl: url, at: this.now().toISOString() } };
    if (info?.credit) next.info = { ...info, credit: { ...info.credit, totalCents: Math.min(0, info.credit.totalCents) } };
    await this.store(next);
  }

  /**
   * A Stripe page for the account: subscribe (checkout), buy credit (topup)
   * or manage billing (portal). Changing an existing paid plan goes through
   * the portal (the server answers checkout with 409 { portal: true }).
   */
  async billingLink(req: { action: "checkout" | "topup" | "portal"; plan?: PlanId; amountCents?: number; returnUrl: string }): Promise<string> {
    const api = await this.api();
    try {
      if (req.action === "checkout") {
        if (!req.plan || req.plan === "free") throw new Error("Pick a paid plan");
        try {
          return await api.billingLink("checkout", { plan: req.plan, returnUrl: req.returnUrl });
        } catch (err) {
          if (err instanceof AccountApiError && err.status === 409 && err.body?.portal) {
            return await api.billingLink("portal", { returnUrl: req.returnUrl });
          }
          throw err;
        }
      }
      if (req.action === "topup") return await api.billingLink("topup", { amountCents: req.amountCents, returnUrl: req.returnUrl });
      return await api.billingLink("portal", { returnUrl: req.returnUrl });
    } catch (err) {
      if (err instanceof AccountApiError && (err.status === 503 || err.status === 404)) {
        if (this.cache?.info) await this.store({ ...this.cache, info: { ...this.cache.info, stripeConfigured: false } });
        throw new Error(BILLING_NOT_SET_UP);
      }
      throw err;
    }
  }

  async listKeys(): Promise<ApiKeyInfo[]> {
    return (await this.api()).listKeys();
  }

  async createKey(name: string, role: "creator" | "runner"): Promise<{ id: string; name: string; role: string; key: string }> {
    return (await this.api()).createKey(name, role);
  }

  async revokeKey(id: string): Promise<void> {
    await (await this.api()).revokeKey(id);
  }

  /** "Not now" on moving local tasks. Asked again after the next sign-in. */
  async dismissMigration(): Promise<void> {
    await this.load();
    await this.store({ ...this.cache, migrationDismissed: true });
  }

  /**
   * Moves the pending and paused local tasks (with their files) into the
   * account. Each task that made it is deleted locally; the others stay.
   */
  async migrateLocalTasks(): Promise<MigrationResult> {
    const api = await this.api();
    const tz = this.deps.timeZone?.() ?? browserTimeZone();
    const tasks = (await this.deps.localTasks.list()).filter(movable);
    const result: MigrationResult = { moved: 0, failed: 0, errors: [] };
    for (const t of tasks) {
      try {
        const mediaIds: string[] = [];
        for (const m of await this.deps.localTasks.getMedia(t.mediaIds)) mediaIds.push((await api.uploadMedia(m.blob, m.name)).id);
        await api.createTask({
          instructions: t.instructions,
          ...(t.account ? { account: t.account } : {}),
          ...(t.notBefore ? { notBefore: t.notBefore } : {}),
          ...(mediaIds.length ? { mediaIds } : {}),
          ...(t.repeat?.dailyAt.length ? { repeat: { dailyAt: t.repeat.dailyAt }, tz } : {}),
        });
        await this.deps.localTasks.delete(t.id);
        result.moved++;
      } catch (err) {
        result.failed++;
        result.errors.push(`${t.instructions.slice(0, 40)}: ${errText(err)}`);
      }
    }
    if (result.failed === 0) await this.store({ ...this.cache, migrationDismissed: true });
    else this.changed();
    return result;
  }

  private apiFor(s: StoredSession): AccountApi {
    return new AccountApi({ ...this.apiOpts(s.apiBase), token: s.token, onUnauthorized: () => void this.expire(s.token) });
  }

  private apiOpts(apiBase: string): { apiBase: string; fetch?: typeof fetch } {
    return this.deps.fetch ? { apiBase, fetch: this.deps.fetch } : { apiBase };
  }

  /** The server no longer accepts this session: signed out. */
  private async expire(token: string): Promise<void> {
    await this.load();
    if (this.cache?.session?.token !== token) return;
    this.log("the account session expired; signed out");
    await this.store({});
  }

  private async store(next: StoredAccount): Promise<void> {
    this.cache = next;
    await this.storage().set({ [ACCOUNT_KEY]: next });
    this.changed();
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      /* UI push errors are not the account's problem */
    }
  }

  private storage(): StorageLike {
    return this.deps.storage ?? (chrome.storage.local as unknown as StorageLike);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(m: string): void {
    this.deps.log?.(m);
  }
}
