/**
 * The input bar pinned to the bottom of the Tasks and Activity tabs. Idle, it
 * starts a one-off task ("Do this now"). While a task runs, the same box sends
 * messages to the agent, and Stop ends the task.
 */
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash } from "./dom.js";
import { filePicker, filesToUploads } from "./files.js";
import { initModelPicker } from "./model-menu.js";

export interface ComposerView {
  setRunning(running: boolean): void;
  /** Keeps the model chip in step with the settings and brain status. */
  setState(state: UiState): void;
  setVisible(visible: boolean): void;
}

const IDLE_PLACEHOLDER = "Do this now, e.g. “Post ‘good morning’ on X”";
const RUNNING_PLACEHOLDER = "Tell the agent something…";
const MAX_ROWS = 8;

export function initComposer(opts: { onStarted: () => void; onState: (state: UiState) => void }): ComposerView {
  const root = $("composer");
  const form = $<HTMLFormElement>("now-form");
  const text = $<HTMLTextAreaElement>("now-text");
  const attach = $("now-attach");
  const submit = $<HTMLButtonElement>("now-submit");
  const stop = $<HTMLButtonElement>("now-stop");
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
      text.placeholder = running ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER;
      text.setAttribute("aria-label", running ? "Message to the agent" : "Task to do now");
      submit.textContent = running ? "Send" : "Run";
      stop.hidden = !running;
      model.setRunning(running);
      attach.hidden = running;
      filesList.hidden = running;
      form.classList.toggle("running", running);
    },
    setState(state) {
      model.setState(state);
    },
    setVisible(visible) {
      root.hidden = !visible;
    },
  };
  fit();
  return view;
}
