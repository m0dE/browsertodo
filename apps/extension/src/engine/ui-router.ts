/**
 * Background side of ui-protocol.ts: answers every UiRequest. The pushes to
 * the side panel are in ui-hub.ts.
 */
import { redactSettings, type ExtensionSettings, type HelperInfo, type HelperMethods, type SessionInfo } from "@browsertodo/shared";
import type { AccountView, ApiKeyInfo, BrainStatus, PlanId, UiRequest, UiResponse, UiResults, UiState } from "../ui-protocol.js";
import { LocalTodo, type TodoSource } from "../account/todo-source.js";
import { errText } from "../errors.js";
import type { LocalStore } from "./local-store.js";
import { uploadToBlob } from "./local-store.js";
import type { AdhocInput } from "./run/jobs.js";
import type { RunnerState } from "./run/state.js";
import type { SessionStore } from "./sessions.js";
import type { TestResult } from "./settings-tests.js";

export interface RouterRunner {
  readonly running: SessionInfo | null;
  readonly runningSessions: SessionInfo[];
  state(): Promise<RunnerState>;
  runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }>;
  runAdhoc(input: AdhocInput): Promise<{ sessionId: string }>;
  continueSession(sessionId: string, note?: string): Promise<{ sessionId: string }>;
  message(sessionId: string | undefined, text: string, opts?: { tabId?: number }): Promise<UiResults["run.message"]>;
  newChat(sessionId?: string): Promise<{ ok: boolean }>;
  stop(sessionId?: string): boolean;
  say(text: string, sessionId?: string): Promise<boolean>;
  pauseSchedule(reason?: string): Promise<void>;
  resumeSchedule(): Promise<void>;
}

export interface RouterVault {
  unlock(passphrase: string): Promise<void>;
  lock(): Promise<void>;
  list(): Promise<{ locked: boolean; sites: string[] }>;
  set(site: string, username: string, password: string): Promise<void>;
  delete(site: string): Promise<void>;
}

/** The account side the router uses (AccountService). */
export interface RouterAccount {
  view(): Promise<AccountView>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
  migrateLocalTasks(): Promise<{ moved: number; failed: number; errors: string[] }>;
  dismissMigration(): Promise<void>;
  billingLink(req: { action: "checkout" | "topup" | "portal"; plan?: PlanId; amountCents?: number; returnUrl: string }): Promise<string>;
  listKeys(): Promise<ApiKeyInfo[]>;
  createKey(name: string, role: "creator" | "runner"): Promise<{ id: string; name: string; role: string; key: string }>;
  revokeKey(id: string): Promise<void>;
}

export interface UiRouterDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** settings.save semantics (secrets: omitted keep, "" clear). */
  saveSettingsPatch(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  runner: RouterRunner;
  /** Brings the session's agent tab (default: the first agent tab) to the front. */
  showAgent(sessionId?: string): Promise<boolean>;
  localStore: LocalStore;
  sessions: SessionStore;
  /** Conversations with an open agent session (both brains). */
  openConversations(): string[];
  helper: {
    readonly info: HelperInfo | null;
    readonly lastError: string | null;
    connect(timeoutMs?: number, opts?: { selfTest?: boolean }): Promise<HelperInfo>;
    call<M extends "helper.getLog" | "helper.runLog">(method: M, params: HelperMethods[M]["params"], opts?: { timeoutMs?: number }): Promise<HelperMethods[M]["result"]>;
  };
  brainStatus(settings: ExtensionSettings): BrainStatus;
  nextRunAt(): Promise<string | undefined>;
  testClaude(settings: ExtensionSettings): Promise<TestResult>;
  testJev(settings: ExtensionSettings): Promise<TestResult>;
  testCloud(settings: ExtensionSettings): Promise<TestResult>;
  vault: RouterVault;
  /** The browsertodo account. Absent: no account features (always signed out). */
  account?: RouterAccount;
  /** The TODO tab's tasks: the account's when signed in, else the local store. */
  todo?(): Promise<TodoSource>;
  /** Which conversation belongs to which browser tab. Absent: chats are not per tab. */
  tabChats?: {
    all(): Promise<Record<string, string>>;
    bind(tabId: number, sessionId: string): Promise<void>;
    unbind(tabId: number, sessionId?: string): Promise<string | null>;
  };
  /** The tabs each running session acts in (session id -> tab ids). */
  runningTabs?(): Promise<Record<string, number[]>>;
  /** Activates a browser tab and focuses its window. */
  focusTab?(tabId: number): Promise<boolean>;
}

/** A request outside ui-protocol.ts that the router also answers (the e2e suite reads the helper log with it). */
export type ExtraRequest = { type: "helper.getLog"; lines: number };

export class UiRouter {
  constructor(private readonly deps: UiRouterDeps) {}

