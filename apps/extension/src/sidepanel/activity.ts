/** Activity tab: live agent session, history, read-only past sessions. */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
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
}

const eventKey = (e: StampedAgentEvent) => JSON.stringify(e);

export function renderEvent(v: EventView): HTMLElement {
  switch (v.kind) {
    case "status":
      return h("div.ev-status", null, v.text);
    case "text":
      return h("p.ev-text", null, v.text);
    case "tool":
      return h("div.ev-tool", { title: `${v.name} ${v.args}` }, "› ", h("b", null, v.name), v.args ? ` ${v.args}` : "");
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
      );
    case "error":
      return h("div.ev-error", null, v.text);
  }
}

export function initActivity(): ActivityView {
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

  function renderLog(events: StampedAgentEvent[], emptyText: string): void {
    log.replaceChildren(...events.map((e) => renderEvent(describeEvent(e))));
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
    log.append(renderEvent(describeEvent(ev)));
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

  return {
    setRunning(session) {
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
      } else if (!s.endedAt) {
        void adopt(s);
      }
    },
  };
}
