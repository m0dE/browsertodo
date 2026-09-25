/** Activity tab: live agent session, history, read-only past sessions. */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { isContinuableOutcome } from "../continue.js";
import { uiRequest } from "../ui-protocol.js";
import { $, busy, errorText, h } from "./dom.js";
import { describeEvent, isNearBottom, type EventView } from "./event-format.js";
import { brainLabel, clockLabel, outcomeChip, relativeTime } from "./format.js";

type Mode = { kind: "live" } | { kind: "history" } | { kind: "past"; session: SessionInfo };

export interface ActivityView {
  /** The running session from UiState (null when idle). */
  setRunning(session: SessionInfo | null): void;
  onEvent(ev: StampedAgentEvent): void;
  onSession(session: SessionInfo): void;
  /** Show the live session (e.g. the run just continued). */
  followLive(): void;
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);

/** onContinue: the run ended without finishing and can be continued (task_end cards). */
export function renderEvent(v: EventView, onContinue?: () => void): HTMLElement {
  switch (v.kind) {
    case "status":
      return h("div.ev-status", null, v.text);
    case "text":
      return h("p.ev-text", null, v.text);
    case "tool":
      // Every tool call is Claude's decision; Jev's own decisions show as Jev lines below it.
      return h("div.ev-tool", { title: `Claude chose: ${v.name} ${v.args}` }, h("span.who", null, "Claude"), h("b", null, v.name), v.args ? ` ${v.args}` : "");
    case "result": {
      const cls = v.isError ? "err" : "";
      // Long results collapse behind their preview; short ones are just the line.
      const wrap = h(
        "div",
        null,
        v.full && v.full !== v.preview
          ? h("details.ev-result", { class: cls }, h("summary", null, v.preview), h("pre", null, v.full))
          : h("div.ev-result.plain", { class: cls }, h("div.line", null, v.preview)),
      );
      if (v.thumbnail) {
        const img = h("img.thumb", { src: `data:image/jpeg;base64,${v.thumbnail}`, alt: "screenshot", loading: "lazy" });
        img.addEventListener("click", () => img.classList.toggle("big"));
        wrap.append(img);
      }
      return wrap;
    }
    case "jev":
      return h(
        "div.ev-jev",
        { title: v.title },
        h("span.chip", { "data-tone": v.executed ? "accent" : "muted" }, v.label),
        h("span.ms", null, `${v.ms} ms`),
      );
    case "user":
      return h("div.ev-user", null, v.text);
    case "end":
      return h(
        "div.ev-end",
        null,
        h("div", null, h("span.chip", { "data-tone": v.chip.tone }, v.chip.label), v.text ? ` ${v.text}` : ""),
        v.url ? h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.url) : null,
        onContinue
          ? h(
              "div.ev-actions",
              null,
              h("button.primary.small.ev-continue", { type: "button", title: "Pick up where it stopped (uses the note in the box below, if any)", onclick: () => onContinue() }, "Continue"),
            )
          : null,
      );
    case "error":
      return h("div.ev-error", null, v.text);
  }
}

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
  const back = $<HTMLButtonElement>("act-back");
  const historyBtn = $<HTMLButtonElement>("act-history");
  const showBtn = $<HTMLButtonElement>("act-show");

  let mode: Mode = { kind: "live" };
  /** The session the live view follows: the running one, or the last one that just ended. */
  let live: SessionInfo | null = null;
  let liveEvents: StampedAgentEvent[] = [];
  let backfilling = false;
  let buffered: StampedAgentEvent[] = [];
  /** onFocus starts after init: the first view (nothing focused) needs no notice, and callers may not be wired yet. */
  let ready = false;

  function header(s: SessionInfo | null, readOnly: boolean): void {
    if (!s) {
      title.textContent = "Nothing running";
      meta.textContent = "Recent runs";
      return;
    }
    title.textContent = s.title;
    title.title = s.title;
    const parts = [brainLabel(s.brain, s.jev), s.endedAt ? clockLabel(s.startedAt) : `started ${relativeTime(s.startedAt)}`];
    if (s.endedAt) parts.push(outcomeChip(s.outcome).label);
    meta.textContent = parts.join(" · ");
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

  function focused(): SessionInfo | null {
    if (mode.kind === "past") return mode.session;
    return mode.kind === "live" ? live : null;
  }

  function renderLog(events: StampedAgentEvent[], emptyText: string): void {
    log.replaceChildren(...events.map(renderOne));
    if (!events.length) log.append(h("p.empty", null, emptyText));
    log.scrollTop = log.scrollHeight;
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
      header(mode.session, true);
    } else if (mode.kind === "history") {
      header(null, true);
      title.textContent = "History";
      meta.textContent = "";
    } else {
      header(live, false);
    }
    if (listMode) void loadHistory();
    else if (mode.kind === "live") renderLog(liveEvents, "Waiting for the agent…");
    if (ready) opts.onFocus?.(focused());
  }

  async function loadHistory(): Promise<void> {
    try {
      const { sessions } = await uiRequest({ type: "sessions.list", limit: 30 });
      const ul = $("history-list");
      ul.replaceChildren(
        ...sessions.map((s) => {
          const chip = outcomeChip(s.endedAt ? s.outcome : undefined);
          return h(
            "li",
            null,
            h(
              "button",
              { type: "button", onclick: () => void openPast(s) },
              h("span.chip", { "data-tone": chip.tone }, chip.label),
              h(
                "span.s-main",
                null,
                h("div.s-title", null, s.title),
                h("div.meta", null, `${clockLabel(s.startedAt)} · ${brainLabel(s.brain, s.jev)}${s.source === "adhoc" ? " · one-off" : ""}`),
              ),
            ),
          );
        }),
      );
      $("history-empty").hidden = sessions.length > 0;
    } catch (err) {
      $("history-list").replaceChildren(h("li.ev-error", null, errorText(err)));
    }
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
        header(res.session, true);
        renderLog(res.events, "No events were recorded for this run.");
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
    if (follow) log.scrollTop = log.scrollHeight;
  }

  showBtn.addEventListener("click", () =>
    void busy(showBtn, async () => {
      try {
        await uiRequest({ type: "agent.show" });
      } catch (err) {
        append({ type: "error", text: errorText(err), ts: new Date().toISOString(), sessionId: live?.sessionId ?? "" });
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

  return {
    setRunning(session) {
      // Continue buttons wait until nothing runs.
      log.classList.toggle("busy", !!session);
      if (session && session.sessionId !== live?.sessionId) void adopt(session);
      else if (session && live) {
        live = session;
        if (mode.kind === "live") header(live, false);
      }
    },
    onEvent(ev) {
      if (live && ev.sessionId === live.sessionId) append(ev);
      else buffered = [...buffered.slice(-200), ev];
    },
    onSession(s) {
      if (live?.sessionId === s.sessionId) {
        live = s;
        if (mode.kind === "live") header(live, false);
        if (s.endedAt && mode.kind === "live") log.scrollTop = log.scrollHeight;
        if (mode.kind === "live") opts.onFocus?.(live);
      } else if (!s.endedAt) {
        void adopt(s);
      }
    },
    followLive() {
      mode = { kind: "live" };
      show();
    },
  };
}
