/**
 * The Claude models browsertodo offers: the side panel's model menu, the
 * options page's select and the hosted AI's allowlist (apps/api/src/pricing.ts
 * prices exactly these). Other ids still work with a local brain.
 */
export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]["id"];

/** The model setting's default, and what the hosted AI runs for an id it does not offer. */
export const DEFAULT_MODEL: ClaudeModelId = "claude-sonnet-5";

/** Other names accepted for a model (Anthropic's undated alias), resolved to its id. */
export const MODEL_ALIASES: Readonly<Record<string, ClaudeModelId>> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function isClaudeModel(id: string): id is ClaudeModelId {
  return CLAUDE_MODELS.some((m) => m.id === id);
}

/** The catalog id for a model id or alias, or null when browsertodo does not offer it. */
export function resolveModel(id: unknown): ClaudeModelId | null {
  if (typeof id !== "string") return null;
  const resolved = Object.hasOwn(MODEL_ALIASES, id) ? MODEL_ALIASES[id]! : id;
  return isClaudeModel(resolved) ? resolved : null;
}

/** The model the hosted AI runs for this setting: ids it does not offer fall back to the default. */
export function hostedModel(id: string): ClaudeModelId {
  return resolveModel(id) ?? DEFAULT_MODEL;
}

/** Anthropic's API: its origin, and the `anthropic-version` every Messages call sends. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_BASE}/messages`;
export const ANTHROPIC_API_VERSION = "2023-06-01";
