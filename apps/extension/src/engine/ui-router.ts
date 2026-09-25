/**
 * Background side of ui-protocol.ts: answers every UiRequest and pushes
 * UiPush messages to the side panel ports.
 */
import { redactSettings, type ExtensionSettings, type HelperInfo, type SessionInfo, type StampedAgentEvent, type TerminalInfo } from "@browsertodo/shared";
import {
  UI_PORT_NAME,
  type BrainStatus,
  type UiPush,
  type UiRequest,
  type UiResponse,
  type UiResults,
  type UiState,
} from "../ui-protocol.js";
import type { LocalStore } from "./local-store.js";
import { uploadToBlob } from "./local-store.js";
import type { AdhocInput, RunnerState } from "./runner.js";
import type { SessionStore } from "./sessions.js";
import type { TestResult } from "./settings-tests.js";

export interface RouterRunner {
  readonly running: SessionInfo | null;
  state(): Promise<RunnerState>;
  runDue(trigger: "alarm" | "manual"): Promise<{ started: boolean; detail?: string }>;
  runAdhoc(input: AdhocInput): Promise<{ sessionId: string }>;
  continueSession(sessionId: string, note?: string): Promise<{ sessionId: string }>;
  stop(): boolean;
  say(text: string): Promise<boolean>;
  pauseSchedule(reason?: string): Promise<void>;
  resumeSchedule(): Promise<void>;
}

export interface RouterTerminal {
  /** The user's own session. */
  readonly current: { terminalId: string } | null;
  /** Every running terminal (task sessions and the user's). Optional so older wiring and tests keep working. */
  list?(): TerminalInfo[];
  start(cols: number, rows: number, jevApiKey?: string): Promise<{ terminalId: string; backlog?: string }>;
  backlog?(terminalId: string): Promise<string>;
  /** terminalId omitted: the user's session. */
  input(data: string, terminalId?: string): Promise<boolean>;
  resize(cols: number, rows: number, terminalId?: string): Promise<boolean>;
  stop(terminalId?: string): Promise<boolean>;
}

export interface RouterVault {
  unlock(passphrase: string): Promise<void>;
  lock(): Promise<void>;
  list(): Promise<{ locked: boolean; sites: string[] }>;
  set(site: string, username: string, password: string): Promise<void>;
  delete(site: string): Promise<void>;
}

export interface UiRouterDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** settings.save semantics (secrets: omitted keep, "" clear). */
  saveSettingsPatch(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
  runner: RouterRunner;
  /** Brings the agent window to the front. Optional so older wiring and tests keep working. */
  showAgent?(): Promise<boolean>;
  localStore: LocalStore;
  sessions: SessionStore;
  terminal: RouterTerminal;
  helper: {
    readonly info: HelperInfo | null;
    readonly lastError: string | null;
    connect(timeoutMs?: number, opts?: { selfTest?: boolean }): Promise<HelperInfo>;
    call?(method: "helper.getLog", params: { lines: number }, opts?: { timeoutMs?: number }): Promise<{ text: string }>;
  };
  brainStatus(settings: ExtensionSettings): BrainStatus;
  nextRunAt(): Promise<string | undefined>;
  testClaude(settings: ExtensionSettings): Promise<TestResult>;
  testJev(settings: ExtensionSettings): Promise<TestResult>;
  testCloud(settings: ExtensionSettings): Promise<TestResult>;
  vault?: RouterVault;
}

/** Requests outside ui-protocol.ts that the router still answers (no UI uses them today). */
export type ExtraRequest =
  | { type: "helper.getLog"; lines: number }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.list" }
  | { type: "vault.set"; site: string; username: string; password: string }
  | { type: "vault.delete"; site: string };

export class UiRouter {
  constructor(private readonly deps: UiRouterDeps) {}

  async getState(): Promise<UiState> {
    const d = this.deps;
    const settings = await d.loadSettings();
    const rs = await d.runner.state();
    const state: UiState = {
      settings: redactSettings(settings),
      brain: d.brainStatus(settings),
      running: d.runner.running,
      paused: settings.paused,
      terminal: d.terminal.current,
      terminals: d.terminal.list?.() ?? (d.terminal.current ? [{ ...d.terminal.current, kind: "user", title: "Claude Code" }] : []),
    };
    if (settings.paused && rs.pausedReason) state.pausedReason = rs.pausedReason;
    if (rs.lastRunAt) state.lastRunAt = rs.lastRunAt;
    if (rs.lastError) state.lastError = rs.lastError;
    const next = await d.nextRunAt().catch(() => undefined);
    if (next) state.nextRunAt = next;
    return state;
  }

