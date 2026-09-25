/** The Claude API agent loop in the service worker, behind the Brain interface. */
import type { AgentSession, BrowserCaller } from "@browsertodo/core";
import type { AgentEvent } from "@browsertodo/shared";
import { errText } from "../errors.js";
import { endedRun, failedRun, type Brain, type BrainContinueOptions, type BrainRun, type BrainStartOptions, type CoreApi } from "./brains.js";

/** A conversation's Claude API agent, kept in memory between turns. */
interface ApiConversation {
  agent: AgentSession;
  /** Where the agent's events go: the runner's handler for the current turn. */
  sink: (e: AgentEvent) => void;
  /** The current turn's tab. */
  browser: BrowserCaller;
  lastUsed: number;
}

/** Like the helper's kept-open Claude Code sessions: a few, for 30 idle minutes. */
const API_KEEP_CONVERSATIONS = 3;
const API_IDLE_MS = 30 * 60_000;

/** The agent loop inside the extension (core.startApiAgent), with Jev when it is on and a Jev key is set. */
export class ApiBrain implements Brain {
  readonly kind = "claude-api" as const;
  /** Conversation history lives here only: lost when the service worker restarts. */
  private readonly conversations = new Map<string, ApiConversation>();

  constructor(
    private readonly deps: {
      core: Pick<CoreApi, "startApiAgent" | "createJev">;
      browser: BrowserCaller;
      fetch?: typeof fetch;
      now?: () => number;
      onSessionsChanged?: () => void;
    },
  ) {}

  start(opts: BrainStartOptions): BrainRun {
    const s = opts.settings;
    try {
      const jev = s.jevEnabled && s.jevApiKey ? this.deps.core.createJev(s.jevApiKey, this.deps.fetch ? { fetch: this.deps.fetch } : undefined) : null;
      const conv = { sink: opts.onEvent, browser: opts.browser ?? this.deps.browser, lastUsed: this.now() } as ApiConversation;
      conv.agent = this.deps.core.startApiAgent({
        sessionId: opts.sessionId,
        apiKey: s.anthropicApiKey,
        model: s.anthropicModel,
        task: opts.task,
        mediaPaths: opts.mediaPaths,
        config: opts.config,
        // Every turn acts in its own run's tab.
        browser: { call: (method, params) => conv.browser.call(method, params) },
        jev,
        onEvent: (e) => conv.sink(e),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      if (conv.agent.continueWith) this.keep(opts.sessionId, conv);
      this.touchWhenDone(conv);
      return this.runOf(conv.agent);
    } catch (err) {
      return failedRun(`Could not start the Claude API agent: ${errText(err)}`);
    }
  }

  continue(opts: BrainContinueOptions): BrainRun {
    const conv = this.live(opts.sessionId);
    if (!conv?.agent.continueWith) return endedRun();
    let agent: AgentSession;
    try {
      conv.sink = opts.onEvent;
      conv.browser = opts.browser ?? this.deps.browser;
      agent = conv.agent.continueWith(opts.text, { config: opts.config });
    } catch (err) {
      return failedRun(errText(err));
    }
    conv.agent = agent;
    conv.lastUsed = this.now();
    this.touchWhenDone(conv);
    return this.runOf(agent);
  }

  isOpen(sessionId: string): boolean {
    return this.live(sessionId) !== null;
  }

  openSessions(): string[] {
    return [...this.conversations.keys()].filter((id) => this.live(id));
  }

  async end(sessionId: string): Promise<void> {
    if (this.conversations.delete(sessionId)) this.changed();
  }

  /** Idle time counts from the end of the last turn. */
  private touchWhenDone(conv: ApiConversation): void {
    const agent = conv.agent;
    void agent.done.then(
      () => {
        if (conv.agent === agent) conv.lastUsed = this.now();
      },
      () => {},
    );
  }

  private runOf(agent: AgentSession): BrainRun {
    return {
      done: agent.done,
      sendUserMessage: async (text) => {
        agent.sendUserMessage(text);
        return true;
      },
      abort: (reason, outcome) => agent.abort(reason, outcome),
    };
  }

  private keep(sessionId: string, conv: ApiConversation): void {
    this.conversations.delete(sessionId);
    this.conversations.set(sessionId, conv);
    // Oldest first (Map order): drop the oldest beyond the limit.
    while (this.conversations.size > API_KEEP_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    this.changed();
  }

  /** The conversation, unless it idled out (then it is dropped). */
  private live(sessionId: string): ApiConversation | null {
    const conv = this.conversations.get(sessionId);
    if (!conv) return null;
    if (this.now() - conv.lastUsed > API_IDLE_MS) {
      this.conversations.delete(sessionId);
      return null;
    }
    return conv;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private changed(): void {
    try {
      this.deps.onSessionsChanged?.();
    } catch {
      /* UI push errors are not the brain's problem */
    }
  }
}
