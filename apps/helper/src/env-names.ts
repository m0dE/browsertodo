/** Names of the environment variables the helper reads (from .env files or the environment) or sets for the processes it starts. */
export const ENV = {
  /** Base folder for logs, runs and helper.json. Default: see HelperConfig.baseDir. */
  home: "BROWSERTODO_HOME",
  /** "scripted": the deterministic scripted brain instead of Claude Code (tests, e2e). */
  brain: "BROWSERTODO_BRAIN",
  /** Claude Code model when the extension names none. */
  model: "BROWSERTODO_MODEL",
  /** Path of claude.exe, instead of looking it up. */
  claudePath: "BROWSERTODO_CLAUDE_PATH",
  /** Jev key used when the extension sends none. */
  typesafeApiKey: "TYPESAFE_API_KEY",
  /** For the MCP server a task session's Claude Code starts: the helper's pipe. */
  pipe: "BROWSERTODO_PIPE",
  /** For the MCP server: its task session id (empty: the attached session's tools). */
  task: "BROWSERTODO_TASK",
  /** For the MCP server: comma list of the tools to register (default: all). */
  tools: "BROWSERTODO_TOOLS",
  /** For the MCP server: "1" when Jev picks act's elements (tools are described for that mode). */
  jev: "BROWSERTODO_JEV",
} as const;