  /** Answers one request; errors become { ok: false, error }. */
  async handle(msg: UiRequest | ExtraRequest): Promise<UiResponse> {
    try {
      return { ok: true, data: await this.dispatch(msg) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
        return d.runner.runAdhoc(input) satisfies Promise<UiResults["run.adhoc"]>;
      }
      case "run.continue": {
        if (typeof msg.sessionId !== "string" || !msg.sessionId) throw new Error("sessionId is required");
        const note = typeof msg.text === "string" ? msg.text.trim() : "";
        return d.runner.continueSession(msg.sessionId, note || undefined) satisfies Promise<UiResults["run.continue"]>;
      }
      case "run.due":
        return d.runner.runDue("manual");
      case "run.stop":
        return { ok: d.runner.stop() } satisfies UiResults["run.stop"];
      case "agent.show":
        return { ok: d.showAgent ? await d.showAgent() : false } satisfies UiResults["agent.show"];
      case "run.say":
        return { ok: await d.runner.say(String(msg.text ?? "")) } satisfies UiResults["run.say"];
      case "schedule.pause":
        await d.runner.pauseSchedule();
        return this.getState();
      case "schedule.resume":
        await d.runner.resumeSchedule();
        return this.getState();
      case "tasks.list":
        return { tasks: await d.localStore.listWithMedia() } satisfies UiResults["tasks.list"];
      case "tasks.add":
        return {
          task: await d.localStore.add({
            instructions: msg.instructions,
            account: msg.account ?? null,
            notBefore: msg.notBefore ?? null,
            repeat: msg.repeat ?? null,
            media: msg.media ?? [],
          }),
        } satisfies UiResults["tasks.add"];
      case "tasks.update":
        return { task: await d.localStore.update(msg.id, msg.patch ?? {}) } satisfies UiResults["tasks.update"];
      case "tasks.delete":
        return { ok: await d.localStore.delete(msg.id) } satisfies UiResults["tasks.delete"];
      case "tasks.retry":
        return { task: await d.localStore.retry(msg.id) } satisfies UiResults["tasks.retry"];
      case "sessions.list":
        return { sessions: await d.sessions.list(msg.limit ?? 50) } satisfies UiResults["sessions.list"];
      case "sessions.events": {
        const session = await d.sessions.get(msg.sessionId);
        if (!session) throw new Error(`No session ${msg.sessionId}`);
        return { session, events: await d.sessions.eventsOf(msg.sessionId) } satisfies UiResults["sessions.events"];
      }
      case "terminal.start":
        {
          const s = await d.loadSettings();
          return d.terminal.start(msg.cols, msg.rows, s.jevEnabled && s.jevApiKey ? s.jevApiKey : undefined);
        }
      case "terminal.backlog":
        return { data: (await d.terminal.backlog?.(String(msg.terminalId ?? ""))) ?? "" } satisfies UiResults["terminal.backlog"];
      case "terminal.input":
        return { ok: await d.terminal.input(String(msg.data ?? ""), termId(msg.terminalId)) };
      case "terminal.resize":
        return { ok: await d.terminal.resize(msg.cols, msg.rows, termId(msg.terminalId)) };
      case "terminal.stop":
        return { ok: await d.terminal.stop(termId(msg.terminalId)) };
      case "helper.getLog":
        if (!d.helper.info || !d.helper.call) return { text: "" };
        return d.helper.call("helper.getLog", { lines: Math.max(1, Math.min(2000, Math.trunc(msg.lines) || 200)) }, { timeoutMs: 10_000 });
      case "vault.unlock":
        await this.vault().unlock(msg.passphrase);
        return { ok: true };
      case "vault.lock":
        await this.vault().lock();
        return { ok: true };
      case "vault.list":
        return this.vault().list();
      case "vault.set":
        await this.vault().set(msg.site, msg.username, msg.password);
        return { ok: true };
      case "vault.delete":
        await this.vault().delete(msg.site);
        return { ok: true };
      default:
        throw new Error(`Unknown request type: ${String((msg as { type?: unknown }).type)}`);
    }
  }

  private vault(): RouterVault {
    if (!this.deps.vault) throw new Error("Vault is not available");
    return this.deps.vault;
  }
}

export interface PortLike {
  name: string;
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
  onMessage?: { addListener(fn: (msg: unknown) => void): void };
}

/** Open UI ports and the pushes to them. State pushes are coalesced. */
export class UiHub {
  private readonly ports = new Set<PortLike>();
  private statePending = false;

  constructor(
    private readonly getState: () => Promise<UiState>,
    private readonly opts: { stateDelayMs?: number } = {},
  ) {}

  get size(): number {
    return this.ports.size;
  }

  /** chrome.runtime.onConnect handler. Ignores ports with other names. */
  attach(port: PortLike): boolean {
    if (port.name !== UI_PORT_NAME) return false;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    void this.getState()
      .then((state) => this.post(port, { type: "state", state }))
      .catch(() => {});
    return true;
  }

  push(msg: UiPush): void {
    for (const p of this.ports) this.post(p, msg);
  }

  event(event: StampedAgentEvent): void {
    this.push({ type: "event", event });
  }

  session(session: SessionInfo): void {
    this.push({ type: "session", session });
    this.pushState();
  }

  /** Pushes a fresh UiState soon (several calls in a row send one). */
  pushState(): void {
    if (this.statePending || this.ports.size === 0) return;
    this.statePending = true;
    setTimeout(() => {
      this.statePending = false;
      if (this.ports.size === 0) return;
      void this.getState()
        .then((state) => this.push({ type: "state", state }))
        .catch(() => {});
    }, this.opts.stateDelayMs ?? 50);
  }

  private post(port: PortLike, msg: UiPush): void {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }
}

/** A terminal id from a UI message, or undefined (the user's session). */
function termId(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
