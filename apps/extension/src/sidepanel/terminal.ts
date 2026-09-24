/** Terminal tab: interactive Claude Code through the helper, rendered with xterm.js. */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash } from "./dom.js";

export const INSTALL_COMMAND = String.raw`node <repo>\apps\helper\dist\install.js`;

export interface TerminalView {
  onState(state: UiState): void;
  onData(terminalId: string, data: string): void;
  onExit(terminalId: string, exitCode: number | null): void;
  /** The tab became visible (xterm can only measure a visible element). */
  onShow(): void;
}

export function initTerminal(): TerminalView {
  const box = $("term");
  const bar = box.previousElementSibling as HTMLElement;
  const missing = $("term-missing");
  const status = $("term-status");
  const start = $<HTMLButtonElement>("term-start");
  const stop = $<HTMLButtonElement>("term-stop");
  $("install-cmd").textContent = INSTALL_COMMAND;

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  /** Id of the terminal we are attached to; "starting" while terminal.start is in flight. */
  let current: string | null = null;
  let visible = false;

  const setRunning = (running: boolean) => {
    start.hidden = running;
    stop.hidden = !running;
    status.textContent = running ? "Claude Code · running" : "Claude Code in the browsertodo workspace";
  };

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
    // Everything xterm emits goes to the process, including its answers to
    // the program's capability queries (DA, cursor position, colors).
    t.onData((data) => {
      if (current && current !== "starting") void uiRequest({ type: "terminal.input", data }).catch(() => {});
    });
    t.onResize(({ cols, rows }) => {
      if (current && current !== "starting") void uiRequest({ type: "terminal.resize", cols, rows }).catch(() => {});
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

  start.addEventListener("click", () =>
    void busy(start, async () => {
      const t = ensureTerm();
      fit?.fit();
      t.reset();
      current = "starting";
      setRunning(true);
      try {
        const res = await uiRequest({ type: "terminal.start", cols: t.cols, rows: t.rows });
        current = res.terminalId;
        t.focus();
      } catch (err) {
        current = null;
        setRunning(false);
        t.writeln(`\x1b[31m${errorText(err)}\x1b[0m`);
      }
    }),
  );
  stop.addEventListener("click", () =>
    void busy(stop, async () => {
      try {
        await uiRequest({ type: "terminal.stop" });
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
      const usable = !!helper && helper.ptyAvailable;
      const attached = !!state.terminal;
      missing.hidden = usable || attached;
      box.hidden = !usable && !attached;
      bar.hidden = !usable && !attached;
      $("term-missing-text").textContent = !helper
        ? "The terminal needs the browsertodo helper on this computer. Install it once, then connect:"
        : "The helper is connected, but its terminal support (node-pty) did not load. Reinstall the helper:";
      if (state.terminal && current !== state.terminal.terminalId && current !== "starting") {
        // Reattach to a terminal that kept running while the panel was closed.
        current = state.terminal.terminalId;
        setRunning(true);
        const t = ensureTerm();
        fit?.fit();
        // Repaint what was on screen, then resize so Claude Code redraws cleanly.
        void uiRequest({ type: "terminal.start", cols: t.cols, rows: t.rows })
          .then((res) => {
            if (res.backlog) {
              t.reset();
              t.write(res.backlog);
            }
          })
          .catch(() => {})
          .finally(() => void uiRequest({ type: "terminal.resize", cols: t.cols, rows: t.rows }).catch(() => {}));
      } else if (!state.terminal && current && current !== "starting") {
        current = null;
        setRunning(false);
      }
    },
    onData(terminalId, data) {
      if (current === "starting") current = terminalId;
      if (terminalId !== current) return;
      ensureTerm().write(data);
    },
    onExit(terminalId, exitCode) {
      if (terminalId !== current) return;
      current = null;
      setRunning(false);
      term?.write(`\r\n\x1b[2m[exited${exitCode === null ? "" : ` with code ${exitCode}`}]\x1b[0m\r\n`);
    },
    onShow() {
      visible = true;
      if (box.hidden) return;
      const t = ensureTerm();
      requestAnimationFrame(() => {
        fit?.fit();
        if (current && current !== "starting") void uiRequest({ type: "terminal.resize", cols: t.cols, rows: t.rows }).catch(() => {});
        t.focus();
      });
    },
  };
  return view;
}
