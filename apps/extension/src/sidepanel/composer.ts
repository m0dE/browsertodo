/**
 * The input bar pinned to the bottom of the Chat and TODO tabs. It talks to
 * the conversation the Chat tab shows (the current browser tab's): while its
 * turn runs, a message goes into that turn (and Stop pauses it); once the
 * turn ended, a message is the conversation's next turn. With no conversation
 * shown (a new chat) the box is "Do this now", which starts a new one in the
 * current tab. Every request names that tab.
 *
 * In Chat, sending an empty box means "look at this page and do what is
 * needed" (SCREEN_HELP_TEXT, see emptySend); under TODO an empty box does
 * nothing.
 */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest, type UiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, flash, showError } from "../ui/dom.js";
import { filePicker, filesToUploads } from "./files.js";
import { initModelPicker } from "./model-menu.js";
import type { TabName } from "./tabs.js";

export type ComposerMode = "new" | "conversation" | "running";

/** The Chat placeholder: an empty send looks at the page. */
export const SCREEN_PLACEHOLDER = "Figure out what to do based on the current screen";
/** The Send button's tooltip where an empty send looks at the page. */
export const SCREEN_SEND_TITLE = "Describe a task, or press Enter to let browsertodo look at this page";

type EmptySendRequest = Extract<UiRequest, { type: "run.message" }> | Extract<UiRequest, { type: "run.adhoc" }>;

/**
 * What Send does with an empty box (and no text): in Chat, look at the
 * page — a new conversation, or the shown one's next turn — else nothing,
 * with a hint. A running turn is looking already; files need a few words.
 */
export function emptySend(opts: {
  panelTab: TabName;
  mode: ComposerMode;
  sessionId: string | null;
  hasFiles: boolean;
  tabId: number | null;
}): { request: EmptySendRequest } | { hint: string } {
  if (opts.panelTab !== "chat") return { hint: "Type a task to run it now" };
  if (opts.hasFiles) return { hint: "Say what to do with the files" };
  if (opts.mode === "running") return { hint: "The agent is working: type a message, or press Stop" };
  const tab = opts.tabId === null ? {} : { tabId: opts.tabId };
  if (opts.mode === "conversation" && opts.sessionId) {
    return { request: { type: "run.message", sessionId: opts.sessionId, text: "", screen: true, ...tab } };
  }
  return { request: { type: "run.adhoc", instructions: "", screen: true, ...tab } };
}

export interface ComposerView {
  /** The sessions running right now (UiState.runningSessions). */
  setRunning(running: readonly SessionInfo[]): void;
  /** Keeps the model chip in step with the settings and brain status. */
  setState(state: UiState): void;
  /** The conversation the Chat tab shows (null: a new chat). */
  setConversation(session: SessionInfo | null): void;
  /** The conversation the box talks to, or null ("Do this now"). */
  target(): SessionInfo | null;
  mode(): ComposerMode;
  /** Put the cursor in the box. */
  focus(): void;
  /**
   * The slot in the input's button row right left of Send, for a control
   * that belongs with sending (e.g. a voice toggle). Empty (and taking no
   * space) until something is mounted in it.
   */
  readonly actionSlot: HTMLElement;
  /** The text in the box. */
  draft(): string;
  /** Replaces the text in the box (voice input writes its live text here). */
  setDraft(value: string): void;
  /** Sends what is in the box, exactly as Enter does (an empty box in Chat looks at the page). */
  send(): void;
  /**
   * Sees the box's key presses before the composer does (voice input takes
   * Enter and Esc while it listens). Return true when handled.
   */
  interceptKeys(handler: (e: KeyboardEvent) => boolean): void;
  /** The side panel tab shown (the composer sits under Chat and TODO; only Chat sends empty messages). */
  setPanelTab(tab: TabName): void;
  /** Continue a stopped conversation now: sends the typed note if there is one, otherwise just continues. */
  continueNow(sessionId: string): Promise<void>;
  /** New chat left this conversation: the tab has no chat any more, its kept-open agent session is closed (a running turn keeps running). */
  leave(sessionId: string): void;
  /** Says under the box why something the panel did for this chat failed. */
  showError(err: unknown): void;
}

const NEW_PLACEHOLDER = "Do this now, e.g. “Post ‘good morning’ on X”";
const CHAT_PLACEHOLDER = "Message browsertodo…";
const MAX_ROWS = 8;

