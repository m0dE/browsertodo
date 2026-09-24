/**
 * The two brain adapters behind one interface. The runner does not care
 * whether the agent loop runs in the helper (Claude Code) or here (Claude API).
 */
import type * as core from "@browsertodo/core";
import type { BrowserCaller } from "@browsertodo/core";
import type {
  AgentEvent,
  AgentTask,
  BrainKind,
  ExtensionSettings,
  HelperMethods,
  HelperNotifications,
  RunConfig,
  TaskRunResult,
} from "@browsertodo/shared";

/** The core functions the engine uses; injected so tests can fake them. */
export type CoreApi = Pick<typeof core, "startApiAgent" | "createJev" | "verifyXPost" | "classifyFailure">;

export interface BrainStartOptions {
  sessionId: string;
  task: AgentTask;
  mediaPaths: string[];
  config: RunConfig;
  settings: ExtensionSettings;
  onEvent(e: AgentEvent): void;
}

export type AbortOutcome = "paused" | "failed" | "retry";

export interface BrainRun {
  /** Types a message into the running session. Resolves false when it could not be delivered. */
  sendUserMessage(text: string): Promise<boolean>;
  /** Stops the agent. The runner decides the final outcome; this only asks the brain to stop. */
  abort(reason: string, outcome: AbortOutcome): void;
  readonly done: Promise<TaskRunResult>;
}

export interface Brain {
  readonly kind: BrainKind;
  start(opts: BrainStartOptions): BrainRun;
}

export interface HelperLike {
  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts?: { timeoutMs?: number },
  ): Promise<HelperMethods[M]["result"]>;
  onNotification<N extends keyof HelperNotifications & string>(method: N, fn: (params: HelperNotifications[N]) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
}

const CONTROL_TIMEOUT_MS = 15_000;

/** Headless Claude Code in the helper (helper.runTask + helper.event). */
export class ClaudeCodeBrain implements Brain {
  readonly kind = "claude-code" as const;

  constructor(private readonly helper: HelperLike) {}

  start(opts: BrainStartOptions): BrainRun {
    const { sessionId } = opts;
    const cleanups: (() => void)[] = [];
    cleanups.push(
      this.helper.onNotification("helper.event", (p) => {
        if (p.sessionId === sessionId) opts.onEvent(p.event);
      }),
    );
    const disconnected = new Promise<TaskRunResult>((resolve) => {
      cleanups.push(this.helper.onDisconnect((reason) => resolve({ outcome: "retry", reason: `helper disconnected: ${reason}` })));
    });
    const run = this.helper
      .call("helper.runTask", { sessionId, task: opts.task, mediaPaths: opts.mediaPaths, config: opts.config })
      .catch((err: unknown): TaskRunResult => ({ outcome: "retry", reason: `helper error: ${errText(err)}` }));
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
}

/** The agent loop inside the extension (core.startApiAgent), Jev-first when a Jev key is set. */
export class ApiBrain implements Brain {
  readonly kind = "claude-api" as const;

  constructor(
    private readonly deps: { core: Pick<CoreApi, "startApiAgent" | "createJev">; browser: BrowserCaller; fetch?: typeof fetch },
  ) {}

  start(opts: BrainStartOptions): BrainRun {
    const s = opts.settings;
    try {
      const jev = s.jevEnabled && s.jevApiKey ? this.deps.core.createJev(s.jevApiKey, this.deps.fetch ? { fetch: this.deps.fetch } : undefined) : null;
      const session = this.deps.core.startApiAgent({
        sessionId: opts.sessionId,
        apiKey: s.anthropicApiKey,
        model: s.anthropicModel,
        task: opts.task,
        mediaPaths: opts.mediaPaths,
        config: opts.config,
        browser: this.deps.browser,
        jev,
        onEvent: opts.onEvent,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      return {
        done: session.done,
        sendUserMessage: async (text) => {
          session.sendUserMessage(text);
          return true;
        },
        abort: (reason, outcome) => session.abort(reason, outcome),
      };
    } catch (err) {
      return {
        done: Promise.resolve({ outcome: "failed", reason: `Could not start the Claude API agent: ${errText(err)}` }),
        sendUserMessage: async () => false,
        abort: () => {},
      };
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
