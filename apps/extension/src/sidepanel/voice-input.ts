/**
 * Voice input in the side panel: the mic button left of Send, the listening
 * orb in the middle of the panel, and the keys.
 *
 * - Click toggles listening; holding the button (push-to-talk) stops when
 *   let go. The voice shortcut (panel-command.ts) starts a hands-free
 *   session instead (hands-free.ts), which shows itself on this button and
 *   orb; pressed again, or the button clicked, it ends.
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
import { FIXES } from "./error-help.js";
import { h, restartAnimation } from "../ui/dom.js";

/** What the mic button shows ("handsfree": a hands-free session is on). */
export type VoiceUiState = "locked" | "idle" | "opening" | "listening" | "transcribing" | "handsfree";

/** Dictating (the mic button), starting to, or finishing the text: the voice shortcut then stops and sends. */
export const isListening = (state: VoiceUiState): boolean => state === "listening" || state === "transcribing" || state === "opening";

/** From the plan catalog, e.g. "Voice needs the Plus or Pro plan". */
export const LOCKED_TEXT = `Voice needs ${plansWithText("voice")}`;
export const LISTENING_CAPTION = "Listening… Esc to cancel · Enter to send";
export const FINISHING_CAPTION = "Finishing…";

/** The mic button's tooltip and accessible name. */
export function micButtonTitle(state: VoiceUiState, shortcut: string | null): string {
  if (state === "locked") return LOCKED_TEXT;
  if (state === "handsfree") return shortcut ? `Stop hands-free · ${shortcut}` : "Stop hands-free";
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
    if (err.kind === "plan") return { text: err.message, tone: "bad", action: { label: FIXES.plans.label, run: openBilling } };
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
  /** Voice started or stopped listening (isListening). */
  onListening?(listening: boolean): void;
  /** Where the listening orb goes (the panel's body). */
  host: HTMLElement;
}

/** How a hands-free session shows on the mic button and the orb (null: none is on). */
export interface HandsFreeLook {
  /** The orb in the middle of the panel (the pill carries the session once something was sent). */
  orb: boolean;
  /** Under the orb. */
  caption: string;
  /** "sending" / "speaking" change the orb's rhythm. */
  phase: string;
}

/** What voice input needs of the hands-free session (hands-free.ts). */
export interface HandsFreeControl {
  readonly active: boolean;
  start(): void;
  stop(reason: "shortcut" | "button"): void;
}

export interface VoiceInput {
  /** The account may use voice (signed in, a plan with voice in good standing). */
  setAllowed(allowed: boolean): void;
  /** The voice shortcut's label for the tooltip (null: none assigned). */
  setShortcut(label: string | null): void;
  /**
   * The voice shortcut: start or end a hands-free session (a dictation started with the button is
   * stopped and sent instead); locked, it points at the button and says why.
   */
  shortcut(): void;
  readonly state: VoiceUiState;
  /** Wires the hands-free session in (the shortcut and the button then start and end it). */
  attachHandsFree(control: HandsFreeControl): void;
  /** The hands-free session's look on the button and the orb. */
  showHandsFree(look: HandsFreeLook | null): void;
  /** The microphone level (the hands-free session's), 0..1. */
  setLevel(level: number): void;
  /** Shows (or clears) the message under the mic button. */
  showTip(tip: VoiceTip | null): void;
  /** Tips show in `slot` instead (the hands-free bar), or under the mic again with null. */
  setTipSlot(slot: HTMLElement | null): void;
  /** True when the microphone may be used; otherwise asks for it (the permission page) and says so. */
  ensureMic(): Promise<boolean>;
}

const MIC_ICON =
  '<svg class="mic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75"/></svg>' +
  '<svg class="lock" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="currentColor"><path d="M5 7V5.5a3 3 0 0 1 6 0V7h.5A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5.5a1.5 1.5 0 0 0-3 0V7Z"/></svg>';