  async getState(): Promise<UiState> {
    const d = this.deps;
    // The account first: the brain status reads its cached credit.
    const account = d.account ? await d.account.view().catch(() => undefined) : undefined;
    const settings = await d.loadSettings();
    const rs = await d.runner.state();
    const state: UiState = {
      settings: redactSettings(settings),
      brain: d.brainStatus(settings),
      running: d.runner.running,
      runningSessions: d.runner.runningSessions,
      paused: settings.paused,
      openConversations: d.openConversations(),
    };
    if (account) state.account = account;
    if (d.tabChats) state.tabChats = await d.tabChats.all().catch(() => ({}));
    if (d.runningTabs) state.runningTabs = await d.runningTabs().catch(() => ({}));
    if (settings.paused && rs.pausedReason) state.pausedReason = rs.pausedReason;
    if (rs.lastRunAt) state.lastRunAt = rs.lastRunAt;
    if (rs.lastError) state.lastError = rs.lastError;
    const next = await d.nextRunAt().catch(() => undefined);
    if (next) state.nextRunAt = next;
    return state;
  }

  private account(): RouterAccount {
    if (!this.deps.account) throw new Error("Accounts are not available");
    return this.deps.account;
  }

  /** The conversation belongs to the browser tab its request came from. */
  private async bindTab(tabId: unknown, sessionId: string | undefined): Promise<void> {
    const tab = optTab(tabId);
    if (tab !== undefined && sessionId && this.deps.tabChats) await this.deps.tabChats.bind(tab, sessionId);
  }

  private async todo(): Promise<TodoSource> {
    if (this.deps.todo) return this.deps.todo();
    return new LocalTodo(this.deps.localStore);
  }

