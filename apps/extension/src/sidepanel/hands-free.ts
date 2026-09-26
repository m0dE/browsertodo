/**
 * The hands-free session in the side panel (the voice shortcut starts and
 * ends it): runs the state machine (voice/hands-free.ts) on what the engine
 * hears, carries out its effects (send the message, say a line, stop
 * talking), and shows it: the orb until something was sent, then a compact
 * pill in the notice row above the input ("Hands-free · listening").
 *
 * A session belongs to the browser tab it started in (voice/hands-free-tab.ts):
 * what is said goes to that tab's chat by its id, and that chat's events are
 * narrated, whichever tab the panel shows. On another tab the pill says where
 * it listens, with Go to tab and Use this tab (the only way to move it); the
 * voice key and the mic end it wherever it listens; closing its tab ends it.
 *
 * What is said aloud is part of the chat: each line (not the milestones,
 * which repeat the tool rows) is kept in its chat as a "spoken" event, shown
 * playing while it is said.
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
import { elsewhereLabel, endsWithTab, listensElsewhere, MOVED_NOTE, TAB_CLOSED_NOTE, voiceKeyAction } from "../voice/hands-free-tab.js";
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
  speaking: "Hands-free · speaking",
};

/** The pill while the engine starts. */
const STARTING_TEXT = "Hands-free · starting…";

/** Under the orb before anything was sent. */
const ORB_CAPTION = "Hands-free: say what to do · “stop” to end";

/** A said line stays under the orb this long after it. */
const CAPTION_LINGER_MS = 4_000;

/** Notices about the engine (a fallback, the cost) go under this key, apart from voice's others. */
const ENGINE_NOTICE = "voice.engine";

/** Why the session stopped, when the user did not stop it themselves. */
function endNote(reason: EndReason): string | null {
  if (reason === "silence") return "Hands-free stopped: it was quiet for a while.";
  return null;
}

/** A line being said: in which chat (null: none yet), its words so far, and whether the chat keeps it. */
interface Line {
  sessionId: string | null;
  text: string;
  keep: boolean;
}

export interface HandsFreeDeps {
  voice: Pick<VoiceInput, "state" | "attachHandsFree" | "showHandsFree" | "setLevel" | "showTip" | "ensureMic">;
  /** The input box: the user's words show there while the session's tab is shown. */
  composer: {
    draft(): string;
    setDraft(value: string): void;
  };
  /** Voice's notices above the box (a fallback, the cost, why it stopped). */
  notify(tip: VoiceTip & { key?: string }): void;
  /** The browser tab the panel shows (null: unknown). */
  activeTab(): number | null;
  /** The chat of a browser tab (null: it has none yet). */
  chatOf(tabId: number | null): string | null;
  /** The tabs a chat lives in now: the tab it belongs to and the tabs its running task works in. */
  tabsOf(sessionId: string): readonly number[];
  /** Sends what was said to chat `sessionId` (null: starts one in `tabId`); resolves with the chat's id. */
  send(text: string, target: { tabId: number | null; sessionId: string | null }): Promise<string>;
  /** A tab's title, for the pill on other tabs. */
  tabTitle(tabId: number): Promise<string | null>;
  /** Shows a tab (Go to tab). */
  goToTab(tabId: number): void;
  /** A line is being said in a chat (null: it is over). */
  onSpeaking(line: { sessionId: string; text: string } | null): void;
  /** Keeps a said line in its chat. */
  keepSpoken(sessionId: string, text: string): void;
  settings(): ExtensionSettings | null;
  account(): AccountView | undefined;
  /** The server's voice engines (null: could not be loaded). */
  engines(): Promise<VoiceEnginesResponse | null>;
  saveSettings(patch: Partial<ExtensionSettings>): Promise<void>;
  createEngine(id: VoiceEngineId, events: EngineEvents): HandsFreeEngine;
  /** Stops the running task of a chat; says what happened. */
  stopTask(sessionId: string | null): Promise<string>;
  openBilling(): void;
  signIn(): void;
  /** The session started or ended (the panel tells the background, so the shortcut ends it). */
  onActive(active: boolean): void;
  /** Where the pill goes (the notice row above the input). */
  host: HTMLElement;
  log?(message: string): void;
  now?(): number;
}

export interface HandsFree extends HandsFreeControl {
  /** An event of any chat (the session's chat's are narrated). */
  onEvent(ev: StampedAgentEvent): void;
  /** The chats with a task running now (the session's chat working keeps it listening). */
  setRunning(sessionIds: readonly string[]): void;
  /** The tab shown, or a tab's chat, changed: the pill and the chat followed are looked at again. */
  refresh(): void;
  /** A browser tab closed (its own ends the session). */
  tabClosed(tabId: number): void;
  /** The chat the session talks to (null: none, or a new chat not started yet). */
  chat(): string | null;
  readonly phase: HandsFreePhase;
}