export function initVoiceInput(deps: VoiceInputDeps): VoiceInput {
  const { composer } = deps;
  let allowed = false;
  let shortcutLabel: string | null = null;
  let ui: VoiceUiState = "locked";
  /** What onListening last said. */
  let wasActive = false;
  let dictation: Dictation | null = null;
  let draft: VoiceDraft | null = null;
  /** This press started listening (push-to-talk if held). */
  let pressStartedAt: number | null = null;
  let unwatchMic: (() => void) | null = null;
  let handsFree: HandsFreeControl | null = null;
  let hfLook: HandsFreeLook | null = null;

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
    const shown = hfLook && ui !== "locked" ? "handsfree" : ui;
    const title = micButtonTitle(shown, shortcutLabel);
    button.dataset.state = shown;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(ui === "listening" || ui === "transcribing" || !!hfLook));
    const active = isListening(ui);
    if (active !== wasActive) deps.onListening?.(active);
    wasActive = active;
    orb.hidden = !(active || hfLook?.orb);
    orb.dataset.state = hfLook && !active ? hfLook.phase : ui;
    composer.setDictating(active || !!hfLook);
    caption.textContent = hfLook && !active ? hfLook.caption : ui === "transcribing" ? FINISHING_CAPTION : LISTENING_CAPTION;
    if (!active && !hfLook) setLevel(0);
  }

  /** Not listening: ready, or locked without a plan that includes voice. */
  const settle = () => render(allowed ? "idle" : "locked");

  /** Where tips show: under the mic, or the hands-free bar's slot while a session is on (so they never cover its pill). */
  let tipEl: HTMLElement = tip;
  let shownTip: VoiceTip | null = null;

  function showTip(t: VoiceTip | null): void {
    shownTip = t;
    tipEl.replaceChildren();
    tipEl.hidden = !t;
    if (!t) return;
    tipEl.dataset.tone = t.tone;
    tipEl.append(h("span", null, t.text));
    if (t.action) {
      const run = t.action.run;
      tipEl.append(h("button.link", { type: "button", onclick: () => (showTip(null), run()) }, t.action.label));
    }
    tipEl.append(h("button.voice-tip-close", { type: "button", "aria-label": "Dismiss", onclick: () => showTip(null) }, "×"));
  }

  /** Moves tips (and the one shown) into `slot`, or back under the mic with null. */
  function setTipSlot(slot: HTMLElement | null): void {
    const current = shownTip;
    showTip(null);
    tipEl = slot ?? tip;
    showTip(current);
  }

  const lockedTip = (): VoiceTip => ({ text: LOCKED_TEXT, tone: "info", action: { label: FIXES.plans.label, run: () => deps.openBilling() } });

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
    } else if (handsFree?.active) handsFree.stop("button");
    else if (ui === "idle") void start();
    else if (ui === "listening" || ui === "opening") stop("toggle");
  }

  /** The voice shortcut: hands-free on or off; a dictation from the button is stopped and sent (the way Enter does). */
  function shortcut(): void {
    if (ui === "locked") return toggle();
    if (ui === "listening" || ui === "opening") return stop("send");
    if (ui === "transcribing") return;
    if (!handsFree) return toggle();
    if (handsFree.active) handsFree.stop("shortcut");
    else handsFree.start();
  }

  // Pointer: a press starts or stops; holding past pushToTalkMs and letting go stops (push-to-talk).
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep the cursor in the box
    if (ui === "idle" && !handsFree?.active) {
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
      if (shownTip?.tone === "info" && e.key.length === 1) showTip(null);
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
      shortcutLabel = label;
      render(ui);
    },
    shortcut,
    get state() {
      return ui;
    },
    attachHandsFree(control) {
      handsFree = control;
    },
    showHandsFree(look) {
      hfLook = look;
      render(ui);
    },
    setLevel,
    showTip,
    setTipSlot,
    async ensureMic() {
      if ((await deps.mic.permission()) === "granted") return true;
      await askForMic();
      return false;
    },
  };
}
