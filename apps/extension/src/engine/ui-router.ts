/**
 * Background side of ui-protocol.ts: answers every UiRequest. The pushes to
 * the side panel are in ui-hub.ts.
 */
import { errorMessage, IssuableKeyRole, redactSettings, type ExtensionSettings, type HelperInfo, type HelperMethods } from "@browsertodo/shared";
import type { AccountService } from "../account/account.js";
import { LocalTodo, type TodoSource } from "../account/todo-source.js";
import { HELPER_CALL_TIMEOUT_MS } from "../helper-link.js";
import type { BrainStatus, UiRequest, UiResponse, UiResults, UiState } from "../ui-protocol.js";
import { realtimeTicketForPanel, voiceEnginesForPanel, type RealtimeAccount } from "../voice/realtime-access.js";
import { transcribeForPanel, type VoiceAccount } from "../voice/transcribe.js";
import type { LocalStore } from "./local-store.js";
import { uploadToBlob } from "./local-store.js";
import type { AdhocInput } from "./run/jobs.js";
import type { Runner } from "./runner.js";
import type { SessionStore } from "./sessions.js";
import type { TestResult } from "./settings-tests.js";
import { WrongPassphraseError, type Vault } from "../vault.js";

/** The runner as the router uses it. */
export type RouterRunner = Pick<
  Runner,
  "running" | "runningSessions" | "state" | "runDue" | "runAdhoc" | "continueSession" | "message" | "newChat" | "stop" | "say" | "pauseSchedule" | "resumeSchedule"
>;

export type RouterVault = Pick<Vault, "unlock" | "lock" | "list" | "set" | "delete" | "reset">;

/** The account side the router uses, and voice (one WAV clip to text; the Realtime voice engines and session). */
export type RouterAccount = Pick<
  AccountService,
  "view" | "signIn" | "signOut" | "refresh" | "migrateLocalTasks" | "dismissMigration" | "listKeys" | "createKey" | "revokeKey"
> &
  VoiceAccount &
  Partial<RealtimeAccount>;

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
    call<M extends "helper.getLog">(method: M, params: HelperMethods[M]["params"], opts?: { timeoutMs?: number }): Promise<HelperMethods[M]["result"]>;
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

/** The helper log's last lines for helper.getLog: by default, and at most. */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;

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

  private async todo(): Promise<TodoSource> {
    if (this.deps.todo) return this.deps.todo();
    return new LocalTodo(this.deps.localStore);
  }

  /** Answers one request; errors become { ok: false, error }. */
  async handle(msg: UiRequest | ExtraRequest): Promise<UiResponse> {
    try {
      return { ok: true, data: await this.dispatch(msg) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
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
          instructions: typeof msg.instructions === "string" ? msg.instructions : "",
          account: msg.account ?? null,
          media: (msg.media ?? []).map((m) => ({ name: m.name, blob: uploadToBlob(m) })),
        };
        const tab = optTab(msg.tabId);
        if (tab !== undefined) input.tabId = tab;
        if (msg.screen === true) input.screen = true;
        return d.runner.runAdhoc(input) satisfies Promise<UiResults["run.adhoc"]>;
      }
      case "run.continue": {
        if (typeof msg.sessionId !== "string" || !msg.sessionId) throw new Error("sessionId is required");
        const note = typeof msg.text === "string" ? msg.text.trim() : "";
        const tab = optTab(msg.tabId);
        // Continued from a tab: the conversation goes on there (the runner binds it once the turn is taken).
        return d.runner.continueSession(msg.sessionId, note || undefined, tab === undefined ? {} : { tabId: tab }) satisfies Promise<UiResults["run.continue"]>;
      }
      case "run.message": {
        const text = typeof msg.text === "string" ? msg.text : "";
        const sessionId = optId(msg.sessionId);
        const tab = optTab(msg.tabId);
        const screen = msg.screen === true;
        // Sent from a tab: the runner binds the conversation to it once the message is taken.
        return d.runner.message(sessionId, text, { ...(tab === undefined ? {} : { tabId: tab }), ...(screen ? { screen } : {}) }) satisfies Promise<UiResults["run.message"]>;
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
        return { ...(await todo.list()), source: todo.kind } satisfies UiResults["tasks.list"];
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
      case "account.keys.list":
        return { keys: await this.account().listKeys() } satisfies UiResults["account.keys.list"];
      case "account.keys.create": {
        const name = String(msg.name ?? "").trim();
        if (!name) throw new Error("Give the key a name");
        if (!IssuableKeyRole.safeParse(msg.role).success) throw new Error(`The role must be ${IssuableKeyRole.options.join(" or ")}`);
        return this.account().createKey(name, msg.role) satisfies Promise<UiResults["account.keys.create"]>;
      }
      case "account.keys.revoke":
        await this.account().revokeKey(String(msg.id ?? ""));
        return { ok: true } satisfies UiResults["account.keys.revoke"];
      case "sessions.list":
        return { sessions: await d.sessions.list(msg.limit ?? 50, msg.taskId) } satisfies UiResults["sessions.list"];
      case "sessions.events": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        return { session, events: await d.sessions.eventsOf(msg.sessionId) } satisfies UiResults["sessions.events"];
      }
      case "helper.getLog":
        if (!d.helper.info) return { text: "" };
        return d.helper.call("helper.getLog", { lines: Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(msg.lines) || DEFAULT_LOG_LINES)) }, { timeoutMs: HELPER_CALL_TIMEOUT_MS });
      case "vault.unlock":
        try {
          await d.vault.unlock(msg.passphrase);
        } catch (err) {
          if (err instanceof WrongPassphraseError) return { ok: false } satisfies UiResults["vault.unlock"];
          throw err;
        }
        return { ok: true } satisfies UiResults["vault.unlock"];
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
      case "vault.reset":
        await d.vault.reset();
        return { ok: true } satisfies UiResults["vault.reset"];
      case "voice.transcribe":
        return transcribeForPanel(d.account, {
          wav: String(msg.wav ?? ""),
          speechMs: Number(msg.speechMs) || 0,
          ...(typeof msg.context === "string" ? { context: msg.context } : {}),
          ...(typeof msg.sessionId === "string" ? { sessionId: msg.sessionId } : {}),
        }) satisfies Promise<UiResults["voice.transcribe"]>;
      case "voice.engines":
        return voiceEnginesForPanel(realtimeAccount(d.account)) satisfies Promise<UiResults["voice.engines"]>;
      case "voice.realtime":
        return realtimeTicketForPanel(realtimeAccount(d.account), optId(msg.sessionId)) satisfies Promise<UiResults["voice.realtime"]>;
      default:
        throw new Error(`Unknown request type: ${String((msg as { type?: unknown }).type)}`);
    }
  }
}

/** The account's Realtime voice side, when it has one. */
function realtimeAccount(a: RouterAccount | undefined): RealtimeAccount | undefined {
  return a?.voiceEngines && a.realtimeSession ? { voiceEngines: () => a.voiceEngines!(), realtimeSession: () => a.realtimeSession!() } : undefined;
}

/** A browser tab id from a UI message, or undefined. */
function optTab(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** A session id from a UI message, or undefined. */
function optId(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
