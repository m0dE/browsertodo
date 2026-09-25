import { describe, expect, it } from "vitest";
import {
  detectBlockingPrompt,
  plainText,
  ScreenText,
  stripQueryReplies,
  TerminalResponder,
  TRUST_REASON,
  PERMISSION_REASON,
} from "../src/terminal-responder.js";

const E = "\x1b";
const ST = `${E}\x5c`;

describe("TerminalResponder", () => {
  it("answers DA1, DA2, XTVERSION, kitty flags, DSR, CPR and OSC 10/11", () => {
    const r = new TerminalResponder();
    expect(r.feed(`${E}[c`)).toBe(`${E}[?62;22c`);
    expect(r.feed(`${E}[0c`)).toBe(`${E}[?62;22c`);
    expect(r.feed(`${E}[>c`)).toBe(`${E}[>0;276;0c`);
    expect(r.feed(`${E}[>0c`)).toBe(`${E}[>0;276;0c`);
    expect(r.feed(`${E}[>0q`)).toBe(`${E}P>|xterm(1)${ST}`);
    expect(r.feed(`${E}[?u`)).toBe(`${E}[?0u`);
    expect(r.feed(`${E}[5n`)).toBe(`${E}[0n`);
    expect(r.feed(`${E}[6n`)).toBe(`${E}[1;1R`);
    expect(r.feed(`${E}]10;?\x07`)).toBe(`${E}]10;rgb:e6e6/e6e6/eaea\x07`);
    expect(r.feed(`${E}]11;?${ST}`)).toBe(`${E}]11;rgb:1616/1616/1c1c${ST}`);
  });

  it("answers what Claude Code sends at startup, in order, and ignores ordinary output", () => {
    const r = new TerminalResponder();
    // Bytes seen from claude.exe 2.1.282 in ConPTY.
    expect(r.feed(`${E}[?2004h${E}[?2031h${E}[?1004h`)).toBe("");
    expect(r.feed(`${E}[<u${E}[>5u${E}[>4;2m`)).toBe("");
    expect(r.feed(`${E}[>0q${E}[?u`)).toBe(`${E}P>|xterm(1)${ST}${E}[?0u`);
    expect(r.feed(`hello ${E}[1;2c world ${E}[38;2;1;2;3m`)).toBe("");
  });

  it("handles a query split across chunks, once", () => {
    const r = new TerminalResponder();
    expect(r.feed(`text ${E}[`)).toBe("");
    expect(r.feed(`>0`)).toBe("");
    expect(r.feed(`q more`)).toBe(`${E}P>|xterm(1)${ST}`);
    expect(r.feed(`${E}]11;?`)).toBe("");
    expect(r.feed(`\x07`)).toBe(`${E}]11;rgb:1616/1616/1c1c\x07`);
    expect(r.feed("plain")).toBe("");
  });
});

describe("stripQueryReplies", () => {
  it("drops xterm.js answers but keeps keys", () => {
    expect(stripQueryReplies(`${E}[?1;2c`)).toBe("");
    expect(stripQueryReplies(`${E}[>0;276;0c`)).toBe("");
    expect(stripQueryReplies(`${E}[12;40R`)).toBe("");
    expect(stripQueryReplies(`${E}[0n`)).toBe("");
    expect(stripQueryReplies(`${E}]11;rgb:1616/1616/1c1c${ST}`)).toBe("");
    expect(stripQueryReplies(`${E}P>|xterm.js(6.0.0)${ST}`)).toBe("");
    expect(stripQueryReplies(`a${E}[?62;22cb`)).toBe("ab");
    for (const key of ["hello\r", `${E}[A`, `${E}[B`, `${E}OR`, `${E}[1;5C`, "\x03", `${E}[200~paste${E}[201~`]) expect(stripQueryReplies(key)).toBe(key);
  });
});

describe("plainText / ScreenText", () => {
  // The folder-trust prompt as claude.exe draws it: spaces are cursor-forward moves.
  const TRUST = `${E}[?25l${E}[38;2;255;193;7m\r\n${E}[1m${E}[3;2HAccessing${E}[1Cworkspace:${E}[m${E}[7;2HQuick${E}[1Csafety${E}[1Ccheck:${E}[1CIs${E}[1Cthis${E}[1Ca${E}[1Cproject${E}[1Cyou${E}[1Ccreated${E}[1Cor${E}[1Cone${E}[1Cyou${E}[1Ctrust?${E}]8;id=u;https://code.claude.com/docs/en/security${ST}${E}[12;2HSecurity guide${E}]8;;${ST}${E}[14;2H❯${E}[1CNo,${E}[1Cexit${E}[m${E}[15;4HYes,${E}[1CI${E}[1Ctrust${E}[1Cthis${E}[1Cfolder${E}[17;2HEnter${E}[1Cto${E}[1Cconfirm`;

  it("turns cursor moves into spaces and newlines", () => {
    const t = plainText(TRUST);
    expect(t).toContain("Quick safety check: Is this a project you created or one you trust?");
    expect(t).toContain("Yes, I trust this folder");
    expect(t).not.toContain(E);
  });

  it("keeps a cut-off escape sequence for the next chunk", () => {
    const s = new ScreenText(100);
    s.push(`Yes,${E}[1`);
    expect(s.push(`CI${E}[1Ctrust this folder`)).toContain("Yes, I trust this folder");
    s.clear();
    expect(s.value).toBe("");
  });

  it("detects the trust prompt, a permission prompt and a usage limit", () => {
    expect(detectBlockingPrompt(plainText(TRUST))).toEqual({ kind: "trust", reason: TRUST_REASON });
    const perm = "Bash command\n  rm -rf x\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No";
    expect(detectBlockingPrompt(perm)).toEqual({ kind: "permission", reason: PERMISSION_REASON });
    expect(detectBlockingPrompt("Do you want to proceed? the page asked")).toBeNull();
    expect(detectBlockingPrompt("● Claude AI usage limit reached|1760000000")).toMatchObject({ kind: "limit", error: expect.stringMatching(/^Claude Code: usage limit reached/) });
    expect(detectBlockingPrompt("● Posted. Calling task_complete.")).toBeNull();
  });
});
