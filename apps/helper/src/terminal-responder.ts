/**
 * Terminal emulator stand-ins for task terminals, which may run while no side
 * panel (xterm.js) is attached:
 * - TerminalResponder answers the capability queries Claude Code's TUI sends
 *   at startup (device attributes, XTVERSION, kitty keyboard flags, status
 *   and cursor reports, OSC 10/11 colors), so it never waits on a terminal.
 * - stripQueryReplies drops xterm.js's own answers from panel input, so the
 *   program does not get every answer twice.
 * - ScreenText turns raw output into plain text for spotting prompts.
 */

const ESC = "\x1b";
const ST = "\x1b\x5c"; // ESC backslash, the string terminator

/** Every query we answer. Groups: 1 DA ">", 2 DSR number, 3 OSC color number, 4 OSC terminator. */
const QUERY = /\x1b\[(>?)0?c|\x1b\[>0?q|\x1b\[\?u|\x1b\[([56])n|\x1b\](1[01]);\?(\x07|\x1b\x5c)/g;

export interface ResponderColors {
  /** OSC 10 answer, xterm "rgb:rrrr/gggg/bbbb" form. */
  foreground: string;
  /** OSC 11 answer. */
  background: string;
}

/** The side panel's xterm.js theme (#e6e6ea on #16161c). */
export const PANEL_COLORS: ResponderColors = { foreground: "rgb:e6e6/e6e6/eaea", background: "rgb:1616/1616/1c1c" };

export class TerminalResponder {
  /** An escape sequence cut off at the end of the last chunk. */
  private tail = "";

  constructor(private readonly colors: ResponderColors = PANEL_COLORS) {}

  /** Feeds program output; returns the bytes to write back to the program ("" when none). */
  feed(data: string): string {
    const text = this.tail + data;
    this.tail = "";
    let out = "";
    let end = 0;
    QUERY.lastIndex = 0;
    for (let m = QUERY.exec(text); m; m = QUERY.exec(text)) {
      end = m.index + m[0].length;
      out += this.answer(m);
    }
    // Keep a possibly incomplete sequence for the next chunk.
    const lastEsc = text.lastIndexOf(ESC);
    if (lastEsc >= end && text.length - lastEsc < 32) this.tail = text.slice(lastEsc);
    return out;
  }

  private answer(m: RegExpExecArray): string {
    const s = m[0];
    if (s.endsWith("c")) return m[1] === ">" ? `${ESC}[>0;276;0c` : `${ESC}[?62;22c`;
    if (s.endsWith("q")) return `${ESC}P>|xterm(1)${ST}`;
    if (s.endsWith("u")) return `${ESC}[?0u`;
    if (m[2] === "5") return `${ESC}[0n`;
    if (m[2] === "6") return `${ESC}[1;1R`;
    if (m[3]) return `${ESC}]${m[3]};${m[3] === "10" ? this.colors.foreground : this.colors.background}${m[4]}`;
    return "";
  }
}

/**
 * Answers to terminal queries, as xterm.js sends them through onData:
 * DA1/DA2, XTVERSION, kitty flags, cursor position and status reports, OSC 10/11.
 * (A cursor position report looks like modified F3 in some encodings; xterm.js
 * sends F3 as ESC O R, so real keys are not affected.)
 */
const REPLY = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1bP>\|[^\x1b]*\x1b\x5c|\x1b\[\?\d*u|\x1b\[\d+;\d+R|\x1b\[0n|\x1b\]1[01];rgb:[0-9a-fA-F/]*(?:\x07|\x1b\x5c)/g;

export function stripQueryReplies(data: string): string {
  return data.includes(ESC) ? data.replace(REPLY, "") : data;
}

/**
 * Plain text of raw TUI output, for spotting prompts. Claude Code draws
 * spaces as cursor-forward moves and lines with cursor positioning, so those
 * become spaces and newlines; every other control sequence is dropped.
 */
export function plainText(raw: string): string {
  return raw
    .replace(/\x1b\[\d*C/g, " ")
    .replace(/\x1b\[\d*(?:;\d*)?[Hf]/g, "\n")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\x5c)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?\x1b\x5c/g, "")
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\r/g, "");
}

/** A rolling window of recent plain text. */
export class ScreenText {
  private text = "";
  private rawTail = "";

  constructor(private readonly max = 6000) {}

  /** Appends output; returns the current window. */
  push(raw: string): string {
    // Hold back a cut-off escape sequence so it is not half-stripped.
    const all = this.rawTail + raw;
    const lastEsc = all.lastIndexOf(ESC);
    const cut = lastEsc >= 0 && all.length - lastEsc < 64 && !/[@-~\x07]/.test(all.slice(lastEsc + 2)) ? lastEsc : all.length;
    this.rawTail = all.slice(cut);
    this.text = (this.text + plainText(all.slice(0, cut))).slice(-this.max);
    return this.text;
  }

  get value(): string {
    return this.text;
  }

  /** Forget what was seen (after acting on a prompt). */
  clear(): void {
    this.text = "";
  }
}

export type BlockingPrompt = { kind: "trust" | "permission" | "login"; reason: string } | { kind: "limit"; error: string };

export const TRUST_REASON =
  "Claude Code is asking whether to trust its working folder. Open the Terminal tab, choose 'Yes, I trust this folder', then run the task again.";
export const PERMISSION_REASON =
  "Claude Code is asking for permission to use a tool it was not given. Open the Terminal tab to see what it wanted, then run the task again.";
export const LOGIN_REASON =
  "Claude Code is not logged in. Open the Terminal tab, start your session and log in with /login, then run the task again.";

/** An interactive prompt that would block a task, from the recent plain text of its terminal. */
export function detectBlockingPrompt(text: string): BlockingPrompt | null {
  const t = text.replace(/[ \t]+/g, " ");
  if (/Yes, ?I trust this folder|Do you trust the files in this folder/i.test(t)) return { kind: "trust", reason: TRUST_REASON };
  if (/Do you want to [^?\n]{1,100}\?[\s\S]{0,400}?1\. ?Yes/i.test(t)) return { kind: "permission", reason: PERMISSION_REASON };
  if (/Select login method|Please run \/login|Invalid API key|OAuth token has expired/i.test(t)) return { kind: "login", reason: LOGIN_REASON };
  const limit = /Claude AI usage limit reached[^\n]*|usage limit reached[^\n]*|You've hit your (?:\w+ )?limit[^\n]*/i.exec(t);
  // "usage limit" in the text: the extension retries it later (a temporary failure).
  if (limit) return { kind: "limit", error: `Claude Code: usage limit reached (${limit[0].trim().slice(0, 200)})` };
  return null;
}
