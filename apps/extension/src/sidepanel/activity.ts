/**
 * Activity tab: the conversation with the agent, live (every turn of it in
 * one thread: the user's messages as bubbles, the agent's text, tool calls,
 * results and Jev decisions), the history, and read-only past conversations.
 * This module decides what the tab shows; the pieces render themselves
 * (event-render, history, session-switcher, raw-log).
 */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { $, busy, errorText, h } from "./dom.js";
import { describeEvent, isNearBottom } from "./event-format.js";
import { renderEvent, renderSessionHead } from "./event-render.js";
import { brainLabel, sessionMeta } from "./format.js";
import { loadHistory } from "./history.js";
import { openRawLog } from "./raw-log.js";
import { renderSwitcher } from "./session-switcher.js";

type Mode = { kind: "live" } | { kind: "history" } | { kind: "past"; session: SessionInfo };

export interface ActivityView {
  /** The running sessions from UiState, oldest first (several tasks can run at once). */
  setRunning(sessions: readonly SessionInfo[]): void;
  onEvent(ev: StampedAgentEvent): void;
  onSession(session: SessionInfo): void;
  /** Show a session live (e.g. the one a message just went to); none: the one followed now. */
  followLive(sessionId?: string): void;
  /** The line under the header about the conversation's agent session (null hides it). */
  setNote(text: string | null): void;
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);
/** A conversation that ended less than this ago is shown when the panel opens (its agent session may still be open). */
const RECENT_MS = 30 * 60_000;

export interface ActivityOptions {
  /** The Continue button in a task_end card. */
  onContinue?(sessionId: string): void;
  /** The session the tab is showing changed (null: the list or nothing). */
  onFocus?(session: SessionInfo | null): void;
}

