/**
 * Voice input in the side panel: the mic button left of Send, the listening
 * orb in the middle of the panel, and the keys.
 *
 * - Click toggles listening; holding the button (push-to-talk) stops when
 *   let go. The keyboard shortcut toggles too (panel-command.ts).
 * - The text streams into the box while you speak (Dictation), after what
 *   you had typed (VoiceDraft). Enter stops, finishes the text and sends it
 *   the way Enter always does; Esc cancels and removes the voice text.
 * - A long silence or the 60 s cap stops listening and keeps the text.
 * - Plans without voice (and signed out) see a lock that explains, with a
 *   way to pick a plan. The microphone is asked for on mic-permission.html,
 *   since a side panel cannot show Chrome's prompt.
 */
import { errorMessage, plansWithText, VOICE_LIMITS, VOICE_TUNING } from "@browsertodo/shared";
import { Dictation, type AudioSource, type DictationResult, type StopReason, type TranscribeClip } from "../voice/dictation.js";
import { VoiceDraft } from "../voice/draft.js";
import type { MicPermission } from "../voice/mic-access.js";
import { VoiceError } from "../voice/transcribe.js";
import type { ComposerView } from "./composer.js";
import { h, restartAnimation } from "../ui/dom.js";

/** What the mic button shows. */
export type VoiceUiState = "locked" | "idle" | "opening" | "listening" | "transcribing";

/** From the plan catalog, e.g. "Voice needs the Plus or Pro plan". */
export const LOCKED_TEXT = `Voice needs ${plansWithText("voice")}`;
export const LISTENING_CAPTION = "Listening… Esc to cancel · Enter to send";
export const FINISHING_CAPTION = "Finishing…";

/** The mic button's tooltip and accessible name. */
export function micButtonTitle(state: VoiceUiState, shortcut: string | null): string {
  if (state === "locked") return LOCKED_TEXT;
  const base = state === "listening" || state === "opening" ? "Stop voice" : "Voice";
  return shortcut ? `${base} · ${shortcut}` : base;
}

/** The note after listening stopped by itself (the text stays in the box, unsent). */
export function stopNote(reason: StopReason): string | null {
  if (reason === "silence") return `Stopped listening after ${VOICE_TUNING.longSilenceMs / 1000} seconds of quiet. Your text is in the box.`;
  if (reason === "cap") return `Stopped at the ${VOICE_LIMITS.maxClipMs / 1000} second limit. Your text is in the box.`;
  return null;
}

/** A message under the mic button, with an optional action. */
export interface VoiceTip {
  text: string;
  tone: "info" | "bad";
  action?: { label: string; run: () => void };
}

/** The tip for a failure: plan and credit come with the dashboard's Billing page, which fixes them. */
export function errorTip(err: unknown, openBilling: () => void): VoiceTip {
  if (err instanceof VoiceError) {
    if (err.kind === "plan") return { text: err.message, tone: "bad", action: { label: "Get a plan", run: openBilling } };
    if (err.kind === "credit") return { text: err.message, tone: "bad", action: { label: "Top up", run: openBilling } };
    return { text: err.message, tone: "bad" };
  }
  return { text: `Voice stopped: ${errorMessage(err)}`, tone: "bad" };
}

/** getUserMedia refused: the permission was taken back (or never given) for this panel. */
const isMicRefused = (err: unknown) => (err as { name?: string } | null)?.name === "NotAllowedError";

export interface VoiceInputDeps {
  composer: Pick<ComposerView, "actionSlot" | "draft" | "setDraft" | "setDictating" | "send" | "focus" | "interceptKeys">;
  transcribe: TranscribeClip;
  createSource(): AudioSource;
  mic: {
    permission(): Promise<MicPermission>;
    openPermissionPage(): Promise<void>;
    /** Calls back when the permission changes; returns the unsubscribe. */
    watch(onChange: (state: MicPermission) => void): Promise<() => void>;
  };
  /** The dashboard's Billing page (pick a plan, top up). */
  openBilling(): void;
  /** Where the listening orb goes (the panel's body). */
  host: HTMLElement;
}

