/**
 * Terminal tab: Claude Code sessions in the helper, rendered with xterm.js.
 * Two kinds share one xterm: the user's own session (Start / Stop), and the
 * Claude Code session of each task, which the helper opens by itself so the
 * whole run is visible (it stays open, idle, for follow-up messages). A
 * switcher row appears while task sessions are open; the running one is live.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalInfo } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash, h } from "./dom.js";

export const INSTALL_COMMAND = String.raw`node <repo>\apps\helper\dist\install.js`;

/** Output kept per session so switching repaints at once. */
const MAX_BUFFER = 512 * 1024;
/** Keys typed into the user's session this recently mean "busy there": a new task session does not take over. */
export const TYPING_GRACE_MS = 15_000;

export interface TerminalView {
  onState(state: UiState): void;
  onOpened(terminal: TerminalInfo): void;
  onData(terminalId: string, data: string): void;
  onExit(terminalId: string, exitCode: number | null): void;
  /** The tab became visible (xterm can only measure a visible element). */
  onShow(): void;
  onHide(): void;
  /** Selects the task session of this agent session. False when it has none. */
  watch(sessionId: string): boolean;
  /** The task terminal of this agent session, if it is open. */
  taskTerminalOf(sessionId: string): TerminalInfo | null;
}

interface Session {
  info: TerminalInfo;
  buffer: string;
  /** While the backlog is being fetched, streamed data is already in it. */
  loading: boolean;
}

