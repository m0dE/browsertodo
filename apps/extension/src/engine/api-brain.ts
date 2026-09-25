/**
 * The Claude API agent loop in the service worker, behind the Brain
 * interface. The same loop serves two brains, told apart by their backend:
 * the user's Anthropic API key (claude-api) and the hosted browsertodo AI
 * (browsertodo, see hosted-brain.ts).
 */
import type { AgentSession, ApiAgentOptions, BrowserCaller, JevLike } from "@browsertodo/core";
import type { AgentEvent, ExtensionSettings } from "@browsertodo/shared";
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

/** Where an API brain's requests go and how they authenticate. */
export interface ApiBackend {
  readonly kind: "claude-api" | "browsertodo";
  /** The agent options for a new session. Throws when the backend cannot be used. */
  connect(
    settings: ExtensionSettings,
    sessionId: string,
  ): { agent: Pick<ApiAgentOptions, "apiKey" | "model" | "baseUrl" | "auth" | "headers" | "label" | "onOutOfCredit">; jev: JevLike | null };
  /** A turn ended (e.g. refresh the account's credit). */
  afterTurn?(): void;
}

/** The user's own Anthropic API key, with Jev when it is on and a Jev key is set. */
export function claudeApiBackend(core: Pick<CoreApi, "createJev">, fetchFn?: typeof fetch): ApiBackend {
  return {
    kind: "claude-api",
    connect(s) {
      const jev = s.jevEnabled && s.jevApiKey ? core.createJev(s.jevApiKey, fetchFn ? { fetch: fetchFn } : undefined) : null;
      return { agent: { apiKey: s.anthropicApiKey, model: s.anthropicModel }, jev };
    },
  };
}

/** Like the helper's kept-open Claude Code sessions: a few, for 30 idle minutes. */
const API_KEEP_CONVERSATIONS = 3;
const API_IDLE_MS = 30 * 60_000;

/** The agent loop inside the extension (core.startApiAgent), on the backend's endpoint. */
export class ApiBrain implements Brain {
  readonly kind: "claude-api" | "browsertodo";
  private readonly backend: ApiBackend;
  /** Conversation history lives here only: lost when the service worker restarts. */
  private readonly conversations = new Map<string, ApiConversation>();

  constructor(
    private readonly deps: {
      core: Pick<CoreApi, "startApiAgent" | "createJev">;
      browser: BrowserCaller;
      fetch?: typeof fetch;
      now?: () => number;
      onSessionsChanged?: () => void;
      /** Default: the Anthropic API key in the settings. */
      backend?: ApiBackend;
    },
  ) {
    this.backend = deps.backend ?? claudeApiBackend(deps.core, deps.fetch);
    this.kind = this.backend.kind;
  }

  start(opts: BrainStartOptions): BrainRun {
    try {
      const { agent, jev } = this.backend.connect(opts.settings, opts.sessionId);
      const conv = { sink: opts.onEvent, browser: opts.browser ?? this.deps.browser, lastUsed: this.now() } as ApiConversation;
      conv.agent = this.deps.core.startApiAgent({
        ...agent,
        sessionId: opts.sessionId,
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
      return failedRun(`Could not start the ${this.kind === "browsertodo" ? "browsertodo AI" : "Claude API"} agent: ${errText(err)}`);
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
        try {
          this.backend.afterTurn?.();
        } catch {
          /* best effort */
        }
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
