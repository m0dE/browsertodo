/**
 * The hands-free session in the side panel (the voice shortcut and the mic
 * button start and end it): runs the state machine (voice/hands-free.ts) on
 * what the engine hears, carries out its effects (send the message, say a
 * line, stop talking), and shows it: the voice bar at the top of the panel
 * (voice-bar.ts) all along, the orb until something was sent, and the mic
 * button and the box (voice-input.ts). While it is on, the toolbar button of
 * its tab has a badge (the background sets it, from onActive), and a soft
 * sound marks the microphone going live and off (Settings > Voice > Sounds).
 *
 * A session belongs to the browser tab it started in (voice/hands-free-tab.ts):
 * what is said goes to that tab's chat by its id, and that chat's events are
 * narrated, whichever tab the user looks at. The background knows the one
 * session and the tab in front of the user, and tells every panel
 * (setSession). While the user looks at another tab, the bar says where it
 * listens, and what is said carries a note naming both tabs (so is the
 * narrator told): neither the agent nor the narrator sees that tab; "use
 * this tab" (said, or the narrator's use_this_tab) moves the session there.
 * A panel that runs no session shows another tab's (Go to tab, Use voice
 * here, Stop) and nothing live; Use voice here and the mic there end it
 * where it runs, then start it in this panel with the same engine (one
 * microphone). The voice key and the mic end a session this panel runs,
 * wherever it listens; closing its tab ends it.
 *
 * What is said aloud is part of the chat: each line (not the milestones,
 * which repeat the tool rows) is kept in its chat as a "spoken" event, shown
 * playing while it is said. With Realtime, what the user said is kept too,
 * word for word (a "heard" event), with the request the narrator sent for it;
 * the request itself goes out at once and the box is left alone. Standard
 * shows the user's words in the box while they speak, then sends them after
 * a short window in which "cancel" or Esc takes them back.
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
import { errorMessage, traceStart, type AgentEvent, type ApprovalAnswer, type ExtensionSettings, type StampedAgentEvent, type VoiceEngine, type VoiceEngineId, type VoiceEnginesResponse } from "@browsertodo/shared";
import type { PanelTrace } from "../trace/panel-trace.js";
import { chooseEngine, costPerMinuteText } from "../voice/engine-choice.js";
import type { EngineEvents, HandsFreeEngine } from "../voice/engine.js";
import { HANDS_FREE, handsFree, initialHandsFree, type EndReason, type HandsFreeEffect, type HandsFreeEvent, type HandsFreePhase, type HandsFreeState } from "../voice/hands-free.js";
import {
  endsWithTab,
  listensElsewhere,
  lookingElsewhereNote,
  lookingHomeNote,
  MOVED_NOTE,
  remoteSession,
  spokenUseThisTab,
  TAB_CLOSED_NOTE,
  useThisTabAnswer,
  useThisTabLine,
  viewedTab,
  voiceKeyAction,
  type TabPage,
  type UseTabOutcome,
} from "../voice/hands-free-tab.js";
import type { VoiceSessionView } from "../voice-session.js";
import { ChatFollower } from "../voice/chat-follower.js";
import { Narration } from "../voice/narration.js";
import { spokenApprovalAnswer, WaitingApprovals } from "../voice/approval-voice.js";
import type { RealtimeFailure } from "../voice/realtime-client.js";
import { VoiceError } from "../voice/transcribe.js";
import { errorHelp } from "./error-help.js";
import { Earcons, type Earcon } from "../voice/earcons.js";
import { remoteBarView, VoiceActivity, voiceBarView, type VoiceBarView } from "../voice/voice-bar-view.js";
import { initVoiceBar } from "./voice-bar.js";
import { errorTip, type HandsFreeControl, type VoiceInput, type VoiceTip } from "./voice-input.js";

/** Under the orb while the engine starts. */
const STARTING_TEXT = "Hands-free · starting…";

/** Under the orb before anything was sent. */
const ORB_CAPTION = "Hands-free: say what to do · “stop” to end";

/** A said line stays under the orb this long after it. */
const CAPTION_LINGER_MS = 4_000;

