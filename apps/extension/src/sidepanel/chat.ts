/**
 * Chat tab: the conversation of the browser tab that is active in the
 * panel's window, live (every turn of it in one thread: the user's messages
 * as bubbles, starting with the prompt or task that opened it, the agent's
 * text, tool calls, results and Jev decisions), its
 * action bar (New chat | Show tab) and, while conversations of
 * other tabs run, one chip each to switch to their tab. Which conversation
 * that is comes from sidepanel.ts (see tab-chat.ts); past runs live in the
 * Activity log tab (history.ts).
 */
import { errorMessage, type SessionInfo, type StampedAgentEvent } from "@browsertodo/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { chatActions, type BarAction } from "./chat-actions.js";
import { $, busy, h } from "../ui/dom.js";
import { errorHelp } from "./error-help.js";
import { renderErrorHelp } from "./error-view.js";
import { describeEvent, isBrainStartLine, isNearBottom, openingTurn, turnError, turnPicks } from "./event-format.js";
import { placeEvent, pruneContinue, renderEvent, renderOpening, renderSessionHead, renderText } from "./event-render.js";
import { LiveTexts } from "./live-text.js";
import { MarkdownView } from "./markdown.js";
import { renderSwitcher } from "./session-switcher.js";
import { otherRunning } from "./tab-chat.js";

export interface ChatView {
  /** The running sessions from UiState, oldest first (several tasks can run at once). */
  setRunning(sessions: readonly SessionInfo[]): void;
  onEvent(ev: StampedAgentEvent): void;
  onSession(session: SessionInfo): void;
  /** Show this conversation (the current tab's); null: an empty new chat. */
  show(sessionId: string | null): void;
  /** The conversation shown, or null. */
  shown(): SessionInfo | null;
  /** The keyboard shortcuts (open the chat; talk), as the user reads them (null: none is set), for the new chat. */
  setShortcuts(shortcuts: Shortcuts): void;
}

export interface ChatOptions {
  /** The Continue button in a task_end card. */
  onContinue?(sessionId: string): void;
  /** The conversation the tab shows changed (null: an empty, new chat). */
  onFocus?(session: SessionInfo | null): void;
  /** New chat left this conversation. */
  onLeave?(session: SessionInfo): void;
  /** A chip of another tab's running conversation was picked: switch to that tab. */
  onSwitch?(session: SessionInfo): void;
  /** The conversation's first message was picked: show its task's details. */
  onDetails?(session: SessionInfo, trigger: HTMLElement): void;
  /** The new chat's link to set a shortcut (chrome://extensions/shortcuts), when none is set. */
  onShortcuts?(): void;
}

/** The panel's keyboard shortcuts as the user reads them ("Ctrl+.", "Ctrl+,"); null: Chrome assigned none. */
export interface Shortcuts {
  open: string | null;
  voice: string | null;
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);
/** Recent events of conversations not on screen, kept for when one is shown: at most this many. */
const MAX_BUFFERED_EVENTS = 300;

/** A text button in the action bar; aria-disabled (not disabled) so its tooltip still shows. */
export function setBarAction(btn: HTMLButtonElement, a: BarAction): void {
  btn.setAttribute("aria-disabled", String(a.disabled));
  btn.title = a.title;
}
const usable = (btn: HTMLButtonElement) => btn.getAttribute("aria-disabled") !== "true" && !btn.disabled;

