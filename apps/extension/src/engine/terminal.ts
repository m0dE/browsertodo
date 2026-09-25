/**
 * Relays the side panel's Terminal tab to the helper's terminals
 * (helper.terminal.*): the user's own interactive Claude Code session (one
 * at a time) and the Claude Code session of a running task, which the
 * helper opens by itself (helper.terminal.opened).
 */
import type { HelperInfo, HelperMethods, HelperNotifications, TerminalInfo } from "@browsertodo/shared";

export interface TerminalHelper {
  connect(timeoutMs?: number): Promise<HelperInfo>;
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onNotification<N extends keyof HelperNotifications & string>(method: N, fn: (params: HelperNotifications[N]) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
  /** HelperInfo after each (re)connect; its terminals list catches up with terminals already running. */
  onInfo?(fn: (info: HelperInfo | null) => void): () => void;
}

export interface TerminalPush {
  /** A terminal started (UiPush terminal.opened). */
  opened?(terminal: TerminalInfo): void;
  data(terminalId: string, data: string): void;
  exit(terminalId: string, exitCode: number | null): void;
  /** The set of running terminals changed (UiState.terminal / terminals). */
  changed(): void;
}

const CALL_TIMEOUT_MS = 15_000;
const USER_TITLE = "Claude Code";

export class TerminalRelay {
  private readonly terminals = new Map<string, TerminalInfo>();
  private userId: string | null = null;
  private starting: Promise<{ terminalId: string }> | null = null;

  constructor(
    private readonly helper: TerminalHelper,
    private readonly push: TerminalPush,
  ) {
    helper.onNotification("helper.terminal.opened", (p) => this.add(p));
    helper.onNotification("helper.terminal.data", (p) => {
      if (this.terminals.has(p.terminalId)) push.data(p.terminalId, p.data);
    });
    helper.onNotification("helper.terminal.exit", (p) => this.remove(p.terminalId, p.exitCode));
    helper.onDisconnect(() => {
      for (const id of [...this.terminals.keys()]) this.remove(id, null);
    });
    helper.onInfo?.((info) => {
      for (const t of info?.terminals ?? []) this.add(t);
    });
  }

  /** The user's own session. */
  get current(): { terminalId: string } | null {
    return this.userId ? { terminalId: this.userId } : null;
  }

  /** Every running terminal, task sessions first (oldest first), then the user's. */
  list(): TerminalInfo[] {
    const all = [...this.terminals.values()].map((t) => ({ ...t }));
    return [...all.filter((t) => t.kind === "task"), ...all.filter((t) => t.kind !== "task")];
  }

  /**
   * Starts the user's session, or attaches to the one already running and
   * returns its recent output so a reopened panel can repaint.
   */
  start(cols: number, rows: number, jevApiKey?: string): Promise<{ terminalId: string; backlog?: string }> {
    if (this.userId) {
      const terminalId = this.userId;
      return this.backlog(terminalId)
        .then((data) => ({ terminalId, backlog: data }))
        .catch(() => ({ terminalId }));
    }
    if (!this.starting) {
      this.starting = (async () => {
        const info = await this.helper.connect();
        if (!info.ptyAvailable) throw new Error("The helper cannot start a terminal (node-pty is not available)");
        const params = { cols: clampDim(cols, 80), rows: clampDim(rows, 24), ...(jevApiKey ? { jevApiKey } : {}) };
        const res = await this.helper.call("helper.terminal.start", params, { timeoutMs: CALL_TIMEOUT_MS });
        // helper.terminal.opened usually came first; do not depend on it.
        this.add({ terminalId: res.terminalId, kind: "user", title: USER_TITLE });
        return { terminalId: res.terminalId };
      })().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async backlog(terminalId: string): Promise<string> {
    if (!this.terminals.has(terminalId)) return "";
    return (await this.helper.call("helper.terminal.backlog", { terminalId }, { timeoutMs: CALL_TIMEOUT_MS })).data;
  }

  /** Keystrokes for a terminal (default: the user's session). False when it is not running. */
  async input(data: string, terminalId?: string): Promise<boolean> {
    const id = this.target(terminalId);
    if (!id) return false;
    await this.helper.call("helper.terminal.input", { terminalId: id, data }, { timeoutMs: CALL_TIMEOUT_MS });
    return true;
  }

  async resize(cols: number, rows: number, terminalId?: string): Promise<boolean> {
    const id = this.target(terminalId);
    if (!id) return false;
    await this.helper.call("helper.terminal.resize", { terminalId: id, cols: clampDim(cols, 80), rows: clampDim(rows, 24) }, { timeoutMs: CALL_TIMEOUT_MS });
    return true;
  }

  async stop(terminalId?: string): Promise<boolean> {
    const id = this.target(terminalId);
    if (!id) return false;
    await this.helper.call("helper.terminal.stop", { terminalId: id }, { timeoutMs: CALL_TIMEOUT_MS });
    // Normally helper.terminal.exit arrives first; do not depend on it.
    this.remove(id, null);
    return true;
  }

  private target(terminalId?: string): string | null {
    const id = terminalId ?? this.userId;
    return id && this.terminals.has(id) ? id : null;
  }

  private add(t: TerminalInfo): void {
    if (this.terminals.has(t.terminalId)) return;
    const info: TerminalInfo = { terminalId: t.terminalId, kind: t.kind === "task" ? "task" : "user", title: t.title || USER_TITLE };
    if (t.sessionId) info.sessionId = t.sessionId;
    if (info.kind === "user") {
      // One user session at a time: a new one replaces any we still list.
      if (this.userId && this.userId !== info.terminalId) this.remove(this.userId, null);
      this.userId = info.terminalId;
    }
    this.terminals.set(info.terminalId, info);
    this.push.opened?.({ ...info });
    this.push.changed();
  }

  private remove(terminalId: string, exitCode: number | null): void {
    if (!this.terminals.delete(terminalId)) return;
    if (this.userId === terminalId) this.userId = null;
    this.push.exit(terminalId, exitCode);
    this.push.changed();
  }
}

function clampDim(n: number, fallback: number): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : fallback;
}
