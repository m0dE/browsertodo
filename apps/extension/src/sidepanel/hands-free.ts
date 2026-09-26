/**
 * The hands-free session in the side panel (the voice shortcut starts and
 * ends it): runs the state machine (voice/hands-free.ts) on what the engine
 * hears, carries out its effects (send the message through the composer,
 * say a line, stop talking), and shows it: the orb until something was
 * sent, then a compact pill above the input ("Hands-free · listening") with
 * a caption of what is being said.
 *
 * The engine is the one picked in Settings (voice/engine-choice.ts):
 * Realtime unless the server cannot run it or the credit is low; a Realtime
 * failure that Standard can cover switches to Standard with a one-line note.
 * The first Realtime session shows what it costs once, with a switch to
 * Standard. Mic permission and plan gating are voice-input.ts's.
 *
 * Audio lives in the side panel, not an offscreen document: the session is
 * started from the panel, shows itself there, and ends when the panel
 * closes, so the microphone is never on without the indicator in view.
 */
import type { AccountView } from "../ui-protocol.js";
import { errorMessage, type AgentEvent, type ExtensionSettings, type StampedAgentEvent, type VoiceEngine, type VoiceEngineId, type VoiceEnginesResponse } from "@browsertodo/shared";
import { h } from "../ui/dom.js";
import { chooseEngine, costPerMinuteText } from "../voice/engine-choice.js";
import type { EngineEvents, HandsFreeEngine } from "../voice/engine.js";
import { HANDS_FREE, handsFree, initialHandsFree, type EndReason, type HandsFreeEffect, type HandsFreeEvent, type HandsFreePhase, type HandsFreeState } from "../voice/hands-free.js";
import { ChatFollower } from "../voice/chat-follower.js";
import { Narration } from "../voice/narration.js";
import type { RealtimeFailure } from "../voice/realtime-client.js";
import { VoiceError } from "../voice/transcribe.js";
import { errorHelp } from "./error-help.js";
import { errorTip, type HandsFreeControl, type VoiceInput, type VoiceTip } from "./voice-input.js";

/** What the pill says in each phase. */
export const PILL_TEXT: Record<Exclude<HandsFreePhase, "off">, string> = {
  listening: "Hands-free · listening",
  sending: "Sending… (say “cancel” or Esc)",
  working: "Hands-free · listening while it works",
  speaking: "Speaking… talk to interrupt",
};

/** The pill while the engine starts. */
const STARTING_TEXT = "Hands-free · starting…";

/** Under the orb before anything was sent. */
const ORB_CAPTION = "Hands-free: say what to do · “stop” to end";

/** Said-line captions stay this long after the line. */
const CAPTION_LINGER_MS = 4_000;

/** Why the session stopped, when the user did not stop it themselves. */
function endNote(reason: EndReason): string | null {
  if (reason === "silence") return `Hands-free stopped after ${HANDS_FREE.silenceTimeoutMs / 60_000} minutes of quiet.`;
  return null;
}

export interface HandsFreeDeps {
  voice: Pick<VoiceInput, "state" | "attachHandsFree" | "showHandsFree" | "setLevel" | "showTip" | "setTipSlot" | "ensureMic" | "shortcut">;
  composer: {
    draft(): string;
    setDraft(value: string): void;
    send(): void;
  };
  /** The chat whose events are narrated (the one the Chat tab shows, or the one just started). */
  followed(): string | null;
  settings(): ExtensionSettings | null;
  account(): AccountView | undefined;
  /** The server's voice engines (null: could not be loaded). */
  engines(): Promise<VoiceEnginesResponse | null>;
  saveSettings(patch: Partial<ExtensionSettings>): Promise<void>;
  createEngine(id: VoiceEngineId, events: EngineEvents): HandsFreeEngine;
  /** Stops the followed chat's running task; says what happened. */
  stopTask(): Promise<string>;
  openBilling(): void;
  signIn(): void;
  /** The session started or ended (the panel tells the background, so the shortcut ends it). */
  onActive(active: boolean): void;
  /** Where the pill goes (the composer). */
  host: HTMLElement;
  log?(message: string): void;
  now?(): number;
}

