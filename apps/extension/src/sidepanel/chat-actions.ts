/**
 * The Chat tab's action bar (New Chat | Show Tab | Raw Log): whether each
 * action applies to the chat on screen, and a tooltip that says what it does
 * or why it cannot be used. Pure.
 */
import type { SessionInfo } from "@browsertodo/shared";
import { brainLabel } from "./format.js";

export interface BarAction {
  disabled: boolean;
  title: string;
}

export interface ChatActions {
  newChat: BarAction;
  showTab: BarAction;
  rawLog: BarAction;
}

type Shown = Pick<SessionInfo, "sessionId" | "brain" | "logPath" | "endedAt">;

/** shown: the conversation the Chat tab shows (null: an empty, new chat). running: ids of running sessions. */
export function chatActions(shown: Shown | null, running: ReadonlySet<string>): ChatActions {
  if (!shown) {
    return {
      newChat: { disabled: true, title: "This is already a new chat: type below to start" },
      showTab: { disabled: true, title: "No chat yet, so there is no agent tab to show" },
      rawLog: { disabled: true, title: "No chat yet, so there is no log" },
    };
  }
  const isRunning = running.has(shown.sessionId) && !shown.endedAt;
  return {
    newChat: {
      disabled: false,
      title: isRunning
        ? "Leave this chat (the agent keeps working on it); your next message starts a new one"
        : "Leave this chat; your next message starts a new one",
    },
    // The agent has a tab of its own only while a turn runs (agent-slots releases it when the turn ends).
    showTab: isRunning
      ? { disabled: false, title: "Switch to the tab the agent is using" }
      : { disabled: true, title: "The agent has no tab for this chat right now: it only has one while it is working" },
    rawLog:
      shown.brain !== "claude-code"
        ? { disabled: true, title: `No raw log: only local Claude Code runs keep one (this chat used ${brainLabel(shown.brain)})` }
        : !shown.logPath
          ? { disabled: true, title: "No raw log was recorded for this chat" }
          : { disabled: false, title: "Every Claude Code event of this chat, as the helper logged it" },
  };
}

/** A past conversation can be picked up in Chat (the composer then talks to it); cloud runs cannot. */
export function canOpenInChat(s: Pick<SessionInfo, "source">): boolean {
  return s.source !== "cloud";
}