export function initComposer(opts: {
  /** A message or a new task went out: show its conversation. */
  onStarted: (sessionId: string) => void;
  onState: (state: UiState) => void;
  /** The target changed (a conversation, a new chat, a run started or ended). */
  onTargetChange?: () => void;
  /** "Top up…" in the model menu. */
  onTopup?: () => void;
  /** The browser tab the panel is showing the chat of (null: unknown). */
  tabId?: () => number | null;
  /** The cursor entered or left the box (the keyboard shortcut toggles voice input from there). */
  onInputFocus?: (focused: boolean) => void;
}): ComposerView {
  const tab = (): { tabId?: number } => {
    const id = opts.tabId?.() ?? null;
    return id === null ? {} : { tabId: id };
  };
  const form = $<HTMLFormElement>("now-form");
  const text = $<HTMLTextAreaElement>("now-text");
  const attach = $("now-attach");
  const submit = $<HTMLButtonElement>("now-submit");
  const stop = $<HTMLButtonElement>("now-stop");
  const msg = $("now-msg");
  const fileInput = $<HTMLInputElement>("now-files");
  const filesList = $("now-files-list");
  const files = filePicker(fileInput, filesList, () => queueMicrotask(() => render()));
  const model = initModelPicker({ onState: opts.onState, onError: (t) => flash(msg, t, "bad"), onTopup: () => opts.onTopup?.() });
  // The attach control is a label around a hidden input; make it keyboard-operable.
  attach.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  let running = new Set<string>();
  let shown: SessionInfo | null = null;
  let panelTab: TabName = "chat";

  const target = (): SessionInfo | null => shown;
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
  let keyInterceptor: ((e: KeyboardEvent) => boolean) | null = null;
  // Enter sends, Shift+Enter adds a line (like chat apps).
  text.addEventListener("keydown", (e) => {
    if (keyInterceptor?.(e)) {
      e.preventDefault();
      return;
    }
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
    if (!value) return sendEmpty();
    const m = mode();
    const t = target();
    void busy(
      submit,
      async () => {
        if (m !== "new" && t) {
          clearInput();
          if (m === "conversation") flash(msg, "Sending…");
          try {
            await uiRequest({ type: "run.message", sessionId: t.sessionId, text: value, ...tab() });
          } catch (err) {
            // Not sent: the text goes back into the box.
            text.value = value;
            fit();
            throw err;
          }
          flash(msg, "");
          if (m === "conversation") opts.onStarted(t.sessionId);
          return;
        }
        flash(msg, "Starting…");
        const media = await filesToUploads(files.files());
        // No account field here: the agent picks up accounts named in the text ("post this from @beta").
        const { sessionId } = await uiRequest({ type: "run.adhoc", instructions: value, ...(media.length ? { media } : {}), ...tab() });
        clearInput();
        files.clear();
        flash(msg, "");
        opts.onStarted(sessionId);
      },
      msg,
    );
  });

  /** Empty box: in Chat, look at the page (see emptySend). */
  function sendEmpty(): void {
    const t = target();
    const next = emptySend({ panelTab, mode: mode(), sessionId: t?.sessionId ?? null, hasFiles: files.files().length > 0, tabId: opts.tabId?.() ?? null });
    if ("hint" in next) return void flash(msg, next.hint);
    void busy(
      submit,
      async () => {
        flash(msg, "Looking at the page…");
        const { sessionId } = await uiRequest(next.request);
        flash(msg, "");
        opts.onStarted(sessionId);
      },
      msg,
    );
  }

  text.addEventListener("focus", () => opts.onInputFocus?.(document.hasFocus()));
  text.addEventListener("blur", () => opts.onInputFocus?.(false));
  window.addEventListener("focus", () => opts.onInputFocus?.(document.activeElement === text));
  window.addEventListener("blur", () => opts.onInputFocus?.(false));

  stop.addEventListener("click", () => {
    // Stops this conversation's turn; other tasks keep running.
    const t = target();
    void busy(stop, () => uiRequest({ type: "run.stop", ...(t ? { sessionId: t.sessionId } : {}) }), msg);
  });

  /** The first render is the initial state, not a change (callers may not be wired yet). */
  let lastKey = "new:";
  function render(): void {
    const m = mode();
    const inChat = panelTab === "chat";
    text.placeholder = m !== "new" ? CHAT_PLACEHOLDER : inChat ? SCREEN_PLACEHOLDER : NEW_PLACEHOLDER;
    // In Chat an empty box can be sent: it looks at the page.
    const screenOk = inChat && m !== "running" && files.files().length === 0;
    form.classList.toggle("screen-ok", screenOk);
    submit.title = screenOk ? SCREEN_SEND_TITLE : "Send";
    text.setAttribute("aria-label", m === "new" ? "Task to do now" : m === "running" ? "Message to the agent" : "Next message in this conversation");
    stop.hidden = m !== "running";
    // Files go with a new task; a conversation keeps the files it started with.
    attach.hidden = m !== "new";
    filesList.hidden = m !== "new";
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
    actionSlot: $("now-actions"),
    draft: () => text.value,
    setDraft(value) {
      text.value = value;
      fit();
      // Keep the end of what is being dictated in view.
      text.scrollTop = text.scrollHeight;
    },
    send() {
      form.requestSubmit();
    },
    interceptKeys(handler) {
      keyInterceptor = handler;
    },
    focus() {
      text.focus();
    },
    setPanelTab(tab) {
      if (tab === panelTab) return;
      panelTab = tab;
      render();
    },
    async continueNow(sessionId) {
      const note = text.value.trim();
      flash(msg, "Continuing…");
      try {
        await uiRequest({ type: "run.continue", sessionId, ...(note ? { text: note } : {}), ...tab() });
        if (note) clearInput();
        flash(msg, "");
        opts.onStarted(sessionId);
      } catch (err) {
        showError(msg, err);
      }
    },
    leave(sessionId) {
      text.focus();
      void uiRequest({ type: "run.newChat", sessionId, ...tab() }).catch((err: unknown) => showError(msg, err));
    },
    setState(state) {
      model.setState(state);
    },
    showError(err) {
      showError(msg, err);
    },
  };

  render();
  fit();
  return view;
}
