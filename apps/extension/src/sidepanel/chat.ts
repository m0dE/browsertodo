/**
 * Chat tab: the conversation of the browser tab that is active in the
 * panel's window, live (every turn of it in one thread: the user's messages
 * as bubbles, the agent's text, tool calls, results and Jev decisions), its
 * action bar (New Chat | Show Tab | Raw Log) and, while conversations of
 * other tabs run, one chip each to switch to their tab. Which conversation
 * that is comes from sidepanel.ts (see tab-chat.ts); past runs live in the
 * Activity Log tab (history.ts).
 */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { chatActions, type BarAction } from "./chat-actions.js";
import { $, busy, errorText, h } from "./dom.js";
import { describeEvent, isNearBottom, turnPicks } from "./event-format.js";
import { pruneContinue, renderEvent, renderSessionHead } from "./event-render.js";
import { brainLabel, sessionMeta } from "./format.js";
import { openRawLog } from "./raw-log.js";
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
  /** The line under the header about the conversation's agent session (null hides it). */
  setNote(text: string | null): void;
}

export interface ChatOptions {
  /** The Continue button in a task_end card. */
  onContinue?(sessionId: string): void;
  /** The conversation the tab shows changed (null: an empty, new chat). */
  onFocus?(session: SessionInfo | null): void;
  /** New Chat left this conversation. */
  onLeave?(session: SessionInfo): void;
  /** A chip of another tab's running conversation was picked: switch to that tab. */
  onSwitch?(session: SessionInfo): void;
  /** The conversation's title was picked: show its task's details. */
  onDetails?(session: SessionInfo, trigger: HTMLElement): void;
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);

/** A text button in the action bar; aria-disabled (not disabled) so its tooltip still shows. */
export function setBarAction(btn: HTMLButtonElement, a: BarAction): void {
  btn.setAttribute("aria-disabled", String(a.disabled));
  btn.title = a.title;
}
const usable = (btn: HTMLButtonElement) => btn.getAttribute("aria-disabled") !== "true" && !btn.disabled;

