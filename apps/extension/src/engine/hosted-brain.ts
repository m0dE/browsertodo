/**
 * The hosted "browsertodo AI" brain: the same agent loop as the Claude API
 * brain, sent to the account server instead of Anthropic. Messages go to
 * `${apiBase}/v1/ai/messages` and Jev to `${apiBase}/v1/ai/jev`, with the
 * session token as a bearer and X-Browsertodo-Session naming the run, so the
 * server can tie usage to it. A 402 (out of credit) pauses the run with
 * "Out of usage credit" and flags the account for the Top up link.
 */
import { OutOfCreditError, type JevLike } from "@browsertodo/core";
import { hostedModel, SESSION_HEADER } from "@browsertodo/shared";
import type { ApiBackend } from "./api-brain.js";
import { HOSTED_LABEL } from "./brain-resolver.js";
import type { CoreApi } from "./brains.js";

export interface HostedDeps {
  core: Pick<CoreApi, "createJev">;
  /** The signed-in session (null when signed out). */
  session(): { token: string; apiBase: string } | null;
  /** A request was refused for lack of credit. */
  onOutOfCredit(topupUrl?: string): void;
  /** A turn ended: the credit changed. */
  afterTurn?(): void;
  fetch?: typeof fetch;
}

export function hostedBackend(deps: HostedDeps): ApiBackend {
  const backend: ApiBackend = {
    kind: "browsertodo",
    label: HOSTED_LABEL,
    connect(settings, sessionId) {
      const s = deps.session();
      if (!s) throw new Error(`Not signed in: sign in to use ${HOSTED_LABEL}`);
      const base = s.apiBase.replace(/\/+$/, "");
      const headers = { [SESSION_HEADER]: sessionId };
      let jev: JevLike | null = null;
      if (settings.jevEnabled) {
        const inner = deps.core.createJev(s.token, { endpoint: `${base}/v1/ai/jev`, headers, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
        jev = {
          async decide(input) {
            try {
              return await inner.decide(input);
            } catch (err) {
              if (err instanceof OutOfCreditError) deps.onOutOfCredit(err.topupUrl);
              throw err;
            }
          },
        };
      }
      return {
        agent: {
          apiKey: s.token,
          model: hostedModel(settings.anthropicModel),
          baseUrl: `${base}/v1/ai`,
          auth: "bearer",
          headers,
          label: HOSTED_LABEL,
          onOutOfCredit: (info) => deps.onOutOfCredit(info.topupUrl),
        },
        jev,
      };
    },
  };
  if (deps.afterTurn) backend.afterTurn = deps.afterTurn;
  return backend;
}