export function initHandsFree(deps: HandsFreeDeps): HandsFree {
  const now = deps.now ?? (() => Date.now());
  let state: HandsFreeState = initialHandsFree();
  let engine: HandsFreeEngine | null = null;
  let narration = new Narration();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: ReadonlySet<string> = new Set();
  let working = false;
  /** Something was sent this session (the orb then gives way to the pill). */
  let sent = false;
  /** The tab the session belongs to, and its title (for the pill on other tabs). */
  let tab: number | null = null;
  let tabTitle: string | null = null;
  /** Its tab and the tabs its chat lived in this session (see voice/hands-free-tab.ts). */
  const ownTabs = new Set<number>();
  /**
   * The chat the session talks to, by id once known (the tab's chat when it started, or the one its first
   * message started): the chat may move to another tab (a run started from an extension page works in a tab of
   * its own, and the chat goes with it), and the session follows the chat, not the tab.
   */
  let chatId: string | null = null;
  /** The box's text before the session wrote the user's words into it; whether the box shows them. */
  let boxBase = "";
  let wroteBox = false;
  /** Under the orb (before anything was sent): what is being said. */
  let caption = "";
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  let line: Line | null = null;
  /** Milestone lines (said, but not kept: the chat shows those steps already). */
  const passing = new Set<string>();
  /** Starting (engine choice, microphone, connection). */
  let starting = false;
  const chatNow = () => chatId ?? deps.chatOf(tab);
  const follower = new ChatFollower(chatNow);
  const on = () => state.phase !== "off" || starting;
  /** Adds the tabs the session's chat works in now to its own. */
  const learnTabs = () => {
    const chat = chatNow();
    if (chat) for (const t of deps.tabsOf(chat)) ownTabs.add(t);
  };
  const here = () => {
    learnTabs();
    return !listensElsewhere(ownTabs, deps.activeTab());
  };

  const pillLabel = h("span.hf-label");
  const goBtn = h("button.link.hf-go", { type: "button", hidden: true, title: "Show the tab hands-free listens in" }, "Go to tab");
  const useBtn = h("button.link.hf-use", { type: "button", hidden: true, title: "Listen for this tab's chat instead" }, "Use this tab");
  const stopBtn = h("button.hf-stop", { type: "button", "aria-label": "Stop hands-free", title: "Stop hands-free" }, "×");
  const pill = h("div.hf-pill", { role: "status", "aria-live": "polite", hidden: true }, h("span.hf-dot", { "aria-hidden": "true" }), pillLabel, goBtn, useBtn, stopBtn);
  deps.host.prepend(pill);
  stopBtn.addEventListener("click", () => stop("button"));
  goBtn.addEventListener("click", () => tab !== null && deps.goToTab(tab));
  useBtn.addEventListener("click", () => moveHere());

  function render(): void {
    pill.hidden = !on();
    if (!on()) {
      deps.voice.showHandsFree(null);
      return;
    }
    // Off while on: the engine is still starting (microphone, connection).
    const phase = state.phase === "off" ? null : state.phase;
    const elsewhere = !here();
    pill.dataset.phase = phase ?? "starting";
    // Where the session is at home (for debugging and tests): its chat and its tabs.
    pill.dataset.chat = chatNow() ?? "";
    pill.dataset.tabs = [...ownTabs].join(",");
    pill.classList.toggle("elsewhere", elsewhere);
    pillLabel.textContent = elsewhere ? elsewhereLabel(tabTitle) : phase ? PILL_TEXT[phase] : STARTING_TEXT;
    pill.title = pillLabel.textContent;
    goBtn.hidden = !elsewhere;
    useBtn.hidden = !elsewhere;
    // The orb veils the session's own tab until something was sent; its caption carries the words.
    const orb = !sent && phase !== "working" && !elsewhere;
    deps.voice.showHandsFree({ orb, phase: phase ?? "opening", caption: phase === "sending" ? "Sending…" : caption || (phase ? ORB_CAPTION : STARTING_TEXT) });
  }

  function dispatch(e: HandsFreeEvent): void {
    const r = handsFree(state, e);
    state = r.state;
    for (const effect of r.effects) run(effect);
    render();
  }

  // --- The lines said aloud: playing in their chat, then kept there.

  /** A new line starts (the one before it is over). */
  function beginLine(text: string): void {
    endLine();
    line = { sessionId: chatNow(), text, keep: !passing.delete(text) };
    showLine();
  }

  /** The Realtime narrator's words so far (they only grow within a reply; a new reply starts a new line). */
  function narratorWords(text: string): void {
    if (!line || !text.startsWith(line.text)) beginLine(text);
    else {
      line.text = text;
      showLine();
    }
  }

  function showLine(): void {
    if (!line) return;
    setCaption(line.text);
    if (line.keep && line.sessionId) deps.onSpeaking({ sessionId: line.sessionId, text: line.text });
  }

  /** The orb's caption; a said line lingers there a little. */
  function setCaption(text: string, linger = false): void {
    if (captionTimer) clearTimeout(captionTimer);
    captionTimer = linger ? setTimeout(() => setCaption(""), CAPTION_LINGER_MS) : null;
    if (!linger) caption = text;
    render();
  }

  /** The line is over (said, cut off, or the session ended): its chat keeps it. */
  function endLine(): void {
    const l = line;
    line = null;
    if (!l) return;
    setCaption(l.text, true);
    if (!l.keep || !l.sessionId) return;
    deps.onSpeaking(null);
    if (l.text.trim()) deps.keepSpoken(l.sessionId, l.text.trim());
  }

  function run(effect: HandsFreeEffect): void {
    switch (effect.type) {
      case "send":
        void sendNow(effect.text);
        break;
      case "speak":
        beginLine(effect.text);
        engine?.speak(effect.text);
        break;
      case "hush":
        engine?.hush();
        endLine();
        break;
      case "transcribe":
        engine?.setTranscribing(effect.on);
        break;
      case "cancelled":
        if (wroteBox) deps.composer.setDraft(boxBase);
        wroteBox = false;
        engine?.cancelled();
        deps.notify({ text: "Cancelled.", level: "info" });
        break;
      case "end":
        finish(endNote(effect.reason));
        break;
    }
  }

  /** What was said goes to the session's chat, whichever tab is shown. */
  async function sendNow(text: string): Promise<void> {
    sent = true;
    follower.sent(now());
    if (wroteBox) deps.composer.setDraft("");
    wroteBox = false;
    boxBase = "";
    try {
      chatId = await deps.send(text, { tabId: tab, sessionId: chatNow() });
    } catch (err) {
      deps.notify({ ...failureTip(err), key: "voice" });
    }
    syncChat();
  }

  /** The user's words so far, in the box (after what was typed there) while the session's tab is shown. */
  function showWords(text: string): void {
    if (!here()) return;
    if (!wroteBox) boxBase = deps.composer.draft();
    wroteBox = true;
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
          else if (!forward && state.phase !== "off" && wroteBox) {
            deps.composer.setDraft(boxBase);
            wroteBox = false;
          }
        })(),
      partial: (text) => alive(() => showWords(text))(),
      level: (l) => deps.voice.setLevel(l),
      narrating: () => alive(() => dispatch({ type: "narrating", now: now() }))(),
      said: () =>
        alive(() => {
          endLine();
          dispatch({ type: "said", now: now() });
        })(),
      narratorText: (t) => alive(() => narratorWords(t))(),
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
      stopTask: () => deps.stopTask(chatNow()),
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
      deps.notify({ key: ENGINE_NOTICE, text: f.message, level: "fallback" });
      await openEngine("standard");
      return;
    }
    finish(null);
    deps.notify(failureTip(err));
  }

  function failureTip(err: unknown): VoiceTip {
    if (err instanceof VoiceError) return errorTip(err, deps.openBilling);
    const message = (err as Partial<RealtimeFailure>)?.message ?? errorMessage(err);
    const help = errorHelp(message);
    const fix = help.fixes.find((x) => x.kind === "topup" || x.kind === "plans" || x.kind === "login");
    const action = fix ? { label: fix.label, run: fix.kind === "login" ? deps.signIn : deps.openBilling } : undefined;
    return { text: help.known ? help.message : message, level: "error", ...(action ? { action } : {}) };
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
      if (id === "realtime" && f.fallback && f.message) {
        deps.notify({ key: ENGINE_NOTICE, text: f.message, level: "fallback" });
        return openEngine("standard");
      }
      finish(null);
      deps.notify(failureTip(err));
      return false;
    }
    if (engine !== e) return false;
    if (state.phase === "off") dispatch({ type: "start", now: now(), halfDuplex: e.halfDuplex });
    else if (e.halfDuplex !== state.halfDuplex) state = { ...state, halfDuplex: e.halfDuplex };
    e.setTranscribing(state.phase !== "speaking");
    if (working) dispatch({ type: "agent", working, now: now() });
    return true;
  }

  /** Binds the session to `next` (its start, or the shortcut pressed there): its chat is followed from now on. */
  function bind(next: number | null): void {
    tab = next;
    tabTitle = null;
    chatId = deps.chatOf(next);
    ownTabs.clear();
    if (next !== null) ownTabs.add(next);
    follower.start();
    narration = new Narration();
    if (next !== null) void deps.tabTitle(next).then((t) => (tab === next ? ((tabTitle = t), render()) : undefined), () => undefined);
  }

  async function start(): Promise<void> {
    if (on()) return;
    starting = true;
    sent = false;
    wroteBox = false;
    bind(deps.activeTab());
    render();
    deps.onActive(true);
    const settings = deps.settings();
    try {
      if (!(await deps.voice.ensureMic())) return void finish(null);
      const engines = settings?.voiceEngine === "standard" ? null : await deps.engines().catch(() => null);
      if (!starting) return; // stopped meanwhile
      const choice = chooseEngine({ preferred: settings?.voiceEngine ?? "realtime", engines, creditCents: deps.account()?.credit?.totalCents });
      if (choice.note) deps.notify({ key: ENGINE_NOTICE, text: choice.note, level: "fallback" });
      else if (choice.engine === "realtime" && settings && !settings.realtimeCostNoticed) costNotice(engines?.engines ?? null);
      if (!(await openEngine(choice.engine))) return;
      syncChat();
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
    const cost = rt ? `Realtime voice uses ${costPerMinuteText(rt.approxCentsPerMinute)}.` : "Realtime voice uses usage credit by the minute.";
    deps.notify({
      key: ENGINE_NOTICE,
      text: `${cost} Standard costs much less.`,
      level: "info",
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
    endLine();
    passing.clear();
    setCaption("");
    if (state.phase !== "off") state = { ...initialHandsFree() };
    if (wroteBox && !sent) deps.composer.setDraft(boxBase);
    wroteBox = false;
    tab = null;
    chatId = null;
    ownTabs.clear();
    deps.voice.setLevel(0);
    render();
    deps.onActive(false);
    if (note) deps.notify({ text: note, level: "info" });
  }

  function stop(reason: EndReason): void {
    if (state.phase === "off") {
      if (starting) finish(null);
      return;
    }
    dispatch({ type: "stop", reason });
  }

  /** Use this tab (on the pill, on another tab): the session goes on there. */
  function moveHere(): void {
    const shown = deps.activeTab();
    if (wroteBox) deps.composer.setDraft(boxBase);
    wroteBox = false;
    bind(shown);
    syncChat();
    render();
    deps.notify({ text: MOVED_NOTE, level: "info" });
  }

  /** The session's chat may have changed (a message started one; its tab shows another): narrate it, and whether it works. */
  function syncChat(): void {
    if (state.phase === "off") return;
    learnTabs();
    for (const e of follower.refresh()) narrate(e);
    const next = running.has(chatNow() ?? "");
    if (next === working) return;
    working = next;
    dispatch({ type: "agent", working: next, now: now() });
  }

  // Esc: cancels the message waiting to be sent, cuts a line off, else ends the session.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || state.phase === "off") return;
    e.preventDefault();
    dispatch({ type: "cancel", now: now() });
  });

  /** Tells the engine (and, Standard, the narration) about an event of the session's chat. */
  function narrate(ev: StampedAgentEvent): void {
    const t = now();
    engine?.agentEvent(ev as AgentEvent, t);
    if (engine?.id !== "standard") return;
    const said = narration.push(ev, t);
    if (!said) return;
    if (ev.type === "tool_call") passing.add(said);
    dispatch({ type: "say", text: said, now: t });
  }

  const control: HandsFree = {
    get active() {
      return on();
    },
    get phase() {
      return state.phase;
    },
    toggle(reason) {
      // Only this panel's own session state decides: on, it ends (wherever it listens); off, one starts here.
      if (voiceKeyAction(on()) === "start") void start();
      else if (starting) finish(null);
      else stop(reason);
    },
    onEvent(ev) {
      if (state.phase !== "off") for (const e of follower.push(ev)) narrate(e);
    },
    setRunning(ids) {
      running = new Set(ids);
      syncChat();
    },
    refresh() {
      syncChat();
      render();
    },
    tabClosed(closed) {
      if (on() && endsWithTab(tab, closed)) finish(TAB_CLOSED_NOTE);
    },
    chat: chatNow,
  };
  deps.voice.attachHandsFree(control);
  return control;
}