export function initTerminal(): TerminalView {
  const box = $("term");
  const bar = $("term-bar");
  const switcher = $("term-sessions");
  const missing = $("term-missing");
  const status = $("term-status");
  const start = $<HTMLButtonElement>("term-start");
  const stop = $<HTMLButtonElement>("term-stop");
  const tabDot = $("term-live-dot");
  $("install-cmd").textContent = INSTALL_COMMAND;

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  const sessions = new Map<string, Session>();
  /** The user's session id; "starting" while terminal.start is in flight. */
  let userId: string | null = null;
  /** "user", or the id of a task session. */
  let selected = "user";
  let visible = false;
  let usable = false;
  let lastUserKey = 0;
  let note = "";
  /** The agent session whose turn is running (its task terminal is live; others are idle, kept open for follow-ups). */
  let runningSession: string | null = null;

  const tasks = () => [...sessions.values()].filter((s) => s.info.kind === "task");
  const selectedId = (): string | null => (selected === "user" ? (userId && userId !== "starting" ? userId : null) : selected);

  function ensureTerm(): Terminal {
    if (term) return term;
    const t = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#16161c",
        foreground: "#e6e6ea",
        cursor: "#8b8cf6",
        selectionBackground: "#3b3b6b",
      },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(box);
    // Everything xterm emits goes to the selected process, including its
    // answers to capability queries (the helper drops duplicates for task sessions).
    t.onData((data) => {
      const id = selectedId();
      if (!id) return;
      if (selected === "user") lastUserKey = Date.now();
      void uiRequest({ type: "terminal.input", data, terminalId: id }).catch(() => {});
    });
    t.onResize(({ cols, rows }) => {
      const id = selectedId();
      if (id) void uiRequest({ type: "terminal.resize", cols, rows, terminalId: id }).catch(() => {});
    });
    let pending = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (visible && box.clientWidth > 0) f.fit();
      });
    }).observe(box);
    term = t;
    fit = f;
    return t;
  }

  /** Repaints the selected session and tells its program the panel's size (so the TUI redraws). */
  function repaint(): void {
    const t = ensureTerm();
    t.reset();
    const id = selectedId();
    const s = id ? sessions.get(id) : undefined;
    if (s?.buffer) t.write(s.buffer);
    if (!visible) return;
    fit?.fit();
    if (id) void uiRequest({ type: "terminal.resize", cols: t.cols, rows: t.rows, terminalId: id }).catch(() => {});
  }

  function render(): void {
    const open = tasks();
    const isLive = (s: Session) => !!runningSession && s.info.sessionId === runningSession;
    tabDot.hidden = !open.some(isLive);
    switcher.hidden = open.length === 0;
    const chips = open.map((s) =>
      h(
        "button.term-chip",
        {
          type: "button",
          "data-id": s.info.terminalId,
          "aria-pressed": String(selected === s.info.terminalId),
          title: isLive(s) ? `Running: ${s.info.title}` : `Idle, waiting for a follow-up: ${s.info.title}`,
          onclick: () => select(s.info.terminalId),
        },
        isLive(s) ? h("span.live-dot", { "aria-hidden": "true" }) : h("span.idle-dot", { "aria-hidden": "true" }),
        h("span.term-chip-text", null, `Task: ${s.info.title}`),
      ),
    );
    chips.push(
      h(
        "button.term-chip.user",
        { type: "button", "data-id": "user", "aria-pressed": String(selected === "user"), onclick: () => select("user") },
        h("span.term-chip-text", null, "Your session"),
      ),
    );
    switcher.replaceChildren(...chips);

    const isTask = selected !== "user";
    const userRunning = !!userId;
    start.hidden = isTask || userRunning;
    stop.hidden = isTask || !userRunning;
    status.textContent = note
      ? note
      : isTask
        ? sessions.get(selected)?.info.sessionId === runningSession
          ? "Claude Code is running this task · you can type here"
          : "Task session · idle, waiting for a follow-up"
        : userRunning
          ? "Claude Code · running"
          : "Claude Code in the browsertodo workspace";
    missing.hidden = usable || sessions.size > 0 || !!userId;
    box.hidden = !missing.hidden;
    bar.hidden = box.hidden;
  }

  function select(id: string): void {
    if (id !== "user" && !sessions.has(id)) id = "user";
    note = "";
    if (selected === id) return render();
    selected = id;
    render();
    repaint();
    if (visible) term?.focus();
  }

  function append(s: Session, data: string): void {
    const next = s.buffer + data;
    s.buffer = next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
  }

  /** A terminal the panel has not seen yet: from a push (loaded) or from state after reopening (fetch its backlog). */
  function add(info: TerminalInfo, fromState: boolean): void {
    if (sessions.has(info.terminalId)) return;
    const s: Session = { info, buffer: "", loading: fromState };
    sessions.set(info.terminalId, s);
    if (info.kind === "user") userId = info.terminalId;
    if (fromState) {
      void uiRequest({ type: "terminal.backlog", terminalId: info.terminalId })
        .then((r) => {
          // Everything streamed while this was in flight is in the backlog too.
          s.buffer = r.data.length > MAX_BUFFER ? r.data.slice(r.data.length - MAX_BUFFER) : r.data;
        })
        .catch(() => {})
        .finally(() => {
          s.loading = false;
          if (selectedId() === info.terminalId) repaint();
        });
    }
    if (info.kind === "task") {
      // Follow the task unless the user is busy typing in their own session.
      const typing = selected === "user" && !!userId && Date.now() - lastUserKey < TYPING_GRACE_MS;
      if (!typing) {
        selected = info.terminalId;
        note = "";
        render();
        repaint();
        return;
      }
    }
    render();
  }

  function remove(id: string, exitCode: number | null): void {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    if (s.info.kind === "user" && userId === id) userId = null;
    if (selected === id) {
      // A finished task disappears; its transcript stays in Activity.
      selected = "user";
      note = s.info.kind === "task" ? "The task's session ended · its steps are in Activity" : "";
      render();
      repaint();
      if (s.info.kind !== "task") term?.write(`\r\n\x1b[2m[exited${exitCode === null ? "" : ` with code ${exitCode}`}]\x1b[0m\r\n`);
      return;
    }
    render();
  }

  start.addEventListener("click", () =>
    void busy(start, async () => {
      const t = ensureTerm();
      selected = "user";
      note = "";
      fit?.fit();
      t.reset();
      userId = "starting";
      render();
      try {
        const res = await uiRequest({ type: "terminal.start", cols: t.cols, rows: t.rows });
        if (userId === "starting") userId = res.terminalId;
        if (!sessions.has(res.terminalId)) sessions.set(res.terminalId, { info: { terminalId: res.terminalId, kind: "user", title: "Claude Code" }, buffer: "", loading: false });
        render();
        t.focus();
      } catch (err) {
        userId = null;
        render();
        t.writeln(`\x1b[31m${errorText(err)}\x1b[0m`);
      }
    }),
  );
  stop.addEventListener("click", () =>
    void busy(stop, async () => {
      try {
        await uiRequest({ type: "terminal.stop", ...(userId && userId !== "starting" ? { terminalId: userId } : {}) });
      } catch (err) {
        term?.writeln(`\r\n\x1b[31m${errorText(err)}\x1b[0m`);
      }
    }),
  );
  $("copy-cmd").addEventListener("click", () => {
    void navigator.clipboard.writeText(INSTALL_COMMAND).then(
      () => flash($("term-msg"), "Copied.", "ok"),
      () => flash($("term-msg"), "Copy failed; select the command instead.", "bad"),
    );
  });
  const connect = $<HTMLButtonElement>("term-connect");
  connect.addEventListener("click", () =>
    void busy(connect, async () => {
      flash($("term-msg"), "Connecting…");
      try {
        const state = await uiRequest({ type: "helper.connect" });
        flash($("term-msg"), state.brain.helper ? "Connected." : state.brain.helperError || "Helper not found.", state.brain.helper ? "ok" : "bad");
        view.onState(state);
      } catch (err) {
        flash($("term-msg"), errorText(err), "bad");
      }
    }),
  );

  const view: TerminalView = {
    onState(state) {
      const helper = state.brain.helper;
      runningSession = state.running?.sessionId ?? null;
      usable = !!helper && helper.ptyAvailable;
      $("term-missing-text").textContent = !helper
        ? "The terminal needs the browsertodo helper on this computer. Install it once, then connect:"
        : "The helper is connected, but its terminal support (node-pty) did not load. Reinstall the helper:";
      const listed = state.terminals ?? (state.terminal ? [{ ...state.terminal, kind: "user" as const, title: "Claude Code" }] : []);
      const ids = new Set(listed.map((t) => t.terminalId));
      // Gone while we were not looking (the exit push can be missed while the panel is closed).
      for (const id of [...sessions.keys()]) if (!ids.has(id)) remove(id, null);
      if (userId && userId !== "starting" && !ids.has(userId)) userId = null;
      // Reattach to terminals that kept running while the panel was closed.
      for (const t of listed) add(t, true);
      render();
    },
    onOpened(t) {
      if (t.kind === "user" && userId === "starting") userId = t.terminalId;
      add(t, false);
    },
    onData(terminalId, data) {
      if (userId === "starting" && !sessions.has(terminalId)) {
        userId = terminalId;
        sessions.set(terminalId, { info: { terminalId, kind: "user", title: "Claude Code" }, buffer: "", loading: false });
      }
      const s = sessions.get(terminalId);
      if (!s || s.loading) return;
      append(s, data);
      if (selectedId() === terminalId) ensureTerm().write(data);
    },
    onExit(terminalId, exitCode) {
      remove(terminalId, exitCode);
    },
    onShow() {
      visible = true;
      render();
      if (box.hidden) return;
      const t = ensureTerm();
      requestAnimationFrame(() => {
        fit?.fit();
        const id = selectedId();
        if (id) void uiRequest({ type: "terminal.resize", cols: t.cols, rows: t.rows, terminalId: id }).catch(() => {});
        t.focus();
      });
    },
    onHide() {
      visible = false;
    },
    watch(sessionId) {
      const s = tasks().find((x) => x.info.sessionId === sessionId);
      if (!s) return false;
      select(s.info.terminalId);
      return true;
    },
    taskTerminalOf(sessionId) {
      return tasks().find((x) => x.info.sessionId === sessionId)?.info ?? null;
    },
  };
  render();
  return view;
}
