/** Headless Claude Code in the helper, behind the Brain interface. */
import type { AgentEvent, HelperInfo, HelperMethods, HelperNotifications, TaskRunResult } from "@browsertodo/shared";
import { errText } from "../errors.js";
import { endedRun, SessionEndedError, type Brain, type BrainContinueOptions, type BrainRun, type BrainStartOptions } from "./brains.js";

export interface HelperLike {
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onNotification<N extends keyof HelperNotifications & string>(method: N, fn: (params: HelperNotifications[N]) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
  /** Hello info (with the open sessions) after every connect, null on disconnect. */
  onInfo?(fn: (info: HelperInfo | null) => void): () => void;
}

const CONTROL_TIMEOUT_MS = 15_000;

/** Headless Claude Code in the helper (helper.runTask / helper.continueSession + helper.event). */
export class ClaudeCodeBrain implements Brain {
  readonly kind = "claude-code" as const;
  /** Task sessions alive in the helper, as it last reported them. */
  private open = new Set<string>();

  constructor(
    private readonly helper: HelperLike,
    private readonly opts: { onSessionsChanged?: () => void } = {},
  ) {
    helper.onNotification("helper.sessions", (p) => this.setOpen(p.open));
    helper.onInfo?.((info) => this.setOpen(info?.openSessions ?? []));
    helper.onDisconnect(() => this.setOpen([]));
  }

  start(opts: BrainStartOptions): BrainRun {
    const { sessionId } = opts;
    return this.run(sessionId, opts.onEvent, () =>
      this.helper.call("helper.runTask", { sessionId, task: opts.task, mediaPaths: opts.mediaPaths, config: opts.config }),
    );
  }

  continue(opts: BrainContinueOptions): BrainRun {
    const { sessionId } = opts;
    if (!this.open.has(sessionId)) return endedRun();
    return this.run(sessionId, opts.onEvent, () =>
      this.helper.call("helper.continueSession", { sessionId, text: opts.text, config: opts.config }).catch((err: unknown) => {
        if (/session ended/i.test(errText(err))) throw new SessionEndedError();
        throw err;
      }),
    );
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  openSessions(): string[] {
    return [...this.open];
  }

  async end(sessionId: string): Promise<void> {
    try {
      await this.helper.call("helper.endSession", { sessionId }, { timeoutMs: CONTROL_TIMEOUT_MS });
    } catch {
      /* already gone, or the helper is not connected */
    }
    if (this.open.delete(sessionId)) this.changed();
  }

  private run(sessionId: string, onEvent: (e: AgentEvent) => void, call: () => Promise<TaskRunResult>): BrainRun {
    const cleanups: (() => void)[] = [];
    cleanups.push(
      this.helper.onNotification("helper.event", (p) => {
        if (p.sessionId === sessionId) onEvent(p.event);
      }),
    );
    const disconnected = new Promise<TaskRunResult>((resolve) => {
      cleanups.push(this.helper.onDisconnect((reason) => resolve({ outcome: "retry", reason: `helper disconnected: ${reason}` })));
    });
    const run = call().catch((err: unknown): TaskRunResult => {
      if (err instanceof SessionEndedError) throw err;
      return { outcome: "retry", reason: `helper error: ${errText(err)}` };
    });
    const done = Promise.race([run, disconnected]).finally(() => {
      for (const fn of cleanups) fn();
    });
    return {
      done,
      sendUserMessage: async (text) => {
        try {
          return (await this.helper.call("helper.sendUserMessage", { sessionId, text }, { timeoutMs: CONTROL_TIMEOUT_MS })).ok;
        } catch {
          return false;
        }
      },
      abort: (reason, outcome) => {
        const call =
          outcome === "paused"
            ? this.helper.call("helper.forcePause", { sessionId, reason }, { timeoutMs: CONTROL_TIMEOUT_MS })
            : this.helper.call("helper.abortTask", { sessionId, reason }, { timeoutMs: CONTROL_TIMEOUT_MS });
        call.catch(() => {});
      },
    };
  }

  private setOpen(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.open.size && [...next].every((id) => this.open.has(id))) return;
    this.open = next;
    this.changed();
  }

  private changed(): void {
    try {
      this.opts.onSessionsChanged?.();
    } catch {
      /* UI push errors are not the brain's problem */
    }
  }
}