export function initChat(opts: ChatOptions = {}): ChatView {
  const log = $("chat-log");
  const head = $("chat-head");
  const switcher = $("chat-switch");
  const newBtn = $<HTMLButtonElement>("chat-new");
  const showBtn = $<HTMLButtonElement>("chat-show");

  /** The id of the conversation shown (set at once), and its info once known. */
  let shownId: string | null = null;
  let current: SessionInfo | null = null;
  let events: StampedAgentEvent[] = [];
  let backfilling = false;
  /** Recent events of every session, for a conversation shown after they arrived. */
  let buffered: StampedAgentEvent[] = [];
  /** The panel's keyboard shortcuts: undefined until known. */
  let shortcuts: Shortcuts | undefined;
  /** Every running session, for the switcher. */
  let runningList: readonly SessionInfo[] = [];
  /** onFocus starts after init: the first view (nothing shown) needs no notice, and callers may not be wired yet. */
  let ready = false;

  function updateBar(): void {
    const a = chatActions(current, new Set(runningList.map((s) => s.sessionId)));
    setBarAction(newBtn, a.newChat);
    setBarAction(showBtn, a.showTab);
  }

  /** Text Claude is still writing, and its elements while its conversation is shown. */
  const live = new LiveTexts();
  const liveEls = new Map<string, { el: HTMLElement; view: MarkdownView }>();
  let paintQueued = false;

  function renderOne(e: StampedAgentEvent, i: number): void {
    // The brain chip under the first message already says which brain started.
    if (e.type === "status" && isBrainStartLine(e.text)) return;
    const s = e.type === "task_end" && current?.sessionId === e.sessionId ? current : null;
    const canContinue = !!opts.onContinue && e.type === "task_end" && isContinuableOutcome(e.outcome) && s?.source !== "cloud";
    const turn = e.type === "task_end" ? { picks: turnPicks(events, i), error: turnError(events, i) } : {};
    const view = describeEvent(e, turn);
    placeEvent(log, renderEvent(view, canContinue ? () => opts.onContinue?.(e.sessionId) : undefined), view);
  }

  /** Repaints the shown conversation's live texts, once per frame; a new one starts at the end of the log. */
  function paintLive(): void {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (!current || backfilling) return;
      const follow = isNearBottom(log);
      for (const [id, text] of live.of(current.sessionId)) {
        if (!text.trim()) continue;
        let e = liveEls.get(id);
        if (!e?.el.isConnected) {
          const el = h("div.ev-text.md.streaming", { "data-stream": id });
          e = { el, view: new MarkdownView(el) };
          liveEls.set(id, e);
          log.querySelector(":scope > p.empty")?.remove();
          log.append(el);
        }
        e.view.update(text, true);
      }
      if (follow) log.scrollTop = log.scrollHeight;
    });
  }

  /**
   * Updates live texts for an event of any conversation. A final
   * assistant_text takes the place of its live text (same spot, final
   * rendering); live texts of earlier messages that never got theirs are
   * removed; at task_end what is still live stays as written. True when the
   * event's own text replaced a live one (so it needs no element of its own).
   */
  function settleLive(ev: StampedAgentEvent): boolean {
    const r = live.settle(ev);
    for (const id of r.drop) liveEls.get(id)?.el.remove();
    for (const id of r.freeze) liveEls.get(id)?.el.classList.remove("streaming");
    for (const id of [...r.drop, ...r.freeze]) liveEls.delete(id);
    if (!r.replaces) return false;
    const e = liveEls.get(r.replaces);
    liveEls.delete(r.replaces);
    if (!e?.el.isConnected || ev.type !== "assistant_text") return false;
    e.el.replaceWith(renderText(ev.text.trim(), r.replaces));
    return true;
  }

  function renderLog(): void {
    if (!shownId) {
      log.replaceChildren(
        h(
          "div.empty-state.chat-empty",
          null,
          h("p.empty-title", null, "New chat"),
          shortcutHint(),
        ),
      );
      return;
    }
    if (!current) {
      log.replaceChildren(h("p.empty", null, "Loading…"));
      return;
    }
    log.replaceChildren(renderOpeningOf(current), renderSessionHead(current));
    events.forEach(renderOne);
    liveEls.clear();
    if (!events.length && !live.of(current.sessionId).some(([, t]) => t.trim())) log.append(h("p.empty", null, "Waiting for the agent…"));
    pruneContinue(log);
    paintLive();
    log.scrollTop = log.scrollHeight;
  }

  /**
   * "Ctrl+. to open · Ctrl+, to talk"; with only the open key, "Press Ctrl+. to open this chat at any time.";
   * without it, a link to set one.
   */
  function shortcutHint(): HTMLElement | null {
    if (!shortcuts) return null;
    const { open, voice } = shortcuts;
    const talk = voice ? [" · ", h("kbd", null, voice), " to talk"] : [];
    if (!open) {
      const link = h("button.link.shortcut-link", { type: "button", onclick: () => opts.onShortcuts?.() }, "Set a keyboard shortcut");
      return h("p.shortcut-hint", null, link, " to open this chat at any time", ...(voice ? talk : ["."]));
    }
    if (!voice) return h("p.shortcut-hint", null, "Press ", h("kbd", null, open), " to open this chat at any time.");
    return h("p.shortcut-hint", null, h("kbd", null, open), " to open", ...talk);
  }

  function refreshHead(s: SessionInfo): void {
    log.querySelector(":scope > .ev-head")?.replaceWith(renderSessionHead(s));
  }

  /** The conversation's first message (its prompt), which opens its details. */
  function renderOpeningOf(s: SessionInfo): HTMLElement {
    const v = openingTurn(s, events);
    // The details of the session as it is now (it ends, gets an outcome, ...).
    const el = renderOpening(v, (trigger) => opts.onDetails?.(current ?? s, trigger));
    el.dataset.files = String(v.files ?? 0);
    return el;
  }

  /** The first turn's files are known once its "Preparing N file(s)" line arrives. */
  function refreshOpening(): void {
    const el = log.querySelector<HTMLElement>(":scope > .ev-opening");
    if (current && el && el.dataset.files !== String(openingTurn(current, events).files ?? 0)) el.replaceWith(renderOpeningOf(current));
  }

  /** Other tabs' running conversations: one chip each, to switch to that tab. */
  function updateSwitcher(): void {
    const others = otherRunning(runningList, shownId);
    switcher.hidden = !others.length;
    if (others.length) renderSwitcher(switcher, others, (s) => opts.onSwitch?.(s));
    head.hidden = !others.length;
  }

  function render(): void {
    renderLog();
    updateSwitcher();
    updateBar();
    log.classList.toggle("busy", !!current && runningList.some((s) => s.sessionId === current!.sessionId));
    if (ready) opts.onFocus?.(current);
  }

  async function load(sessionId: string): Promise<void> {
    const known = runningList.find((s) => s.sessionId === sessionId) ?? null;
    current = known;
    events = buffered.filter((e) => e.sessionId === sessionId);
    backfilling = true;
    render();
    try {
      const res = await uiRequest({ type: "sessions.events", sessionId });
      if (shownId !== sessionId) return;
      current = runningList.find((s) => s.sessionId === sessionId) ?? res.session ?? current;
      const seen = new Set(res.events.map(eventKey));
      events = [...res.events, ...events.filter((e) => !seen.has(eventKey(e)))];
    } catch (err) {
      // Live pushes still arrive; the backfill is best effort.
      if (shownId === sessionId && !current) {
        backfilling = false;
        const help = errorHelp(errorMessage(err));
        log.replaceChildren(renderErrorHelp({ ...help, message: "This chat couldn't be loaded.", details: errorMessage(err) }));
        return;
      }
    } finally {
      if (shownId === sessionId) backfilling = false;
    }
    if (shownId === sessionId) render();
  }

  function append(ev: StampedAgentEvent): void {
    events.push(ev);
    if (backfilling || !current) {
      settleLive(ev);
      return;
    }
    const follow = isNearBottom(log);
    log.querySelector(":scope > p.empty")?.remove();
    // The final text of a streamed block takes the place of its live text.
    if (!settleLive(ev)) renderOne(ev, events.length - 1);
    if (ev.type === "status") refreshOpening();
    pruneContinue(log);
    if (follow) log.scrollTop = log.scrollHeight;
  }

  function appendError(text: string): void {
    if (current) append({ type: "error", text, ts: new Date().toISOString(), sessionId: current.sessionId });
  }

  // A log read at its bottom stays there when it gets shorter (the header grows, the panel is resized).
  // Scrolling up lets go of the bottom, reaching it again holds it. (Not "is it near the bottom now": a
  // scroll event can come after the log already got shorter, and that must not let go.)
  let pinned = true;
  let lastTop = 0;
  log.addEventListener(
    "scroll",
    () => {
      if (log.scrollTop < lastTop - 1) pinned = false;
      if (isNearBottom(log)) pinned = true;
      lastTop = log.scrollTop;
    },
    { passive: true },
  );
  // (Also when its content grows after rendering, e.g. once fonts load: every top-level entry is watched.)
  const stick = new ResizeObserver(() => {
    if (pinned) log.scrollTop = log.scrollHeight;
  });
  stick.observe(log);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) stick.observe(n);
  }).observe(log, { childList: true });

  newBtn.addEventListener("click", () => {
    const s = current;
    if (!usable(newBtn) || !s) return;
    opts.onLeave?.(s);
  });
  showBtn.addEventListener("click", () => {
    const s = current;
    if (!usable(showBtn) || !s) return;
    void busy(showBtn, () => uiRequest({ type: "agent.show", sessionId: s.sessionId }), appendError);
  });

  render();
  ready = true;

  return {
    setRunning(sessions) {
      runningList = sessions;
      const watching = current ? sessions.find((s) => s.sessionId === current!.sessionId) : undefined;
      // Continue buttons wait until the shown conversation's turn ends.
      log.classList.toggle("busy", !!watching);
      if (watching) {
        current = watching;
        refreshHead(current);
      }
      updateSwitcher();
      updateBar();
    },
    onEvent(ev) {
      if (ev.type === "assistant_text_delta") {
        live.add(ev);
        if (shownId && ev.sessionId === shownId) paintLive();
        return;
      }
      if (shownId && ev.sessionId === shownId) append(ev);
      else {
        settleLive(ev);
        buffered = [...buffered.slice(-MAX_BUFFERED_EVENTS), ev];
      }
    },
    onSession(s) {
      if (s.sessionId !== shownId) return;
      current = s;
      refreshHead(current);
      if (s.endedAt) log.scrollTop = log.scrollHeight;
      updateBar();
      opts.onFocus?.(current);
    },
    show(sessionId) {
      if (sessionId === shownId) return;
      // Events of the conversation that was shown stay available if it comes back.
      if (shownId) buffered = [...buffered, ...events].slice(-MAX_BUFFERED_EVENTS);
      shownId = sessionId;
      if (!sessionId) {
        current = null;
        events = [];
        backfilling = false;
        render();
        return;
      }
      void load(sessionId);
    },
    shown() {
      return current;
    },
    setShortcuts(next) {
      if (shortcuts?.open === next.open && shortcuts.voice === next.voice) return;
      shortcuts = next;
      if (!shownId) renderLog();
    },
  };
}