/** Words said before the session's chat exists and passed on to no one, kept for the chat a request starts: at most this many utterances. */
export const MAX_EARLY_WORDS = 8;

/** Notices about the engine (a fallback, the cost) go under this key, apart from voice's others. */
const ENGINE_NOTICE = "voice.engine";

/** Why the session stopped, when the user did not stop it themselves. */
function endNote(reason: EndReason): string | null {
  if (reason === "silence") return "Hands-free stopped: it was quiet for a while.";
  return null;
}

/** What goes with a message besides its words (see HandsFreeDeps.send). */
export interface SendExtra {
  cid?: string;
  context?: string;
}

/** A line being said: in which chat (null: none yet), its words so far, and whether the chat keeps it. */
interface Line {
  sessionId: string | null;
  text: string;
  keep: boolean;
}

export interface HandsFreeDeps {
  voice: Pick<VoiceInput, "state" | "attachHandsFree" | "showHandsFree" | "setLevel" | "showTip" | "ensureMic" | "shortcutLabel">;
  /** The input box: the user's words show there while the session's tab is shown. */
  composer: {
    draft(): string;
    setDraft(value: string): void;
  };
  /** Voice's notices above the box (a fallback, the cost, why it stopped). */
  notify(tip: VoiceTip & { key?: string }): void;
  /** The browser tab the panel shows (null: unknown). */
  activeTab(): number | null;
  /** The tab this panel belongs to (null: the panel page opened as a tab, which shows its window's active tab). */
  homeTab: number | null;
  /** The panel is on screen (its tab is in front); refresh() is called when that changes. Default: not known (false). */
  visible?(): boolean;
  /** The chat of a browser tab (null: it has none yet). */
  chatOf(tabId: number | null): string | null;
  /** The tabs a chat lives in now: the tab it belongs to and the tabs its running task works in. */
  tabsOf(sessionId: string): readonly number[];
  /**
   * Sends what was said to chat `sessionId` (null: starts one in `tabId`); resolves with the chat's id.
   * cid: the utterance's correlation id in the conversation's trace. context: what the agent is told with it (the
   * note on the tab the user looks at), never shown as the user's words.
   */
  send(text: string, target: { tabId: number | null; sessionId: string | null }, extra?: SendExtra): Promise<string>;
  /** A tab's title and address, for the bar and the notes on the tab the user looks at (null: no such tab). */
  tabPage(tabId: number): Promise<TabPage | null>;
  /** Shows a tab (Go to tab). */
  goToTab(tabId: number): void;
  /** A line is being said in a chat (null: it is over). */
  onSpeaking(line: { sessionId: string; text: string } | null): void;
  /** Keeps a said line in its chat. */
  keepSpoken(sessionId: string, text: string): void;
  /**
   * Keeps what the user said (Realtime) in its chat, with the request sent for it (null: none). early: said before
   * the chat existed, kept as the request that started it went out.
   */
  keepHeard(sessionId: string, text: string, sent: string | null, early?: true): void;
  settings(): ExtensionSettings | null;
  account(): AccountView | undefined;
  /** The server's voice engines (null: could not be loaded). */
  engines(): Promise<VoiceEnginesResponse | null>;
  saveSettings(patch: Partial<ExtensionSettings>): Promise<void>;
  createEngine(id: VoiceEngineId, events: EngineEvents): HandsFreeEngine;
  /** Stops the running task of a chat; says what happened. */
  stopTask(sessionId: string | null): Promise<string>;
  /** Answers an approval request of a chat by voice; true when it was still waiting. */
  answerApproval(sessionId: string, id: string, answer: ApprovalAnswer): Promise<boolean>;
  openBilling(): void;
  signIn(): void;
  /**
   * The session started, moved to another tab, changed engine, or ended; tabId: the tab it belongs to. The panel
   * tells the background, which tells the other panels, routes the shortcut to it, and sets the badges.
   */
  onActive(active: boolean, tabId: number | null, engine: VoiceEngineId | null): void;
  /** Ends the session another panel runs (the background tells that panel). */
  stopRemote(): void;
  /** The voice bar's element (under the tabs; voice-bar.ts fills it). */
  bar: HTMLElement;
  /** The start and stop sounds (default: WebAudio's). */
  earcons?: { play(kind: Earcon): void };
  /** The conversation's trace: what was heard, the sending window, and how long the message took to go out. */
  trace?: Pick<PanelTrace, "record" | "utterance" | "endUtterance" | "bind" | "target">;
  log?(message: string): void;
  now?(): number;
}

