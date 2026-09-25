/**
 * The input bar pinned to the bottom of the Tasks and Activity tabs. It talks
 * to the conversation the Activity tab shows (the live one, or the last one):
 * while its turn runs, a message goes into that turn (and Stop pauses it);
 * once the turn ended, a message is the conversation's next turn. "New chat"
 * ends the conversation and the box goes back to "Do this now", which starts
 * a new one.
 */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash } from "./dom.js";
import { filePicker, filesToUploads } from "./files.js";
import { initModelPicker } from "./model-menu.js";

export type ComposerMode = "new" | "conversation" | "running";

export interface ComposerView {
  /** The sessions running right now (UiState.runningSessions). */
  setRunning(running: readonly SessionInfo[]): void;
  /** Keeps the model chip in step with the settings and brain status. */
  setState(state: UiState): void;
  /** The conversation the Activity tab shows (null: none). */
  setConversation(session: SessionInfo | null): void;
  /** The conversation the box talks to, or null ("Do this now"). */
  target(): SessionInfo | null;
  mode(): ComposerMode;
  /** Talk to this conversation (again, after New chat) and focus the box. */
  focusConversation(sessionId: string): void;
}

const NEW_PLACEHOLDER = "Do this now, e.g. “Post ‘good morning’ on X”";
const CHAT_PLACEHOLDER = "Message browsertodo…";
const MAX_ROWS = 8;

export function initComposer(opts: {
  /** A message or a new task went out: show its conversation. */
  onStarted: (sessionId: string) => void;
  onState: (state: UiState) => void;
  /** The target changed (a conversation, New chat, a run started or ended). */
  onTargetChange?: () => void;
}): ComposerView {
  const form = $<HTMLFormElement>("now-form");
  const text = $<HTMLTextAreaElement>("now-text");
  const attach = $("now-attach");
  const submit = $<HTMLButtonElement>("now-submit");
  const stop = $<HTMLButtonElement>("now-stop");
  const newChat = $<HTMLButtonElement>("now-new");
  const msg = $("now-msg");
  const fileInput = $<HTMLInputElement>("now-files");
  const filesList = $("now-files-list");
  const files = filePicker(fileInput, filesList);
  const model = initModelPicker({ onState: opts.onState, onError: (t) => flash(msg, t, "bad") });
  // The attach control is a label around a hidden input; make it keyboard-operable.
  attach.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  let running = new Set<string>();
  let shown: SessionInfo | null = null;
  /** The conversation the user closed with New chat; the box stays in "Do this now" for it. */
  let dismissed: string | null = null;

  const target = (): SessionInfo | null => (shown && shown.sessionId !== dismissed ? shown : null);
  const mode = (): ComposerMode => {
    const t = target();
    if (!t) return "new";
    return running.has(t.sessionId) ? "running" : "conversation";
  };

  /** Grow with the text up to MAX_ROWS lines, then scroll inside. */
  const fit = () => {
    const cs = getComputedStyle(text);
    const line = parseFloat(cs.lineHeight) || 20;
    const max = line * MAX_ROWS + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    text.style.height = "auto";
    const full = text.scrollHeight;
    text.style.height = `${Math.min(full, max)}px`;
    text.style.overflowY = full > max ? "auto" : "hidden";
    form.classList.toggle("blank", !text.value.trim());
  };
  text.addEventListener("input", fit);
  // Clicking the box around the textarea (not a control) focuses it, like chat apps.
  form.addEventListener("mousedown", (e) => {
    if (e.target === form || (e.target as HTMLElement).classList.contains("now-bar")) {
      e.preventDefault();
      text.focus();
    }
  });
  // Enter sends, Shift+Enter adds a line (like chat apps).
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const clearInput = () => {
    text.value = "";
    fit();
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    const m = mode();
    const t = target();
    void busy(submit, async () => {
      if (m !== "new" && t) {
        clearInput();
        if (m === "conversation") flash(msg, "Sending…");
        try {
          await uiRequest({ type: "run.message", sessionId: t.sessionId, text: value });
          flash(msg, "");
          if (m === "conversation") opts.onStarted(t.sessionId);
        } catch (err) {
          text.value = value;
          fit();
          flash(msg, errorText(err), "bad");
        }
        return;
      }
      flash(msg, "Starting…");
      try {
        const media = await filesToUploads(files.files());
        // No account field here: the agent picks up accounts named in the text ("post this from @beta").
        const { sessionId } = await uiRequest({ type: "run.adhoc", instructions: value, ...(media.length ? { media } : {}) });
        clearInput();
        files.clear();
        flash(msg, "");
        opts.onStarted(sessionId);
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    });
  });

  newChat.addEventListener("click", () => {
    const t = target();
    if (!t) return;
    dismissed = t.sessionId;
    render();
    text.focus();
    // Closes the conversation's kept-open agent session (a running turn keeps running).
    void uiRequest({ type: "run.newChat", sessionId: t.sessionId }).catch((err) => flash(msg, errorText(err), "bad"));
  });

  stop.addEventListener("click", () =>
    void busy(stop, async () => {
      try {
        // Stops this conversation's turn; other tasks keep running.
        const t = target();
        await uiRequest({ type: "run.stop", ...(t ? { sessionId: t.sessionId } : {}) });
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    }),
  );

  /** The first render is the initial state, not a change (callers may not be wired yet). */
  let lastKey = "new:";
  function render(): void {
    const m = mode();
    text.placeholder = m === "new" ? NEW_PLACEHOLDER : CHAT_PLACEHOLDER;
    text.setAttribute("aria-label", m === "new" ? "Task to do now" : m === "running" ? "Message to the agent" : "Next message in this conversation");
    submit.textContent = m === "new" ? "Run" : "Send";
    stop.hidden = m !== "running";
    // Files go with a new task; a conversation keeps the files it started with.
    attach.hidden = m !== "new";
    filesList.hidden = m !== "new";
    newChat.hidden = m !== "conversation";
    form.classList.toggle("running", m === "running");
    model.setRunning(m === "running");
    const key = `${m}:${target()?.sessionId ?? ""}`;
    if (key !== lastKey) {
      lastKey = key;
      opts.onTargetChange?.();
    }
  }

  const view: ComposerView = {
    setRunning(next) {
      running = new Set(next.map((s) => s.sessionId));
      render();
    },
    setConversation(session) {
      shown = session;
      render();
    },
    target,
    mode,
    focusConversation(sessionId) {
      if (dismissed === sessionId) dismissed = null;
      render();
      text.focus();
    },
    setState(state) {
      model.setState(state);
    },
  };

  render();
  fit();
  return view;
}
