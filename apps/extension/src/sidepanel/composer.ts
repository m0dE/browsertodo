/**
 * The input bar pinned to the bottom of the Tasks and Activity tabs. Idle, it
 * starts a one-off task ("Do this now"). While a task runs, the same box sends
 * messages to the agent, and Stop ends the task. When the Activity tab shows
 * a run that stopped before finishing, it continues that run (with an
 * optional note) until the user picks "New task".
 */
import type { SessionInfo } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash } from "./dom.js";
import { filePicker, filesToUploads } from "./files.js";
import { initModelPicker } from "./model-menu.js";

export interface ComposerView {
  setRunning(running: boolean): void;
  /** Keeps the model chip in step with the settings and brain status. */
  setState(state: UiState): void;
  setVisible(visible: boolean): void;
  /** A stopped run the composer offers to continue (null: none). */
  setContinueTarget(session: SessionInfo | null): void;
  /** Continue a run now; the box's text is the note when the composer is in continue mode. */
  continueRun(sessionId: string): Promise<void>;
}

const IDLE_PLACEHOLDER = "Do this now, e.g. “Post ‘good morning’ on X”";
const RUNNING_PLACEHOLDER = "Tell the agent something…";
const CONTINUE_PLACEHOLDER = "Continue with a note (optional)…";
const MAX_ROWS = 8;

export function initComposer(opts: {
  onStarted: () => void;
  onState: (state: UiState) => void;
  /** A stopped run was continued: follow the new session. */
  onContinued?: () => void;
}): ComposerView {
  const root = $("composer");
  const form = $<HTMLFormElement>("now-form");
  const text = $<HTMLTextAreaElement>("now-text");
  const attach = $("now-attach");
  const submit = $<HTMLButtonElement>("now-submit");
  const stop = $<HTMLButtonElement>("now-stop");
  const newTask = $<HTMLButtonElement>("now-new");
  const msg = $("now-msg");
  const fileInput = $<HTMLInputElement>("now-files");
  const filesList = $("now-files-list");
  const files = filePicker(fileInput, filesList);
  const model = initModelPicker({ onState: opts.onState, onError: (text) => flash(msg, text, "bad") });
  // The attach control is a label around a hidden input; make it keyboard-operable.
  attach.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  let running = false;
  let target: SessionInfo | null = null;
  /** The run the user chose "New task" over; the composer stays in "Do this now" for it. */
  let dismissed: string | null = null;
  const continuing = () => !running && !!target && target.sessionId !== dismissed;

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
    if (continuing()) return void continueRun(target!.sessionId);
    if (!value) return;
    void busy(submit, async () => {
      if (running) {
        clearInput();
        try {
          await uiRequest({ type: "run.say", text: value });
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
        await uiRequest({
          type: "run.adhoc",
          instructions: value,
          ...(media.length ? { media } : {}),
        });
        clearInput();
        files.clear();
        flash(msg, "");
        opts.onStarted();
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    });
  });

  async function continueRun(sessionId: string): Promise<void> {
    // In "Do this now" mode the box holds a new task, not a note.
    const note = continuing() && target?.sessionId === sessionId ? text.value.trim() : "";
    await busy(submit, async () => {
      flash(msg, "Continuing…");
      try {
        await uiRequest({ type: "run.continue", sessionId, ...(note ? { text: note } : {}) });
        if (note) clearInput();
        flash(msg, "");
        (opts.onContinued ?? opts.onStarted)();
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    });
  }

  newTask.addEventListener("click", () => {
    dismissed = target?.sessionId ?? null;
    render();
    text.focus();
  });

  stop.addEventListener("click", () =>
    void busy(stop, async () => {
      try {
        await uiRequest({ type: "run.stop" });
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    }),
  );

  const view: ComposerView = {
    setRunning(next) {
      if (next === running) return;
      running = next;
      model.setRunning(running);
      render();
    },
    setContinueTarget(session) {
      if (session?.sessionId === target?.sessionId) return;
      target = session;
      render();
    },
    continueRun,
    setState(state) {
      model.setState(state);
    },
    setVisible(visible) {
      root.hidden = !visible;
    },
  };
  function render(): void {
    const cont = continuing();
    text.placeholder = running ? RUNNING_PLACEHOLDER : cont ? CONTINUE_PLACEHOLDER : IDLE_PLACEHOLDER;
    text.setAttribute("aria-label", running ? "Message to the agent" : cont ? "Note for continuing the stopped run" : "Task to do now");
    submit.textContent = running ? "Send" : cont ? "Continue" : "Run";
    stop.hidden = !running;
    // Continuing reuses the stopped run's files; new ones only go with a new task.
    attach.hidden = running || cont;
    filesList.hidden = running || cont;
    newTask.hidden = !cont;
    form.classList.toggle("running", running);
    form.classList.toggle("continue", cont);
  }

  render();
  fit();
  return view;
}
