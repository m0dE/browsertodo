/**
 * Relays the side panel's Terminal tab to the helper's interactive Claude
 * Code terminal (helper.terminal.*). One terminal at a time.
 */
import type { HelperInfo, HelperMethods, HelperNotifications } from "@browsertodo/shared";

export interface TerminalHelper {
  connect(timeoutMs?: number): Promise<HelperInfo>;
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onNotification<N extends keyof HelperNotifications & string>(method: N, fn: (params: HelperNotifications[N]) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
}

export interface TerminalPush {
  data(terminalId: string, data: string): void;
  exit(terminalId: string, exitCode: number | null): void;
  /** The running terminal changed (UiState.terminal). */
  changed(): void;
}

const CALL_TIMEOUT_MS = 15_000;

export class TerminalRelay {
  private terminalId: string | null = null;
  private starting: Promise<{ terminalId: string }> | null = null;

  constructor(
    private readonly helper: TerminalHelper,
    private readonly push: TerminalPush,
  ) {
    helper.onNotification("helper.terminal.data", (p) => {
      if (p.terminalId === this.terminalId) push.data(p.terminalId, p.data);
    });
    helper.onNotification("helper.terminal.exit", (p) => {
      if (p.terminalId !== this.terminalId) return;
      this.terminalId = null;
      push.exit(p.terminalId, p.exitCode);
      push.changed();
    });
    helper.onDisconnect(() => {
      const id = this.terminalId;
      if (!id) return;
      this.terminalId = null;
      push.exit(id, null);
      push.changed();
    });
  }

  get current(): { terminalId: string } | null {
    return this.terminalId ? { terminalId: this.terminalId } : null;
  }

  /**
   * Starts the terminal, or attaches to the one already running and returns
   * its recent output so a reopened panel can repaint.
   */
  start(cols: number, rows: number, jevApiKey?: string): Promise<{ terminalId: string; backlog?: string }> {
    if (this.terminalId) {
      const terminalId = this.terminalId;
      return this.helper
        .call("helper.terminal.backlog", { terminalId }, { timeoutMs: CALL_TIMEOUT_MS })
        .then((r) => ({ terminalId, backlog: r.data }))
        .catch(() => ({ terminalId }));
    }
    if (!this.starting) {
      this.starting = (async () => {
        const info = await this.helper.connect();
        if (!info.ptyAvailable) throw new Error("The helper cannot start a terminal (node-pty is not available)");
        const params = { cols: clampDim(cols, 80), rows: clampDim(rows, 24), ...(jevApiKey ? { jevApiKey } : {}) };
        const res = await this.helper.call("helper.terminal.start", params, { timeoutMs: CALL_TIMEOUT_MS });
        this.terminalId = res.terminalId;
        this.push.changed();
        return { terminalId: res.terminalId };
      })().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async input(data: string): Promise<boolean> {
    if (!this.terminalId) return false;
    await this.helper.call("helper.terminal.input", { terminalId: this.terminalId, data }, { timeoutMs: CALL_TIMEOUT_MS });
    return true;
  }

  async resize(cols: number, rows: number): Promise<boolean> {
    if (!this.terminalId) return false;
    await this.helper.call(
      "helper.terminal.resize",
      { terminalId: this.terminalId, cols: clampDim(cols, 80), rows: clampDim(rows, 24) },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    return true;
  }

  async stop(): Promise<boolean> {
    const id = this.terminalId;
    if (!id) return false;
    await this.helper.call("helper.terminal.stop", { terminalId: id }, { timeoutMs: CALL_TIMEOUT_MS });
    // Normally helper.terminal.exit arrives first; do not depend on it.
    if (this.terminalId === id) {
      this.terminalId = null;
      this.push.exit(id, null);
      this.push.changed();
    }
    return true;
  }
}

function clampDim(n: number, fallback: number): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1000) : fallback;
}
