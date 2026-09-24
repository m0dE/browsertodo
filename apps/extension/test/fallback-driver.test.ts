import { beforeEach, describe, expect, it } from "vitest";
import { FOREIGN_FRAME_ERROR, installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import {
  FALLBACK_NOTE,
  clickInPage,
  insertTextInPage,
  isDebuggerBlocked,
  pressKeyInPage,
  scrollInPage,
} from "../src/fallback-driver.js";
import { snapshotPage } from "../src/page-snapshot.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentTab;
let driver: Driver;
let tabId: number;
let windowId: number;

const snap = { url: "https://mail.test/", title: "Inbox", text: "hi", elements: [], truncated: false };

beforeEach(async () => {
  chrome = installChromeFake();
  cdp = new Cdp();
  agent = new AgentTab();
  driver = new Driver(cdp, agent, { sleep: async () => {} });
  const win = await chrome.windows.create({ url: "https://mail.test/", focused: true, type: "normal" });
  windowId = win.id;
  tabId = win.tabs[0]!.id;
  await agent.prepare("current-tab");
  chrome.debugger.respond = (method) => {
    if (method === "Runtime.evaluate") return { result: { value: snap } };
    if (method === "Page.captureScreenshot") return { data: "Q0RQ" };
    return {};
  };
  chrome.scripting.respond = (func) => (func === snapshotPage ? snap : { ok: true, value: true });
});

const injected = () => chrome.scripting.calls.map((c) => c.func);

describe("isDebuggerBlocked", () => {
  it("matches Chrome's cross-extension errors only", () => {
    expect(isDebuggerBlocked(new Error("Cannot access a chrome-extension:// URL of different extension"))).toBe(true);
    expect(isDebuggerBlocked("Cannot access a chrome-extension:// URL of different extension")).toBe(true);
    expect(isDebuggerBlocked(new Error("debugger_access_denied"))).toBe(true);
    expect(isDebuggerBlocked(new Error("Another debugger is already attached to the tab with id: 5."))).toBe(false);
    expect(isDebuggerBlocked(new Error("debugger detached by user"))).toBe(false);
    expect(isDebuggerBlocked(new Error("No tab with id: 5."))).toBe(false);
  });
});

describe("Driver on a page where Chrome refuses the debugger", () => {
  it("normal pages stay on the debugger and never inject scripts", async () => {
    expect(await driver.readPage()).toEqual(snap);
    expect(await driver.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(chrome.scripting.calls).toEqual([]);
    expect(chrome.tabs.captureCalls).toEqual([]);
    expect(driver.inFallback).toBe(false);
  });

  it("switches to the fallback when attach is refused, with the note on the first result only", async () => {
    chrome.debugger.blocked.add(tabId);
    const first = await driver.readPage();
    expect(first).toEqual({ ...snap, note: FALLBACK_NOTE });
    expect(driver.inFallback).toBe(true);
    expect(chrome.scripting.calls[0]).toMatchObject({ tabId, func: snapshotPage, args: [8000, 300] });
    // Top frame only: no allFrames / other extensions' frames.
    expect(chrome.scripting.calls[0]!.frameIds).toBeUndefined();

    expect(await driver.screenshot()).toEqual({ base64: "RkFLRQ==", mimeType: "image/jpeg" });
    expect(chrome.tabs.captureCalls).toEqual([{ windowId, opts: { format: "jpeg", quality: 70 } }]);
    expect(await driver.click({ index: 3 })).toEqual({ ok: true });
    expect(await driver.type({ index: 4, text: "Ada" })).toEqual({ ok: true });
    expect(await driver.paste({ text: "!" })).toEqual({ ok: true });
    expect(await driver.pressKey({ key: "Control+Enter" })).toEqual({ ok: true });
    expect(await driver.scroll({ direction: "down", amount: 2, index: 1 })).toEqual({ ok: true });

    expect(injected()).toEqual([snapshotPage, clickInPage, clickInPage, insertTextInPage, insertTextInPage, pressKeyInPage, scrollInPage]);
    const args = chrome.scripting.calls.map((c) => c.args);
    expect(args.slice(1)).toEqual([
      [3],
      [4],
      [4, "Ada"],
      [null, "!"],
      [{ key: "Enter", code: "Enter", keyCode: 13, text: "\r", alt: false, ctrl: true, meta: false, shift: false }],
      ["down", 2, 1],
    ]);
    expect(chrome.debugger.commands).toEqual([]);
  });

  it("switches mid-run when a frame appears after the debugger was attached", async () => {
    await driver.readPage();
    expect(chrome.debugger.commands.map((c) => c.method)).toContain("Runtime.evaluate");
    // Chrome detaches the session when the other extension's frame is added, and refuses to reattach.
    chrome.debugger.attached.delete(tabId);
    chrome.debugger.blocked.add(tabId);
    cdp.handleDetach({ tabId }, "target_closed");
    expect(await driver.click({ index: 2 })).toEqual({ ok: true, note: FALLBACK_NOTE });
    expect(injected()).toEqual([clickInPage]);
  });

  it("switches when a command fails even though the session is still attached", async () => {
    await driver.ready();
    chrome.debugger.blocked.add(tabId);
    expect(await driver.readPage()).toEqual({ ...snap, note: FALLBACK_NOTE });
  });

  it("surfaces page-function errors and does not switch on other errors", async () => {
    chrome.debugger.blocked.add(tabId);
    chrome.scripting.respond = () => ({ ok: false, error: "element 9 not found; call read_page again" });
    await expect(driver.click({ index: 9 })).rejects.toThrow("element 9 not found; call read_page again");

    const other = new Driver(new Cdp(), agent, { sleep: async () => {} });
    chrome.debugger.blocked.clear();
    chrome.debugger.respond = () => {
      throw new Error("Some other CDP failure");
    };
    await expect(other.readPage()).rejects.toThrow("Some other CDP failure");
    expect(other.inFallback).toBe(false);
  });

  it("upload fails with a clear reason in fallback mode", async () => {
    chrome.debugger.blocked.add(tabId);
    await expect(driver.upload({ index: 1, paths: ["C:\\a.png"] })).rejects.toThrow(/upload is not possible on this page because another extension/);
    // The note was not consumed by the failure.
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
  });

  it("screenshot needs the agent tab to be visible", async () => {
    chrome.debugger.blocked.add(tabId);
    await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await expect(driver.screenshot()).rejects.toThrow(/visible tab/);
    expect(chrome.tabs.captureCalls).toEqual([]);
  });

  it("navigates with tabs.update, then tries the debugger again on the new page", async () => {
    chrome.debugger.blocked.add(tabId);
    chrome.tabs.byId.get(tabId)!.title = "Other";
    const nav = await driver.navigate({ url: "https://other.test/" });
    expect(nav).toEqual({ url: "https://other.test/", title: "Other", note: FALLBACK_NOTE });
    expect(chrome.tabs.updateCalls.at(-1)).toEqual({ id: tabId, props: { url: "https://other.test/" } });

    // The new page has no foreign frame: back on the debugger, no second note.
    chrome.debugger.blocked.delete(tabId);
    expect(await driver.readPage()).toEqual(snap);
    expect(driver.inFallback).toBe(false);
    expect(chrome.debugger.commands.map((c) => c.method)).toContain("Runtime.evaluate");

    // Blocked again later: fallback without repeating the note.
    chrome.debugger.blocked.add(tabId);
    chrome.debugger.attached.delete(tabId);
    cdp.handleDetach({ tabId }, "target_closed");
    expect(await driver.readPage()).toEqual(snap);
  });

  it("navigate only waits when Page.navigate went through before the tab got blocked", async () => {
    chrome.debugger.respond = (method) => {
      if (method === "Page.navigate") {
        chrome.debugger.blocked.add(tabId);
        return { frameId: "f" };
      }
      return {};
    };
    await driver.navigate({ url: "https://mail.test/inbox" });
    expect(chrome.tabs.updateCalls.filter((c) => c.props.url)).toEqual([]);
  });

  it("each blocked tab gets its own note", async () => {
    chrome.debugger.blocked.add(tabId);
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
    const next = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await agent.prepare("current-tab");
    chrome.debugger.blocked.add(next.id);
    expect((await driver.readPage()).note).toBe(FALLBACK_NOTE);
    expect(chrome.scripting.calls.at(-1)!.tabId).toBe(next.id);
    expect(FOREIGN_FRAME_ERROR).toMatch(/different extension/);
  });
});

describe("page functions", () => {
  it("are self-contained so chrome.scripting can serialize them", () => {
    for (const fn of [clickInPage, insertTextInPage, pressKeyInPage, scrollInPage, snapshotPage]) {
      const src = fn.toString();
      expect(src).not.toMatch(/__name|__vite|_interop|import\(|\bexports\b|require\(/);
      expect(() => new Function(`return (${src})`)).not.toThrow();
    }
  });
});