export interface HandsFree extends HandsFreeControl {
  /** An event of any chat (the followed one's are narrated). */
  onEvent(ev: StampedAgentEvent): void;
  /** The followed chat has a task running (called whenever the chat shown or the running tasks change). */
  setWorking(working: boolean): void;
  readonly phase: HandsFreePhase;
}

export function initHandsFree(deps: HandsFreeDeps): HandsFree {
  const now = deps.now ?? (() => Date.now());
  let state: HandsFreeState = initialHandsFree();
  let engine: HandsFreeEngine | null = null;
  let narration = new Narration();
  let timer: ReturnType<typeof setInterval> | null = null;
  let working = false;
  /** Something was sent this session (the orb then gives way to the pill). */
  let sent = false;
  /** The box's text before the session wrote the user's words into it. */
  let boxBase = "";
  let caption = "";
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Starting (engine choice, microphone, connection). */
  let starting = false;
  const chat = new ChatFollower(deps.followed);

  const pillLabel = h("span.hf-label");
  const stopBtn = h("button.hf-stop", { type: "button", "aria-label": "Stop hands-free", title: "Stop hands-free" }, "×");
  const pill = h("div.hf-pill", { role: "status", "aria-live": "polite" }, h("span.hf-dot", { "aria-hidden": "true" }), pillLabel, stopBtn);
  const captionEl = h("p.hf-caption", { hidden: true });
  // Notes during a session (the cost, a fallback) show here, above the pill, not over it.
  const noteSlot = h("div.voice-tip.hf-note", { role: "status", "aria-live": "polite", hidden: true });
  const bar = h("div.hf-bar", { hidden: true }, noteSlot, captionEl, pill);
  deps.host.append(bar);
  stopBtn.addEventListener("click", () => stop("button"));

  function render(): void {
    const on = state.phase !== "off" || starting;
    if (bar.hidden === on) deps.voice.setTipSlot(on ? noteSlot : null);
    bar.hidden = !on;
    if (!on) {
      deps.voice.showHandsFree(null);
      return;
    }
    // Off while on: the engine is still starting (microphone, connection).
    const phase = state.phase === "off" ? null : state.phase;
    bar.dataset.phase = phase ?? "starting";
    pillLabel.textContent = phase ? PILL_TEXT[phase] : STARTING_TEXT;
    captionEl.hidden = !caption;
    captionEl.textContent = caption;
    const orb = !sent && phase !== "working";
    // With the orb in view its caption carries the words; the pill stays below it.
    deps.voice.showHandsFree({ orb, phase: phase ?? "opening", caption: phase === "sending" ? "Sending…" : caption || (phase ? ORB_CAPTION : STARTING_TEXT) });
  }

  function setCaption(text: string, linger = false): void {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = null;
    caption = text;
    if (linger && text) captionTimer = setTimeout(() => setCaption(""), CAPTION_LINGER_MS);
    render();
  }

  function dispatch(e: HandsFreeEvent): void {
    const r = handsFree(state, e);
    state = r.state;
    for (const effect of r.effects) run(effect);
    render();
  }

  function run(effect: HandsFreeEffect): void {
    switch (effect.type) {
      case "send":
        sent = true;
        chat.sent(now());
        deps.composer.setDraft(effect.text);
        deps.composer.send();
        boxBase = "";
        break;
      case "speak":
        setCaption(effect.text);
        engine?.speak(effect.text);
        break;
      case "hush":
        engine?.hush();
        break;
      case "transcribe":
        engine?.setTranscribing(effect.on);
        break;
      case "cancelled":
        deps.composer.setDraft(boxBase);
        engine?.cancelled();
        setCaption("Cancelled.", true);
        break;
      case "end":
        finish(endNote(effect.reason));
        break;
    }
  }

  /** The user's words so far, in the box (after what was typed there). */
  function showWords(text: string): void {
    const pending = state.pending ? `${state.pending} ` : "";
    deps.composer.setDraft([boxBase.trim(), `${pending}${text}`.trim()].filter(Boolean).join(" "));
  }

  function events(): EngineEvents {
    const alive = (fn: () => void) => () => state.phase !== "off" && fn();
    return {
      speech: () => alive(() => dispatch({ type: "speech", now: now() }))(),
      heard: (text, forward) =>
        alive(() => {
          dispatch({ type: "heard", text, forward, now: now() });
          if (state.phase === "sending") showWords("");
          else if (!forward && state.phase !== "off") deps.composer.setDraft(boxBase);
        })(),
      partial: (text) => alive(() => showWords(text))(),
      level: (l) => deps.voice.setLevel(l),
      narrating: () => alive(() => dispatch({ type: "narrating", now: now() }))(),
      said: () =>
        alive(() => {
          dispatch({ type: "said", now: now() });
          if (caption) setCaption(caption, true);
        })(),
      narratorText: (t) => alive(() => setCaption(t))(),
      forward: (text) =>
        alive(() => {
          dispatch({ type: "forward", text, now: now() });
          showWords("");
        })(),
      cancelRequest: () => {
        if (state.phase !== "sending") return false;
        dispatch({ type: "cancel", now: now() });
        return true;
      },
      stopTask: () => deps.stopTask(),
      endVoice: () => stop("narrator"),
      failed: (err) => void onEngineFailure(err),
    };
  }

  /** Why an engine stopped: Realtime trouble that Standard can cover switches over; anything else ends the session. */
  async function onEngineFailure(err: unknown): Promise<void> {
    const f = err as Partial<RealtimeFailure>;
    if (engine?.id === "realtime" && f.fallback && f.message) {
      engine.stop();
      engine = null;
      deps.voice.showTip({ text: f.message, tone: "info" });
      await openEngine("standard");
      return;
    }
    finish(null);
    deps.voice.showTip(failureTip(err));
  }

  function failureTip(err: unknown): VoiceTip {
    if (err instanceof VoiceError) return errorTip(err, deps.openBilling);
    const message = (err as Partial<RealtimeFailure>)?.message ?? errorMessage(err);
    const help = errorHelp(message);
    const fix = help.fixes.find((x) => x.kind === "topup" || x.kind === "plans" || x.kind === "login");
    const action = fix ? { label: fix.label, run: fix.kind === "login" ? deps.signIn : deps.openBilling } : undefined;
    return { text: help.known ? help.message : message, tone: "bad", ...(action ? { action } : {}) };
  }

  /** Opens `id` (falling back from Realtime when it cannot start); true when a session runs. */
  async function openEngine(id: VoiceEngineId): Promise<boolean> {
    const e = deps.createEngine(id, events());
    engine = e;
    try {
      await e.start();
    } catch (err) {
      if (engine !== e) return false; // stopped meanwhile
      e.stop();
      engine = null;
      const f = err as Partial<RealtimeFailure>;
      if (id === "realtime" && f.fallback) {
        deps.voice.showTip({ text: f.message ?? "Realtime voice isn't available right now, so this uses Standard voice.", tone: "info" });
        return openEngine("standard");
      }
      finish(null);
      deps.voice.showTip(failureTip(err));
      return false;
    }
    if (engine !== e) return false;
    if (state.phase === "off") dispatch({ type: "start", now: now(), halfDuplex: e.halfDuplex });
    else if (e.halfDuplex !== state.halfDuplex) state = { ...state, halfDuplex: e.halfDuplex };
    e.setTranscribing(state.phase !== "speaking");
    if (working) dispatch({ type: "agent", working, now: now() });
    return true;
  }

  async function start(): Promise<void> {
    if (state.phase !== "off" || starting) return;
    starting = true;
    sent = false;
    chat.start();
    boxBase = deps.composer.draft();
    narration = new Narration();
    render();
    deps.onActive(true);
    const settings = deps.settings();
    try {
      if (!(await deps.voice.ensureMic())) return void finish(null);
      const engines = settings?.voiceEngine === "standard" ? null : await deps.engines().catch(() => null);
      if (!starting) return; // stopped meanwhile
      const choice = chooseEngine({ preferred: settings?.voiceEngine ?? "realtime", engines, creditCents: deps.account()?.credit?.totalCents });
      if (choice.note) deps.voice.showTip({ text: choice.note, tone: "info" });
      else if (choice.engine === "realtime" && settings && !settings.realtimeCostNoticed) costNotice(engines?.engines ?? null);
      if (!(await openEngine(choice.engine))) return;
      timer = setInterval(() => {
        const t = now();
        dispatch({ type: "tick", now: t });
        engine?.tick(t);
      }, HANDS_FREE.tickMs);
    } finally {
      starting = false;
      render();
    }
  }

  /** Once: what Realtime costs, with a one-click switch to Standard. */
  function costNotice(engines: VoiceEngine[] | null): void {
    const rt = engines?.find((e) => e.id === "realtime");
    const std = engines?.find((e) => e.id === "standard");
    const cost = rt ? `Realtime voice uses ${costPerMinuteText(rt.approxCentsPerMinute)}` : "Realtime voice uses usage credit by the minute";
    const cheaper = std ? ` (Standard: ${costPerMinuteText(std.approxCentsPerMinute).replace(/^about /, "")}).` : ".";
    deps.voice.showTip({
      text: `${cost}${cheaper}`,
      tone: "info",
      action: {
        label: "Use Standard",
        run: () => {
          void deps.saveSettings({ voiceEngine: "standard" }).catch((err: unknown) => deps.log?.(`switching to Standard failed: ${errorMessage(err)}`));
          if (engine?.id === "realtime") {
            engine.stop();
            engine = null;
            void openEngine("standard");
          }
        },
      },
    });
    void deps.saveSettings({ realtimeCostNoticed: true }).catch((err: unknown) => deps.log?.(`saving the cost notice failed: ${errorMessage(err)}`));
  }

  function finish(note: string | null): void {
    if (timer) clearInterval(timer);
    timer = null;
    const e = engine;
    engine = null;
    e?.stop();
    starting = false;
    if (state.phase !== "off") state = { ...initialHandsFree() };
    if (deps.composer.draft() !== boxBase && !sent) deps.composer.setDraft(boxBase);
    setCaption("");
    deps.voice.setLevel(0);
    render();
    deps.onActive(false);
    if (note) deps.voice.showTip({ text: note, tone: "info" });
  }

  function stop(reason: EndReason): void {
    if (state.phase === "off") {
      if (starting) finish(null);
      return;
    }
    dispatch({ type: "stop", reason });
  }

  // Esc: cancels the message waiting to be sent, cuts a line off, else ends the session.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || state.phase === "off") return;
    e.preventDefault();
    dispatch({ type: "cancel", now: now() });
  });

  /** Tells the engine (and, Standard, the narration) about an event of the followed chat. */
  function narrate(ev: StampedAgentEvent): void {
    const t = now();
    engine?.agentEvent(ev as AgentEvent, t);
    if (engine?.id !== "standard") return;
    const line = narration.push(ev, t);
    if (line) dispatch({ type: "say", text: line, now: t });
  }

  const control: HandsFree = {
    get active() {
      return state.phase !== "off" || starting;
    },
    get phase() {
      return state.phase;
    },
    start: () => void start(),
    stop,
    onEvent(ev) {
      if (state.phase !== "off") for (const e of chat.push(ev)) narrate(e);
    },
    setWorking(next) {
      if (state.phase !== "off") for (const e of chat.refresh()) narrate(e);
      if (next === working) return;
      working = next;
      if (state.phase !== "off") dispatch({ type: "agent", working: next, now: now() });
    },
  };
  deps.voice.attachHandsFree(control);
  return control;
}