export function initActivity(opts: ActivityOptions = {}): ActivityView {
  const log = $("act-log");
  const list = $("act-list");
  const title = $("act-title");
  const meta = $("act-meta");
  const note = $("act-conv");
  const rawLog = $<HTMLButtonElement>("act-rawlog");
  const back = $<HTMLButtonElement>("act-back");
  const historyBtn = $<HTMLButtonElement>("act-history");
  const showBtn = $<HTMLButtonElement>("act-show");
  const switcher = $("act-switch");

  let mode: Mode = { kind: "live" };
  /** The session the live view follows: the running one, or the last one that just ended. */
  let live: SessionInfo | null = null;
  let liveEvents: StampedAgentEvent[] = [];
  let backfilling = false;
  let buffered: StampedAgentEvent[] = [];
  let noteText: string | null = null;
  /** Every running session, for the switcher. */
  let runningList: readonly SessionInfo[] = [];
  /** onFocus starts after init: the first view (nothing focused) needs no notice, and callers may not be wired yet. */
  let ready = false;

  function header(s: SessionInfo | null): void {
    if (!s) {
      title.textContent = "Nothing running";
      meta.textContent = "Recent runs";
      rawLog.hidden = true;
      return;
    }
    title.textContent = s.title;
    title.title = s.title;
    meta.textContent = sessionMeta(s);
    meta.title = brainLabel(s.brain, s.jev);
    // The helper's own record of every Claude Code stream event (Activity shows the gist).
    rawLog.hidden = !(s.brain === "claude-code" && s.logPath);
  }

  /** The SessionInfo the view has for an event's session. */
  function sessionOf(sessionId: string): SessionInfo | null {
    if (mode.kind === "past" && mode.session.sessionId === sessionId) return mode.session;
    return live?.sessionId === sessionId ? live : null;
  }

  function renderOne(e: StampedAgentEvent): HTMLElement {
    const s = e.type === "task_end" ? sessionOf(e.sessionId) : null;
    const canContinue = !!opts.onContinue && e.type === "task_end" && isContinuableOutcome(e.outcome) && s?.source !== "cloud";
    return renderEvent(describeEvent(e), canContinue ? () => opts.onContinue?.(e.sessionId) : undefined);
  }

  /** Continue belongs to the conversation's last turn only. */
  function pruneContinue(): void {
    const cards = [...log.querySelectorAll(".ev-actions")];
    for (const c of cards.slice(0, -1)) c.remove();
    if (log.lastElementChild && !log.lastElementChild.classList.contains("ev-end")) cards.at(-1)?.remove();
  }

  function focused(): SessionInfo | null {
    if (mode.kind === "past") return mode.session;
    return mode.kind === "live" ? live : null;
  }

  function renderLog(s: SessionInfo | null, events: StampedAgentEvent[], emptyText: string): void {
    log.replaceChildren(...(s ? [renderSessionHead(s)] : []), ...events.map(renderOne));
    if (!events.length) log.append(h("p.empty", null, emptyText));
    pruneContinue();
    log.scrollTop = log.scrollHeight;
  }

  function refreshHead(s: SessionInfo): void {
    log.querySelector(":scope > .ev-head")?.replaceWith(renderSessionHead(s));
  }

  /** With several sessions running: one chip each, to pick which one to watch. */
  function updateSwitcher(): void {
    const show = runningList.length > 1 && mode.kind !== "history";
    switcher.hidden = !show;
    if (show) renderSwitcher(switcher, runningList, focused()?.sessionId, watch);
  }

  /** Watch this running session live. */
  function watch(s: SessionInfo): void {
    mode = { kind: "live" };
    if (live?.sessionId === s.sessionId) show();
    else void adopt(s);
  }

  function renderNote(): void {
    const s = focused();
    note.hidden = !noteText || !s;
    note.textContent = noteText ?? "";
  }

  function show(): void {
    const idle = mode.kind === "live" && !live;
    const listMode = mode.kind === "history" || idle;
    log.hidden = listMode;
    list.hidden = !listMode;
    back.hidden = mode.kind === "live" || (mode.kind === "history" && !live);
    historyBtn.hidden = listMode || mode.kind === "past";
    // Only meaningful while there is an agent session to look at.
    showBtn.hidden = !live || mode.kind !== "live";
    if (mode.kind === "past") {
      header(mode.session);
    } else if (mode.kind === "history") {
      header(null);
      title.textContent = "History";
      meta.textContent = "";
    } else {
      header(live);
    }
    if (listMode) void loadHistory((s) => void openPast(s));
    else if (mode.kind === "live") renderLog(live, liveEvents, "Waiting for the agent…");
    renderNote();
    updateSwitcher();
    if (ready) opts.onFocus?.(focused());
  }

  async function openPast(s: SessionInfo): Promise<void> {
    if (live && s.sessionId === live.sessionId) {
      mode = { kind: "live" };
      return show();
    }
    mode = { kind: "past", session: s };
    show();
    log.replaceChildren(h("p.empty", null, "Loading…"));
    try {
      const res = await uiRequest({ type: "sessions.events", sessionId: s.sessionId });
      if (mode.kind === "past" && mode.session.sessionId === s.sessionId) {
        mode = { kind: "past", session: res.session };
        header(res.session);
        renderLog(res.session, res.events, "No events were recorded for this run.");
        opts.onFocus?.(res.session);
      }
    } catch (err) {
      log.replaceChildren(h("p.ev-error", null, errorText(err)));
    }
  }

  async function adopt(s: SessionInfo): Promise<void> {
    live = s;
    liveEvents = buffered.filter((e) => e.sessionId === s.sessionId);
    buffered = [];
    backfilling = true;
    // A past conversation that got a new message is now the live one.
    if (mode.kind === "past" && mode.session.sessionId === s.sessionId) mode = { kind: "live" };
    if (mode.kind === "live") show();
    try {
      const res = await uiRequest({ type: "sessions.events", sessionId: s.sessionId });
      if (live?.sessionId !== s.sessionId) return;
      const seen = new Set(res.events.map(eventKey));
      liveEvents = [...res.events, ...liveEvents.filter((e) => !seen.has(eventKey(e)))];
    } catch {
      // Live pushes still arrive; the backfill is best effort.
    } finally {
      backfilling = false;
    }
    if (mode.kind === "live" && live?.sessionId === s.sessionId) show();
  }

  function append(ev: StampedAgentEvent): void {
    liveEvents.push(ev);
    if (mode.kind !== "live" || backfilling) return;
    const follow = isNearBottom(log);
    log.querySelector(":scope > p.empty")?.remove();
    log.append(renderOne(ev));
    pruneContinue();
    if (follow) log.scrollTop = log.scrollHeight;
  }

  showBtn.addEventListener("click", () =>
    void busy(showBtn, async () => {
      try {
        await uiRequest({ type: "agent.show", ...(live ? { sessionId: live.sessionId } : {}) });
      } catch (err) {
        append({ type: "error", text: errorText(err), ts: new Date().toISOString(), sessionId: live?.sessionId ?? "" });
      }
    }),
  );
  rawLog.addEventListener("click", () =>
    void busy(rawLog, async () => {
      const s = focused();
      if (!s) return;
      try {
        await openRawLog(s.sessionId);
      } catch (err) {
        append({ type: "error", text: `Raw log: ${errorText(err)}`, ts: new Date().toISOString(), sessionId: s.sessionId });
      }
    }),
  );
  historyBtn.addEventListener("click", () => {
    mode = { kind: "history" };
    show();
  });
  back.addEventListener("click", () => {
    mode = mode.kind === "past" ? { kind: "history" } : { kind: "live" };
    if (mode.kind === "history" && live) mode = { kind: "live" };
    show();
  });
  show();
  ready = true;

  // After the panel (re)opens with nothing running, a conversation that ended
  // recently is still the one to talk to: show it.
  void uiRequest({ type: "sessions.list", limit: 1 })
    .then(({ sessions: [last] }) => {
      if (!live && last?.endedAt && Date.now() - Date.parse(last.endedAt) < RECENT_MS && last.source !== "cloud") void adopt(last);
    })
    .catch(() => {});

  return {
    setRunning(sessions) {
      const before = new Set(runningList.map((s) => s.sessionId));
      runningList = sessions;
      const watching = live ? sessions.find((s) => s.sessionId === live!.sessionId) : undefined;
      // Continue buttons wait until the watched conversation's turn ends.
      log.classList.toggle("busy", !!watching);
      if (watching) {
        live = watching;
        if (mode.kind === "live") {
          header(live);
          refreshHead(live);
        }
      } else {
        // Not watching a running session: follow the newest one that just started.
        const started = [...sessions].reverse().find((s) => !before.has(s.sessionId)) ?? (live ? undefined : sessions.at(-1));
        if (started) void adopt(started);
      }
      updateSwitcher();
    },
    onEvent(ev) {
      if (live && ev.sessionId === live.sessionId) append(ev);
      else buffered = [...buffered.slice(-200), ev];
    },
    onSession(s) {
      if (live?.sessionId === s.sessionId) {
        live = s;
        if (mode.kind === "live") {
          header(live);
          refreshHead(live);
          if (s.endedAt) log.scrollTop = log.scrollHeight;
          opts.onFocus?.(live);
        }
      } else if (!s.endedAt && (!live || live.endedAt)) {
        // A session started while the watched one is not running: follow it.
        void adopt(s);
      }
    },
    followLive(sessionId) {
      mode = { kind: "live" };
      if (!sessionId || live?.sessionId === sessionId) return show();
      const known = runningList.find((s) => s.sessionId === sessionId);
      if (known) return void adopt(known);
      void uiRequest({ type: "sessions.events", sessionId })
        .then(({ session }) => adopt(session))
        .catch(() => show());
    },
    setNote(text) {
      noteText = text;
      renderNote();
    },
  };
}