export interface HandsFree extends HandsFreeControl {
  /** An event of any chat (the session's chat's are narrated). */
  onEvent(ev: StampedAgentEvent): void;
  /** The chats with a task running now (the session's chat working keeps it listening). */
  setRunning(sessionIds: readonly string[]): void;
  /** The tab shown, or a tab's chat, changed: the bar and the chat followed are looked at again. */
  refresh(): void;
  /** A browser tab closed (its own ends the session). */
  tabClosed(tabId: number): void;
  /** The session as the background knows it (null: none), with the tab the user looks at. */
  setSession(view: VoiceSessionView | null): void;
  /** The background asks this panel to end its session (Stop or Use voice here in another tab's panel). */
  stopHere(): void;
  /** The chat the session talks to (null: none, or a new chat not started yet). */
  chat(): string | null;
  readonly phase: HandsFreePhase;
  /** The tab the session belongs to (null: none is on). */
  readonly tab: number | null;
}

export function initHandsFree(deps: HandsFreeDeps): HandsFree {
  const now = deps.now ?? (() => Date.now());
  let state: HandsFreeState = initialHandsFree();
  let engine: HandsFreeEngine | null = null;
  let narration = new Narration();
  /** The approval each followed chat waits on: a spoken yes or no answers it. */
  const approvals = new WaitingApprovals();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: ReadonlySet<string> = new Set();
  let working = false;
  /** Something was sent this session (the orb then gives way to the chat). */
  let sent = false;
  /** The tab the session belongs to, and its title and address (for the bar on other tabs, and the notes). */
  let tab: number | null = null;
  let homePage: TabPage | null = null;
  /** The session as the background last said (this panel's, another panel's, or none), and its tab's title. */
  let remote: VoiceSessionView | null = null;
  let remoteTitle: string | null = null;
  /** Use voice here: waiting for the session to end where it runs, to start here with its engine. */
  let takeOver: { engine: VoiceEngineId | null } | null = null;
  /** The narrator was last told the user looks at another tab. */
  let lookingAway = false;
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
  /** When the session started (the bar's time on). */
  let startedAt = 0;
  /** The start sound was made: the stop sound goes with it. */
  let chimed = false;
  /** A voice on the microphone now ("Hearing you…"). */
  const activity = new VoiceActivity();
  /** What the bar last showed of it. */
  let hearing = false;
  const earcons = deps.earcons ?? new Earcons(undefined, deps.log);
  const sound = (kind: Earcon) => {
    if (deps.settings()?.voiceSounds !== false) earcons.play(kind);
  };
  /** The last message going out (it may be starting a new chat): the user's words for it wait for it. */
  let sending: Promise<void> = Promise.resolve();
  /** The message starting the session's chat, until its id is known: messages said meanwhile go to that chat after it. */
  let startingChat: Promise<void> | null = null;
  /** The user's words (Realtime) said while the session had no chat and passed on to no one: kept once a chat starts. */
  let earlyWords: string[] = [];
  const chatNow = () => chatId ?? deps.chatOf(tab);
  const follower = new ChatFollower(chatNow);
  const trace = deps.trace;
  // Voice events without an utterance (lines said, the narrator's updates) belong to the chat the session talks to.
  if (trace) trace.target = () => (on() ? chatNow() : null);
  /** When the words to send were heard (the sending window starts). */
  let heardAt: number | null = null;
  const heard = (text: string) => {
    heardAt = Date.now();
    trace?.record({ t: heardAt, cat: "voice", name: "voice.heard", cid: trace.utterance(), data: { chars: text.length } });
  };
  const on = () => state.phase !== "off" || starting;
  /** Adds the tabs the session's chat works in now to its own. */
  const learnTabs = () => {
    const chat = chatNow();
    if (chat) for (const t of deps.tabsOf(chat)) ownTabs.add(t);
  };
  /** The tab the user looks at (null: not known). */
  const viewing = () => viewedTab(deps.homeTab, remote, deps.activeTab(), deps.visible?.() ?? false);
  const here = () => {
    learnTabs();
    return !listensElsewhere(ownTabs, viewing());
  };
  /** Another tab's session, as this panel shows it (Go to tab, Use voice here, Stop). */
  const shownRemote = () => (!on() && remoteSession(remote, deps.homeTab) === "notice" ? remote : null);

  // The bar's buttons act on this panel's session, else on the one another panel runs.
  const bar = initVoiceBar(deps.bar, {
    stop: () => (on() ? stop("button") : deps.stopRemote()),
    interrupt: () => state.phase === "speaking" && dispatch({ type: "cancel", now: now() }),
    goToTab: () => {
      const t = on() ? tab : (remote?.tabId ?? null);
      if (t !== null) deps.goToTab(t);
    },
    useThisTab: () => (on() ? moveHere() : useVoiceHere()),
  });

  function render(): void {
    if (!on()) {
      const r = shownRemote();
      bar.show(r ? remoteBarView({ title: remoteTitle, engine: r.engine }) : null);
      delete deps.bar.dataset.phase;
      deps.voice.showHandsFree(null);
      return;
    }
    // Off while on: the engine is still starting (microphone, connection).
    const phase = state.phase === "off" ? null : state.phase;
    const elsewhere = !here();
    const t = now();
    hearing = activity.hearing(t);
    const view: VoiceBarView = voiceBarView({
      phase: phase ?? "starting",
      hearing,
      engine: engine?.id ?? null,
      elapsedMs: t - startedAt,
      elsewhere: elsewhere ? { title: homePage?.title ?? null } : null,
      shortcut: deps.voice.shortcutLabel,
    });
    bar.show(view);
    // The phase, and where the session is at home (for debugging and tests): its chat and its tabs.
    deps.bar.dataset.phase = phase ?? "starting";
    deps.bar.dataset.chat = chatNow() ?? "";
    deps.bar.dataset.tabs = [...ownTabs].join(",");
    // The orb veils the session's own tab until something was sent; its caption carries the words.
    const orb = !sent && phase !== "working" && !elsewhere;
    deps.voice.showHandsFree({
      orb,
      phase: phase ?? "opening",
      caption: phase === "sending" ? "Sending…" : caption || (phase ? ORB_CAPTION : STARTING_TEXT),
      status: elsewhere ? "on in another tab" : view.title,
      elsewhere,
    });
  }

  /** The microphone's level: the meter, and "Hearing you…" while a voice is on it. */
  function onLevel(level: number): void {
    deps.voice.setLevel(level);
    const t = now();
    activity.push(level, t);
    if (activity.hearing(t) !== hearing) render();
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
        sending = send(effect.text);
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
        heardAt = null;
        trace?.record({ t: Date.now(), cat: "voice", name: "voice.cancelled", cid: trace.utterance() });
        trace?.endUtterance();
        deps.notify({ text: "Cancelled.", level: "info" });
        break;
      case "end":
        finish(endNote(effect.reason));
        break;
    }
  }

  /**
   * Sends a message at once, unless the session's chat is still being started by an earlier one: then right after
   * it, into that chat (sent now, it would start a second chat).
   */
  function send(text: string): Promise<void> {
    const cid = trace?.utterance();
    if (startingChat) return startingChat.then(() => sendNow(text, cid));
    const startsChat = chatNow() === null;
    const out = sendNow(text, cid);
    if (startsChat) {
      startingChat = out;
      void out.finally(() => {
        if (startingChat === out) startingChat = null;
      });
    }
    return out;
  }

  /** What was said goes to the session's chat, whichever tab is shown. cid: its utterance in the trace. */
  async function sendNow(text: string, cid: string | undefined): Promise<void> {
    sent = true;
    follower.sent(now());
    if (wroteBox) deps.composer.setDraft("");
    wroteBox = false;
    boxBase = "";
    // The sending window (cancellable) was waiting too.
    if (trace && heardAt !== null) {
      const waited = Date.now() - heardAt;
      trace.record({ t: heardAt, ms: waited, cat: "voice", name: "voice.send_window", cid: cid!, data: { waitMs: waited } });
    }
    heardAt = null;
    const delivery = traceStart();
    try {
      // Said while the user looks at another tab: the agent learns it cannot see that tab (the chat shows the words alone).
      const note = here() ? null : await lookingNote();
      const target = { tabId: tab, sessionId: chatNow() };
      const extra: SendExtra = { ...(cid === undefined ? {} : { cid }), ...(note ? { context: note } : {}) };
      chatId = await (Object.keys(extra).length ? deps.send(text, target, extra) : deps.send(text, target));
      // What was said before this chat existed goes in it now, before the words of this request.
      for (const words of earlyWords.splice(0)) deps.keepHeard(chatId, words, null, true);
      if (trace && cid) {
        const ms = delivery.elapsed();
        trace.record({ t: delivery.t, ms, cat: "voice", name: "voice.deliver", cid, data: { chars: text.length, waitMs: ms } });
        trace.bind(cid, chatId);
      }
    } catch (err) {
      deps.notify({ ...failureTip(err), key: "voice" });
    }
    trace?.endUtterance(cid);
    syncChat();
  }

  /**
   * What the user said (Realtime), kept in the chat its request went to, or else the session's chat (after a chat
   * being started). No chat yet and nothing passed on: kept for the chat a request will start (MAX_EARLY_WORDS).
   */
  async function keepWords(words: string, sent: string | null): Promise<void> {
    if (sent) await sending;
    else if (startingChat) await startingChat;
    if (state.phase === "off") return;
    const chat = chatNow();
    if (chat) deps.keepHeard(chat, words, sent);
    else if (!sent) earlyWords = [...earlyWords, words].slice(-MAX_EARLY_WORDS);
  }

  /** The user's words so far (Standard), in the box (after what was typed there) while the session's tab is shown. */
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
          // A yes or no while the chat waits for an approval answers it, and is not sent as a message.
          if (forward && answerByVoice(text)) forward = false;
          // "Use this tab" (Standard) moves the session to the tab the user looks at, and says so.
          if (forward && spokenUseThisTab(text)) {
            forward = false;
            void useViewedTab().then((outcome) => state.phase !== "off" && dispatch({ type: "say", text: useThisTabLine(outcome), now: now() }));
          }
          if (forward && text.trim()) heard(text);
          dispatch({ type: "heard", text, forward, now: now() });
          // Not going out (a stop word, nothing said): the utterance is over.
          if (state.phase !== "sending") trace?.endUtterance();
          if (state.phase === "sending") showWords("");
          else if (!forward && state.phase !== "off" && wroteBox) {
            deps.composer.setDraft(boxBase);
            wroteBox = false;
          }
        })(),
      partial: (text) => alive(() => showWords(text))(),
      level: (l) => onLevel(l),
      narrating: () => alive(() => dispatch({ type: "narrating", now: now() }))(),
      said: () =>
        alive(() => {
          endLine();
          dispatch({ type: "said", now: now() });
        })(),
      narratorText: (t) => alive(() => narratorWords(t))(),
      forward: (text) =>
        alive(() => {
          // Realtime sends at once (no sending window).
          trace?.record({ t: Date.now(), cat: "voice", name: "voice.forward", cid: trace.utterance(), data: { chars: text.length } });
          dispatch({ type: "forward", text, now: now() });
        })(),
      userWords: (words, sent) => alive(() => void keepWords(words, sent))(),
      stopTask: () => deps.stopTask(chatNow()),
      answerApproval: async (allow) => {
        const chat = chatNow();
        const id = approvals.of(chat);
        if (!chat || !id) return "Nothing is waiting for the user's OK.";
        const ok = await deps.answerApproval(chat, id, allow ? "allow_once" : "deny");
        return ok ? (allow ? "Allowed: the agent goes on." : "Denied: the agent will not do it.") : "That request is no longer waiting.";
      },
      endVoice: () => stop("narrator"),
      useThisTab: async () => useThisTabAnswer(await useViewedTab()),
      failed: (err) => void onEngineFailure(err),
    };
  }

  /** Why an engine stopped: Realtime trouble that Standard can cover switches over; anything else ends the session. */
  async function onEngineFailure(err: unknown): Promise<void> {
    traceFailure(engine?.id ?? null, err);
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

  /** An engine could not start or go on: an error in the trace of the chat the session talks to. */
  function traceFailure(id: VoiceEngineId | null, err: unknown): void {
    const message = (err as Partial<RealtimeFailure>)?.message ?? errorMessage(err);
    trace?.record({ t: Date.now(), cat: "error", name: "voice.failed", data: { engine: id, error: message.slice(0, 160) } });
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
      traceFailure(id, err);
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
    report();
    // The narrator starts out knowing whether the user looks at another tab.
    lookingAway = false;
    lookChanged();
    if (state.phase === "off") dispatch({ type: "start", now: now(), halfDuplex: e.halfDuplex });
    else if (e.halfDuplex !== state.halfDuplex) state = { ...state, halfDuplex: e.halfDuplex };
    e.setTranscribing(state.phase !== "speaking");
    if (working) dispatch({ type: "agent", working, now: now() });
    return true;
  }

  /** Binds the session to `next` (its start, or the shortcut pressed there): its chat is followed from now on. */
  function bind(next: number | null): void {
    tab = next;
    homePage = null;
    chatId = deps.chatOf(next);
    // Words kept for a chat to come were said to the tab the session leaves.
    earlyWords = [];
    ownTabs.clear();
    if (next !== null) ownTabs.add(next);
    follower.start();
    narration = new Narration();
    if (next !== null) void deps.tabPage(next).then((p) => (tab === next ? ((homePage = p), render()) : undefined), () => undefined);
  }

  /** Tells the background where the session is (or that it ended), and on which engine. */
  function report(): void {
    deps.onActive(on(), on() ? tab : null, on() ? (engine?.id ?? null) : null);
  }

  /** `preferred`: the engine to use (a session moved here keeps its engine); else the one in Settings. */
  async function start(preferred: VoiceEngineId | null = null): Promise<void> {
    if (on()) return;
    starting = true;
    sent = false;
    wroteBox = false;
    startedAt = now();
    bind(deps.activeTab());
    render();
    report();
    const settings = deps.settings();
    const wanted = preferred ?? settings?.voiceEngine ?? "realtime";
    try {
      if (!(await deps.voice.ensureMic())) return void finish(null);
      const engines = wanted === "standard" ? null : await deps.engines().catch(() => null);
      if (!starting) return; // stopped meanwhile
      const choice = chooseEngine({ preferred: wanted, engines, creditCents: deps.account()?.credit?.totalCents });
      if (choice.note) deps.notify({ key: ENGINE_NOTICE, text: choice.note, level: "fallback" });
      else if (choice.engine === "realtime" && settings && !settings.realtimeCostNoticed) costNotice(engines?.engines ?? null);
      // Replaced while it started (Standard took over, or the cost notice switched to it), the session goes on with
      // the new engine and needs the clock just the same; stopped meanwhile, there is none.
      if (!(await openEngine(choice.engine)) && !engine) return;
      // The microphone is live.
      chimed = true;
      sound("start");
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
    earlyWords = [];
    ownTabs.clear();
    lookingAway = false;
    // The background's view was of this session: it is over (its "none" follows).
    remote = null;
    deps.voice.setLevel(0);
    activity.reset();
    if (chimed) sound("stop");
    chimed = false;
    render();
    report();
    if (note) deps.notify({ text: note, level: "info" });
  }

  function stop(reason: EndReason): void {
    if (state.phase === "off") {
      if (starting) finish(null);
      return;
    }
    dispatch({ type: "stop", reason });
  }

  /** Use voice here (on the bar, on another tab): the session goes on in the tab the user looks at. */
  function moveHere(): void {
    moveTo(viewing());
    deps.notify({ text: MOVED_NOTE, level: "info" });
  }

  /** The session goes on for `target` (its chat, its badge), in this panel. */
  function moveTo(target: number | null): void {
    if (wroteBox) deps.composer.setDraft(boxBase);
    wroteBox = false;
    bind(target);
    report();
    syncChat();
    // Moved to where the user looks: the narrator learns it from the move's answer, not from a note.
    lookingAway = !here();
    render();
  }

  /** "Use this tab" said (or the narrator's use_this_tab): the session moves to the tab the user looks at, if it can. */
  async function useViewedTab(): Promise<UseTabOutcome> {
    const target = viewing();
    if (target === null) return "unknown";
    if (here()) return "here";
    const page = await deps.tabPage(target).catch(() => null);
    if (!page || !on()) return "gone";
    moveTo(target);
    return { moved: page };
  }

  /**
   * Use voice here (or the mic) in a panel that shows another tab's session: it ends where it runs, then starts in
   * this panel with the same engine once the background says it ended (setSession): one microphone at a time.
   */
  function useVoiceHere(): void {
    if (on() || takeOver || !remote) return;
    takeOver = { engine: remote.engine };
    deps.stopRemote();
  }

  /** The note on the tab the user looks at (null: the session's own), with both tabs' titles as they are now. */
  async function lookingNote(): Promise<string | null> {
    const looking = viewing();
    if (looking === null || here()) return null;
    const home = tab;
    const [page, homeNow] = await Promise.all([deps.tabPage(looking).catch(() => null), home === null ? null : deps.tabPage(home).catch(() => null)]);
    if (homeNow && tab === home) homePage = homeNow;
    return lookingElsewhereNote(page, homePage);
  }

  /** The user turned to another tab, or back: the narrator is told (it cannot see the other tab). */
  function lookChanged(): void {
    if (!on() || !engine) return;
    const away = !here();
    if (away === lookingAway) return;
    lookingAway = away;
    const e = engine;
    void lookingNote().then((note) => {
      if (engine === e && lookingAway === away) e.note(note ?? lookingHomeNote(homePage));
    });
  }

  /** The other tab's title, for the notice (it may have changed since). */
  function learnRemoteTitle(view: VoiceSessionView): void {
    void deps.tabPage(view.tabId).then(
      (p) => {
        if (remote?.tabId !== view.tabId) return;
        remoteTitle = p?.title ?? null;
        render();
      },
      () => undefined,
    );
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

  /** Standard: a spoken yes or no answers the approval the chat waits on. True when it did. */
  function answerByVoice(text: string): boolean {
    const chat = chatNow();
    const id = approvals.of(chat);
    const answer = id ? spokenApprovalAnswer(text) : null;
    if (!chat || !id || !answer) return false;
    void deps.answerApproval(chat, id, answer);
    return true;
  }

  /** Tells the engine (and, Standard, the narration) about an event of the session's chat. */
  function narrate(ev: StampedAgentEvent): void {
    const t = now();
    approvals.push(ev);
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
    get tab() {
      return on() ? tab : null;
    },
    toggle(reason) {
      // This panel's own session ends (wherever it listens); another tab's moves here; else one starts here.
      if (!on() && remoteSession(remote, deps.homeTab) !== "none") return useVoiceHere();
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
      lookChanged();
      render();
    },
    tabClosed(closed) {
      if (on() && endsWithTab(tab, closed)) finish(TAB_CLOSED_NOTE);
    },
    setSession(view) {
      const before = remote;
      remote = view;
      if (on()) {
        lookChanged();
        return render();
      }
      if (!view) {
        // The session ended where it ran: Use voice here starts it in this panel now.
        const moving = takeOver;
        takeOver = null;
        if (moving) void start(moving.engine);
        return render();
      }
      const kind = remoteSession(view, deps.homeTab);
      // Moved to this panel's tab by voice: this panel takes it over.
      if (kind === "adopt") useVoiceHere();
      if (kind === "notice") {
        if (view.tabId !== before?.tabId) remoteTitle = null;
        learnRemoteTitle(view);
      }
      render();
    },
    stopHere() {
      if (on()) stop("button");
    },
    chat: chatNow,
  };
  deps.voice.attachHandsFree(control);
  return control;
}