export interface VoiceInput {
  /** The account may use voice (signed in, a plan with voice in good standing). */
  setAllowed(allowed: boolean): void;
  /** The keyboard shortcut's label for the tooltip (null: none assigned). */
  setShortcut(label: string | null): void;
  /** The keyboard shortcut: start or stop; locked, it points at the button. */
  toggle(): void;
  readonly state: VoiceUiState;
}

const MIC_ICON =
  '<svg class="mic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75"/></svg>' +
  '<svg class="lock" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="currentColor"><path d="M5 7V5.5a3 3 0 0 1 6 0V7h.5A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5.5a1.5 1.5 0 0 0-3 0V7Z"/></svg>';

export function initVoiceInput(deps: VoiceInputDeps): VoiceInput {
  const { composer } = deps;
  let allowed = false;
  let shortcut: string | null = null;
  let ui: VoiceUiState = "locked";
  let dictation: Dictation | null = null;
  let draft: VoiceDraft | null = null;
  /** This press started listening (push-to-talk if held). */
  let pressStartedAt: number | null = null;
  let unwatchMic: (() => void) | null = null;

  const button = h("button.now-tool.voice-mic", { type: "button", "data-state": ui });
  button.innerHTML = MIC_ICON;
  const tip = h("div.voice-tip", { role: "status", "aria-live": "polite", hidden: true });
  composer.actionSlot.append(button, tip);

  const caption = h("p.voice-caption", null, LISTENING_CAPTION);
  // A veil over the panel (the input stays above it) with the orb and its caption in the middle.
  const orb = h(
    "div.voice-orb",
    { "aria-hidden": "true", hidden: true },
    h("div.voice-orb-stack", null, h("div.voice-orb-halo"), h("div.voice-orb-core"), caption),
  );
  deps.host.append(orb);

  // The level drives the orb and the button ring, once per frame at most.
  let level = 0;
  let frame = 0;
  const paint = () => {
    frame = 0;
    const v = level.toFixed(3);
    orb.style.setProperty("--level", v);
    button.style.setProperty("--level", v);
  };
  const setLevel = (l: number) => {
    level = l;
    if (!frame) frame = requestAnimationFrame(paint);
  };

  function render(next: VoiceUiState): void {
    ui = next;
    const title = micButtonTitle(ui, shortcut);
    button.dataset.state = ui;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(ui === "listening" || ui === "transcribing"));
    const active = ui === "listening" || ui === "transcribing" || ui === "opening";
    orb.hidden = !active;
    orb.dataset.state = ui;
    composer.setDictating(active);
    caption.textContent = ui === "transcribing" ? FINISHING_CAPTION : LISTENING_CAPTION;
    if (!active) setLevel(0);
  }

  /** Not listening: ready, or locked without a plan that includes voice. */
  const settle = () => render(allowed ? "idle" : "locked");

  function showTip(t: VoiceTip | null): void {
    tip.replaceChildren();
    tip.hidden = !t;
    if (!t) return;
    tip.dataset.tone = t.tone;
    tip.append(h("span", null, t.text));
    if (t.action) {
      const run = t.action.run;
      tip.append(h("button.link", { type: "button", onclick: () => (showTip(null), run()) }, t.action.label));
    }
    tip.append(h("button.voice-tip-close", { type: "button", "aria-label": "Dismiss", onclick: () => showTip(null) }, "×"));
  }

  const lockedTip = (): VoiceTip => ({ text: LOCKED_TEXT, tone: "info", action: { label: "Get a plan", run: () => deps.openBilling() } });

  /** Draws attention to the button (the shortcut was pressed while voice is locked). */
  function nudge(): void {
    restartAnimation(button, "nudge");
    button.focus();
  }

  /** Re-read after an await: a stop may have called the start off meanwhile. */
  const stillOpening = () => ui === "opening";

  async function start(): Promise<void> {
    if (ui !== "idle") return;
    showTip(null);
    render("opening");
    const permission = await deps.mic.permission();
    if (!stillOpening()) return; // stopped while checking
    if (permission !== "granted") return askForMic();
    const d = new Dictation({
      source: deps.createSource(),
      transcribe: deps.transcribe,
      events: {
        onLevel: setLevel,
        onState: (s) => {
          if (s === "listening" || s === "transcribing") render(s);
        },
        onText: (text) => draft && composer.setDraft(draft.update(composer.draft(), text)),
      },
    });
    dictation = d;
    draft = new VoiceDraft(composer.draft());
    composer.focus();
    let result: DictationResult;
    try {
      result = await d.run();
    } catch (err) {
      finish();
      if (isMicRefused(err)) return askForMic();
      showTip(errorTip(err, () => deps.openBilling()));
      return;
    }
    const current = draft;
    finish();
    if (!current) return;
    if (result.reason === "cancel") {
      composer.setDraft(current.discard(composer.draft()));
      return;
    }
    composer.setDraft(current.update(composer.draft(), result.text));
    if (result.reason === "send") return composer.send();
    const note = stopNote(result.reason);
    if (note) showTip({ text: note, tone: "info" });
  }

  function finish(): void {
    dictation = null;
    draft = null;
    settle();
  }

  /** Opens the permission page and waits there for the grant. */
  async function askForMic(): Promise<void> {
    settle();
    await deps.mic.openPermissionPage();
    showTip({ text: "Allow the microphone in the tab that opened, then press the mic again.", tone: "info" });
    unwatchMic?.();
    unwatchMic = await deps.mic.watch((state) => {
      if (state !== "granted") return;
      unwatchMic?.();
      unwatchMic = null;
      showTip({ text: "Microphone allowed. Press the mic to talk.", tone: "info" });
    });
  }

  /** Stops listening; before the microphone is even asked for, just calls the start off. */
  function stop(reason: "send" | "toggle"): void {
    if (dictation) void dictation.stop(reason);
    else if (ui === "opening") settle();
  }

  function toggle(): void {
    if (ui === "locked") {
      showTip(lockedTip());
      nudge();
    } else if (ui === "idle") void start();
    else if (ui === "listening" || ui === "opening") stop("toggle");
  }

  // Pointer: a press starts or stops; holding past pushToTalkMs and letting go stops (push-to-talk).
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the cursor in the box
    if (ui === "idle") {
      pressStartedAt = e.timeStamp;
      void start();
    } else {
      pressStartedAt = null;
      toggle();
    }
  });
  button.addEventListener("pointerup", (e) => {
    const heldFor = pressStartedAt === null ? 0 : e.timeStamp - pressStartedAt;
    pressStartedAt = null;
    if (heldFor >= VOICE_TUNING.pushToTalkMs) stop("toggle");
  });
  // Keyboard activation (Enter or Space on the button) arrives as a click with no pointer.
  button.addEventListener("click", (e) => {
    if (e.detail === 0) toggle();
  });

  // In the box: Enter sends what was said, Esc cancels. Other keys are typing (VoiceDraft keeps it).
  composer.interceptKeys((e) => {
    if (ui === "opening" && !dictation && e.key === "Enter") {
      stop("toggle"); // not listening yet: Enter sends the box as it is
      return false;
    }
    if (!dictation) {
      if (!tip.hidden && tip.dataset.tone === "info" && e.key.length === 1) showTip(null);
      return false;
    }
    if (e.key === "Escape") {
      dictation.cancel();
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      stop("send");
      return true; // sent once the final text is in
    }
    return false;
  });
  // Esc anywhere in the panel cancels too.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dictation && !e.defaultPrevented) {
      e.preventDefault();
      dictation.cancel();
    }
  });

  render(ui);
  return {
    setAllowed(next) {
      allowed = next;
      if (!next) dictation?.cancel();
      if (ui === "locked" || ui === "idle") settle();
    },
    setShortcut(label) {
      shortcut = label;
      render(ui);
    },
    toggle,
    get state() {
      return ui;
    },
  };
}