  /** Answers one request; errors become { ok: false, error }. */
  async handle(msg: UiRequest | ExtraRequest): Promise<UiResponse> {
    try {
      return { ok: true, data: await this.dispatch(msg) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  private async dispatch(msg: UiRequest | ExtraRequest): Promise<unknown> {
    const d = this.deps;
    switch (msg.type) {
      case "state.get":
        return this.getState();
      case "settings.save":
        await d.saveSettingsPatch(msg.settings ?? {});
        return this.getState();
      case "settings.testClaude":
        return d.testClaude(await d.loadSettings()) satisfies Promise<UiResults["settings.testClaude"]>;
      case "settings.testJev":
        return d.testJev(await d.loadSettings());
      case "settings.testCloud":
        return d.testCloud(await d.loadSettings());
      case "helper.connect":
        // Connects (or reconnects) and re-runs the Claude Code self-test.
        // Failure is not an error: the state carries brain.helperError.
        await d.helper.connect(undefined, { selfTest: true }).catch(() => undefined);
        return this.getState();
      case "run.adhoc": {
        const input: AdhocInput = {
          instructions: msg.instructions,
          account: msg.account ?? null,
          media: (msg.media ?? []).map((m) => ({ name: m.name, blob: uploadToBlob(m) })),
        };
        const tab = optTab(msg.tabId);
        if (tab !== undefined) input.tabId = tab;
        return d.runner.runAdhoc(input) satisfies Promise<UiResults["run.adhoc"]>;
      }
      case "run.continue": {
        if (typeof msg.sessionId !== "string" || !msg.sessionId) throw new Error("sessionId is required");
        const note = typeof msg.text === "string" ? msg.text.trim() : "";
        // Continued from a tab: the conversation goes on there.
        await this.bindTab(msg.tabId, msg.sessionId);
        return d.runner.continueSession(msg.sessionId, note || undefined) satisfies Promise<UiResults["run.continue"]>;
      }
      case "run.message": {
        const text = typeof msg.text === "string" ? msg.text : "";
        const sessionId = optId(msg.sessionId);
        const tab = optTab(msg.tabId);
        if (sessionId && text.trim()) await this.bindTab(tab, sessionId);
        return d.runner.message(sessionId, text, tab === undefined ? {} : { tabId: tab }) satisfies Promise<UiResults["run.message"]>;
      }
      case "run.newChat": {
        const tab = optTab(msg.tabId);
        if (tab !== undefined && d.tabChats) await d.tabChats.unbind(tab, optId(msg.sessionId));
        return d.runner.newChat(optId(msg.sessionId)) satisfies Promise<UiResults["run.newChat"]>;
      }
      case "tab.focus": {
        const tab = optTab(msg.tabId);
        if (tab === undefined) throw new Error("tabId is required");
        return { ok: d.focusTab ? await d.focusTab(tab) : false } satisfies UiResults["tab.focus"];
      }
      case "chat.bind": {
        const sessionId = optId(msg.sessionId);
        const tab = optTab(msg.tabId);
        if (!sessionId || tab === undefined) throw new Error("sessionId and tabId are required");
        if (!d.tabChats) throw new Error("Chats are not per tab here");
        const session = await d.sessions.get(sessionId);
        if (!session) throw new Error(`No session ${sessionId}`);
        await d.tabChats.bind(tab, sessionId);
        return this.getState() satisfies Promise<UiResults["chat.bind"]>;
      }
      case "session.log": {
        const session = await d.sessions.get(String(msg.sessionId ?? ""));
        if (!session) throw new Error(`No session ${String(msg.sessionId)}`);
        if (!session.logPath) throw new Error("This session has no run log (only Claude Code sessions do)");
        if (!d.helper.info) throw new Error("The helper is not connected");
        const log = await d.helper.call("helper.runLog", { path: session.logPath }, { timeoutMs: 15_000 });
        return { path: session.logPath, ...log } satisfies UiResults["session.log"];
      }
      case "run.due":
        return d.runner.runDue("manual");
      case "run.stop":
        return { ok: d.runner.stop(optId(msg.sessionId)) } satisfies UiResults["run.stop"];
      case "agent.show":
        return { ok: await d.showAgent(optId(msg.sessionId)) } satisfies UiResults["agent.show"];
      case "run.say":
        return { ok: await d.runner.say(String(msg.text ?? ""), optId(msg.sessionId)) } satisfies UiResults["run.say"];
      case "schedule.pause":
        await d.runner.pauseSchedule();
        return this.getState();
      case "schedule.resume":
        await d.runner.resumeSchedule();
        return this.getState();
      case "tasks.list": {
        const todo = await this.todo();
        return { tasks: await todo.list(), source: todo.kind } satisfies UiResults["tasks.list"];
      }
      case "tasks.add":
        return {
          task: await (await this.todo()).add({
            instructions: msg.instructions,
            account: msg.account ?? null,
            notBefore: msg.notBefore ?? null,
            repeat: msg.repeat ?? null,
            media: msg.media ?? [],
          }),
        } satisfies UiResults["tasks.add"];
      case "tasks.update":
        return { task: await (await this.todo()).update(msg.id, msg.patch ?? {}) } satisfies UiResults["tasks.update"];
      case "tasks.delete":
        return { ok: await (await this.todo()).delete(msg.id) } satisfies UiResults["tasks.delete"];
      case "tasks.retry":
        return { task: await (await this.todo()).retry(msg.id) } satisfies UiResults["tasks.retry"];
      case "tasks.cancel":
        return { task: await (await this.todo()).cancel(msg.id) } satisfies UiResults["tasks.cancel"];
      case "account.signIn":
        await this.account().signIn();
        return this.getState();
      case "account.signOut":
        await this.account().signOut();
        return this.getState();
      case "account.refresh":
        await this.account().refresh(msg.force === true);
        return this.getState();
      case "account.migrate": {
        const r = await this.account().migrateLocalTasks();
        return { ...r, state: await this.getState() } satisfies UiResults["account.migrate"];
      }
      case "account.dismissMigration":
        await this.account().dismissMigration();
        return this.getState();
      case "account.billing": {
        if (!["checkout", "topup", "portal"].includes(msg.action)) throw new Error(`Unknown billing action ${String(msg.action)}`);
        const req: Parameters<RouterAccount["billingLink"]>[0] = { action: msg.action, returnUrl: String(msg.returnUrl ?? "") };
        if (msg.plan) req.plan = msg.plan;
        if (typeof msg.amountCents === "number") req.amountCents = msg.amountCents;
        return { url: await this.account().billingLink(req) } satisfies UiResults["account.billing"];
      }
      case "account.keys.list":
        return { keys: await this.account().listKeys() } satisfies UiResults["account.keys.list"];
      case "account.keys.create": {
        const name = String(msg.name ?? "").trim();
        if (!name) throw new Error("Give the key a name");
        if (msg.role !== "creator" && msg.role !== "runner") throw new Error("The role must be creator or runner");
        return this.account().createKey(name, msg.role) satisfies Promise<UiResults["account.keys.create"]>;
      }
      case "account.keys.revoke":
        await this.account().revokeKey(String(msg.id ?? ""));
        return { ok: true } satisfies UiResults["account.keys.revoke"];
      case "sessions.list":
        return { sessions: await d.sessions.list(msg.limit ?? 50) } satisfies UiResults["sessions.list"];
      case "sessions.events": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        return { session, events: await d.sessions.eventsOf(msg.sessionId) } satisfies UiResults["sessions.events"];
      }
      case "helper.getLog":
        if (!d.helper.info) return { text: "" };
        return d.helper.call("helper.getLog", { lines: Math.max(1, Math.min(2000, Math.trunc(msg.lines) || 200)) }, { timeoutMs: 10_000 });
      case "vault.unlock":
        await d.vault.unlock(msg.passphrase);
        return { ok: true };
      case "vault.lock":
        await d.vault.lock();
        return { ok: true };
      case "vault.list":
        return d.vault.list();
      case "vault.set":
        await d.vault.set(msg.site, msg.username, msg.password);
        return { ok: true };
      case "vault.delete":
        await d.vault.delete(msg.site);
        return { ok: true };
      default:
        throw new Error(`Unknown request type: ${String((msg as { type?: unknown }).type)}`);
    }
  }
}

/** A browser tab id from a UI message, or undefined. */
function optTab(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** A session id from a UI message, or undefined. */
function optId(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