export function initChat(opts: ChatOptions = {}): ChatView {
  const log = $("chat-log");
  const head = $("chat-head");
  const titles = $("chat-titles");
  const title = $<HTMLButtonElement>("chat-title");
  const meta = $("chat-meta");
  const note = $("chat-conv");
  const switcher = $("chat-switch");
  const newBtn = $<HTMLButtonElement>("chat-new");
  const showBtn = $<HTMLButtonElement>("chat-show");
  const rawLog = $<HTMLButtonElement>("chat-rawlog");

  /** The id of the conversation shown (set at once), and its info once known. */
  let shownId: string | null = null;
  let current: SessionInfo | null = null;
  let events: StampedAgentEvent[] = [];
  let backfilling = false;
  /** Recent events of every session, for a conversation shown after they arrived. */
  let buffered: StampedAgentEvent[] = [];
  let noteText: string | null = null;
  /** Every running session, for the switcher. */
  let runningList: readonly SessionInfo[] = [];
  /** onFocus starts after init: the first view (nothing shown) needs no notice, and callers may not be wired yet. */
  let ready = false;

  function header(s: SessionInfo | null): void {
    titles.hidden = !s;
    if (!s) return;
    title.textContent = s.title;
    title.title = `${s.title}
Show the full ${s.source === "adhoc" ? "message" : "task"} and its details`;
    meta.textContent = sessionMeta(s);
    meta.title = brainLabel(s.brain, s.jev);
  }

  function updateBar(): void {
    const a = chatActions(current, new Set(runningList.map((s) => s.sessionId)));
    setBarAction(newBtn, a.newChat);
    setBarAction(showBtn, a.showTab);
    setBarAction(rawLog, a.rawLog);
  }

  function renderOne(e: StampedAgentEvent, i: number): HTMLElement {
    const s = e.type === "task_end" && current?.sessionId === e.sessionId ? current : null;
    const canContinue = !!opts.onContinue && e.type === "task_end" && isContinuableOutcome(e.outcome) && s?.source !== "cloud";
    const picks = e.type === "task_end" ? turnPicks(events, i) : undefined;
    return renderEvent(describeEvent(e, picks), canContinue ? () => opts.onContinue?.(e.sessionId) : undefined);
  }

  function renderLog(): void {
    if (!shownId) {
      log.replaceChildren(
        h(
          "div.empty-state.chat-empty",
          null,
          h("p.empty-title", null, "New chat"),
          h("p", null, "Type below to have the agent do something in this tab. Each tab has its own chat; earlier runs are in the Activity Log."),
        ),
      );
      return;
    }
    if (!current) {
      log.replaceChildren(h("p.empty", null, "Loading…"));
      return;
    }
    log.replaceChildren(renderSessionHead(current), ...events.map(renderOne));
    if (!events.length) log.append(h("p.empty", null, "Waiting for the agent…"));
    pruneContinue(log);
    log.scrollTop = log.scrollHeight;
  }

  function refreshHead(s: SessionInfo): void {
    log.querySelector(":scope > .ev-head")?.replaceWith(renderSessionHead(s));
  }

  /** Other tabs' running conversations: one chip each, to switch to that tab. */
  function updateSwitcher(): void {
    const others = otherRunning(runningList, shownId);
    switcher.hidden = !others.length;
    if (others.length) renderSwitcher(switcher, others, undefined, (s) => opts.onSwitch?.(s));
    head.hidden = !current && !others.length;
  }

  function renderNote(): void {
    note.hidden = !noteText || !current;
    note.textContent = noteText ?? "";
  }

  function render(): void {
    header(current);
    renderLog();
    renderNote();
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
        log.replaceChildren(h("p.ev-error", null, `This chat could not be loaded: ${errorText(err)}`));
        return;
      }
    } finally {
      if (shownId === sessionId) backfilling = false;
    }
    if (shownId === sessionId) render();
  }

  function append(ev: StampedAgentEvent): void {
    events.push(ev);
    if (backfilling || !current) return;
    const follow = isNearBottom(log);
    log.querySelector(":scope > p.empty")?.remove();
    log.append(renderOne(ev, events.length - 1));
    pruneContinue(log);
    if (follow) log.scrollTop = log.scrollHeight;
  }

  function appendError(text: string): void {
    if (current) append({ type: "error", text, ts: new Date().toISOString(), sessionId: current.sessionId });
  }

  title.addEventListener("click", () => {
    if (current) opts.onDetails?.(current, title);
  });
  newBtn.addEventListener("click", () => {
    const s = current;
    if (!usable(newBtn) || !s) return;
    opts.onLeave?.(s);
  });
  showBtn.addEventListener("click", () => {
    const s = current;
    if (!usable(showBtn) || !s) return;
    void busy(showBtn, async () => {
      try {
        await uiRequest({ type: "agent.show", sessionId: s.sessionId });
      } catch (err) {
        appendError(errorText(err));
      }
    });
  });
  rawLog.addEventListener("click", () => {
    const s = current;
    if (!usable(rawLog) || !s) return;
    void busy(rawLog, async () => {
      try {
        await openRawLog(s.sessionId);
      } catch (err) {
        appendError(`Raw log: ${errorText(err)}`);
      }
    });
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
        header(current);
        refreshHead(current);
      }
      updateSwitcher();
      updateBar();
    },
    onEvent(ev) {
      if (shownId && ev.sessionId === shownId) append(ev);
      else buffered = [...buffered.slice(-300), ev];
    },
    onSession(s) {
      if (s.sessionId !== shownId) return;
      current = s;
      header(current);
      refreshHead(current);
      if (s.endedAt) log.scrollTop = log.scrollHeight;
      updateBar();
      opts.onFocus?.(current);
    },
    show(sessionId) {
      if (sessionId === shownId) return;
      // Events of the conversation that was shown stay available if it comes back.
      if (shownId) buffered = [...buffered, ...events].slice(-300);
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
    setNote(text) {
      noteText = text;
      renderNote();
    },
  };
}
