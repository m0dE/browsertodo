import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import { snapshotExpression } from "../src/page-snapshot.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentTab;
let driver: Driver;
/** Values returned by Runtime.evaluate, matched by a substring of the expression. */
let evalResults: [string, unknown][];

beforeEach(() => {
  chrome = installChromeFake();
  cdp = new Cdp();
  agent = new AgentTab();
  driver = new Driver(cdp, agent, { sleep: async () => {} });
  evalResults = [];
  chrome.debugger.respond = (method, params) => {
    if (method === "Runtime.evaluate") {
      const expr = String((params as { expression: string }).expression);
      const hit = evalResults.find(([needle]) => expr.includes(needle));
      return { result: { value: hit ? hit[1] : undefined } };
    }
    if (method === "Page.captureScreenshot") return { data: "SU1H" };
    if (method === "Page.navigate") return { frameId: "f", loaderId: "l" };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 42 };
    return {};
  };
});

const inputCommands = () => chrome.debugger.commands.filter((c) => c.method.startsWith("Input."));

/** A focused normal window whose active tab shows `url`. */
async function userWindow(url: string) {
  const win = await chrome.windows.create({ url, focused: true, type: "normal" });
  return { windowId: win.id, tabId: win.tabs[0]!.id };
}

describe("AgentTab", () => {
  it("one-off runs act on the tab the user is looking at, in a browsertodo group", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await chrome.windows.create({ url: "https://popup.test/", focused: false, type: "popup" });
    expect(await agent.prepare("current-tab")).toBe(tabId);
    expect(chrome.tabs.createCalls).toEqual([]);
    expect(chrome.windows.createCalls).toHaveLength(2);
    expect(chrome.storage.session.data.agentTabId).toBe(tabId);
    expect(await agent.isAgentTab(tabId)).toBe(true);
    expect(await agent.isAgentTab(999)).toBe(false);
    expect(await agent.windowId()).toBe(windowId);
    const group = chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId)!;
    expect(group).toMatchObject({ windowId, title: "browsertodo", color: "blue" });
  });

  it.each([
    "chrome://newtab/",
    "chrome-extension://abc/page.html",
    "https://chromewebstore.google.com/detail/x",
    "https://chrome.google.com/webstore/x",
    "about:version",
    "edge://settings",
    "devtools://devtools/x",
    "view-source:https://a.test/",
    "",
  ])("one-off run on %j opens a new active tab right after it", async (url) => {
    const { windowId, tabId } = await userWindow("https://first.test/");
    const second = await chrome.tabs.create({ windowId, url, active: true });
    await chrome.tabs.create({ windowId, url: "https://third.test/", active: false });
    chrome.tabs.createCalls.length = 0;
    const agentTab = await agent.prepare("current-tab");
    expect(agentTab).not.toBe(tabId);
    expect(agentTab).not.toBe(second.id);
    expect(chrome.tabs.createCalls).toEqual([{ windowId, index: 2, active: true, url: "about:blank" }]);
    expect((await chrome.tabs.get(agentTab)).active).toBe(true);
  });

  it("about:blank is controllable", async () => {
    const { tabId } = await userWindow("about:blank");
    expect(await agent.prepare("current-tab")).toBe(tabId);
  });

  it("opens a focused window when there is no normal window", async () => {
    const tabId = await agent.prepare("current-tab");
    expect(chrome.windows.createCalls).toEqual([{ url: "about:blank", focused: true, type: "normal" }]);
    expect(chrome.tabs.byId.get(tabId)!.url).toBe("about:blank");
  });

  it("scheduled runs open a background tab in the last focused window, then reuse it", async () => {
    const { windowId, tabId: userTab } = await userWindow("https://example.com/");
    const first = await agent.prepare("own-tab");
    expect(first).not.toBe(userTab);
    expect(chrome.tabs.createCalls).toEqual([{ windowId, active: false, url: "about:blank" }]);
    expect((await chrome.tabs.get(userTab)).active).toBe(true);
    expect(chrome.windows.createCalls).toHaveLength(1);
    // The user moves on; the next scheduled run reuses the same tab.
    await chrome.tabs.update(userTab, { active: true });
    expect(await agent.prepare("own-tab")).toBe(first);
    expect(chrome.tabs.createCalls).toHaveLength(1);
    // Gone: a new one is opened.
    await chrome.tabs.remove(first);
    const third = await agent.prepare("own-tab");
    expect(third).not.toBe(first);
    expect(chrome.tabs.createCalls).toHaveLength(2);
    expect(chrome.storage.session.data.agentTabId).toBe(third);
  });

  it("scheduled runs open an unfocused window when there is none", async () => {
    await agent.prepare("own-tab");
    expect(chrome.windows.createCalls).toEqual([{ url: "about:blank", focused: false, type: "normal" }]);
  });

  it("joins an existing browsertodo group in the same window and creates only one", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    const other = await chrome.windows.create({ url: "https://b.test/", focused: false, type: "normal" });
    const elsewhere = await chrome.tabs.group({ tabIds: [other.tabs[0]!.id], createProperties: { windowId: other.id } });
    await chrome.tabGroups.update(elsewhere, { title: "browsertodo", color: "blue" });
    const loose = await chrome.tabs.create({ windowId, url: "https://c.test/", active: false });
    const existing = await chrome.tabs.group({ tabIds: [loose.id], createProperties: { windowId } });
    await chrome.tabGroups.update(existing, { title: "browsertodo", color: "blue" });
    await agent.prepare("current-tab");
    expect(chrome.tabs.byId.get(tabId)!.groupId).toBe(existing);
    await agent.prepare("own-tab");
    await agent.prepare("current-tab");
    expect(chrome.tabGroups.byId.size).toBe(2);
  });

  it("does not rename a group of the user's own", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    const mine = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(mine, { title: "Work", color: "red" });
    await agent.prepare("current-tab");
    expect(chrome.tabGroups.byId.get(mine)).toMatchObject({ title: "Work", color: "red" });
    expect(chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId)!.title).toBe("browsertodo");
  });

  it("still works when tab groups are unavailable", async () => {
    await userWindow("https://example.com/");
    const c = chrome as unknown as Record<string, any>;
    c.tabs.group = async () => {
      throw new Error("no groups");
    };
    expect(typeof (await agent.prepare("current-tab"))).toBe("number");
  });

  it("the driver keeps using the run's tab after the user switches tabs", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    const other = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await driver.readPage();
    expect(chrome.debugger.commands.at(-1)!.tabId).toBe(tabId);
    expect(chrome.debugger.attached.has(other.id)).toBe(false);
  });

  it("switching the agent to a different tab detaches the old one", async () => {
    const { windowId, tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    await driver.ready();
    const next = await chrome.tabs.create({ windowId, url: "https://other.test/", active: true });
    await agent.prepare("current-tab");
    await driver.ready();
    expect([...chrome.debugger.attached]).toEqual([next.id]);
    expect(chrome.debugger.attached.has(tabId)).toBe(false);
  });

  it("fails the next browser call readably when the user closed the agent tab", async () => {
    const { tabId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    await driver.readPage();
    await chrome.tabs.remove(tabId);
    await expect(driver.readPage()).rejects.toThrow("the agent tab was closed");
  });

  it("show() focuses the agent tab's window and activates the tab", async () => {
    expect(await agent.show()).toBe(false);
    const { windowId } = await userWindow("https://example.com/");
    const agentTab = await agent.prepare("own-tab");
    const { windowId: later } = await userWindow("https://later.test/");
    expect(later).not.toBe(windowId);
    await chrome.tabs.update((await chrome.tabs.query({ windowId }))[0]!.id, { active: true });
    chrome.tabs.updateCalls.length = 0;
    expect(await agent.show()).toBe(true);
    expect(chrome.windows.updateCalls).toEqual([{ id: windowId, props: { focused: true } }]);
    expect(chrome.tabs.updateCalls).toEqual([{ id: agentTab, props: { active: true } }]);
    expect(chrome.windows.focusOrder.at(-1)).toBe(windowId);
    expect((await chrome.tabs.get(agentTab)).active).toBe(true);
  });

  it("show() restores a minimized window", async () => {
    const { windowId } = await userWindow("https://example.com/");
    await agent.prepare("current-tab");
    chrome.windows.byId.get(windowId)!.state = "minimized";
    await agent.show();
    expect(chrome.windows.updateCalls.at(-1)).toEqual({ id: windowId, props: { focused: true, state: "normal" } });
  });
});

describe("Cdp", () => {
  it("attaches with protocol 1.3 and reattaches once after a detach", async () => {
    const attach = vi.spyOn(chrome.debugger, "attach");
    await cdp.attach(5);
    expect(attach).toHaveBeenCalledWith({ tabId: 5 }, "1.3");
    chrome.debugger.attached.delete(5);
    cdp.handleDetach({ tabId: 5 }, "target_closed");
    await cdp.send("Page.enable");
    expect(attach).toHaveBeenCalledTimes(2);
    expect(chrome.debugger.commands.at(-1)).toMatchObject({ tabId: 5, method: "Page.enable" });
  });

  it("fails sends after the user cancels, and tells the listener", async () => {
    const onCancel = vi.fn();
    cdp.onUserCancel = onCancel;
    await cdp.attach(5);
    chrome.debugger.attached.delete(5);
    cdp.handleDetach({ tabId: 5 }, "canceled_by_user");
    expect(onCancel).toHaveBeenCalled();
    await expect(cdp.send("Page.enable")).rejects.toThrow("debugger detached by user");
    // A fresh task resets the state.
    cdp.reset();
    await cdp.attach(5);
    await expect(cdp.send("Page.enable")).resolves.toBeDefined();
  });

  it("ignores detaches of other tabs", async () => {
    await cdp.attach(5);
    cdp.handleDetach({ tabId: 6 }, "canceled_by_user");
    await expect(cdp.send("Page.enable")).resolves.toBeDefined();
  });
});

describe("Driver", () => {
  it("click scrolls the element into view and sends a trusted mouse click at its center", async () => {
    evalResults.push(["scrollIntoView", { x: 110, y: 220 }]);
    await driver.click({ index: 3 });
    expect(inputCommands().map((c) => c.params)).toEqual([
      { type: "mouseMoved", x: 110, y: 220, button: "none" },
      { type: "mousePressed", x: 110, y: 220, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 110, y: 220, button: "left", buttons: 0, clickCount: 1 },
    ]);
  });

  it("click reports a missing element", async () => {
    await expect(driver.click({ index: 9 })).rejects.toThrow("element 9 not found; call read_page again");
  });

  it("type clicks, then inserts text", async () => {
    evalResults.push(["scrollIntoView", { x: 1, y: 2 }]);
    await driver.type({ index: 2, text: "hello" });
    const methods = inputCommands().map((c) => c.method);
    expect(methods).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.insertText"]);
    expect(inputCommands().at(-1)!.params).toEqual({ text: "hello" });
  });

  it("paste inserts text at the focus", async () => {
    await driver.paste({ text: "x y" });
    expect(inputCommands()).toEqual([{ tabId: expect.any(Number), method: "Input.insertText", params: { text: "x y" } }]);
  });

  it("pressKey sends keyDown and keyUp", async () => {
    await driver.pressKey({ key: "Control+Enter" });
    expect(inputCommands().map((c) => (c.params as { type: string; modifiers: number }).type)).toEqual(["keyDown", "keyUp"]);
    expect((inputCommands()[0]!.params as { modifiers: number }).modifiers).toBe(2);
  });

  it("scroll wheels at the viewport center by amount x 0.8 x viewport", async () => {
    evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
    await driver.scroll({ direction: "down", amount: 2 });
    await driver.scroll({ direction: "left" });
    expect(inputCommands().map((c) => c.params)).toEqual([
      { type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 1280 },
      { type: "mouseWheel", x: 500, y: 400, deltaX: -800, deltaY: 0 },
    ]);
  });

  describe("scroll measures what moved", () => {
    const pageEntry = (top: number, sh = 5400) => ({ page: true, index: null, top, left: 0, sh, sw: 1000, ch: 800, cw: 1000, oy: true, ox: true });
    /** Probe answers: "measure" gives `before`, every "read" the next of `reads` (the last repeats). */
    function probe(before: unknown, reads: unknown[]) {
      let n = 0;
      const base = chrome.debugger.respond;
      chrome.debugger.respond = (method, params) => {
        const expr = String((params as { expression?: string })?.expression ?? "");
        if (expr.includes('("measure"')) return { result: { value: { ok: true, value: before } } };
        if (expr.includes('("read"')) return { result: { value: { ok: true, value: reads[Math.min(n++, reads.length - 1)] } } };
        return base!(method, params);
      };
    }

    it("the page moved: reports pixels and the new position, after the smooth scroll settled", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      probe({ entries: [pageEntry(640)], overFrame: false }, [
        { entries: [pageEntry(900)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
        { entries: [pageEntry(1280)], overFrame: false },
      ]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "page", position: 1280, size: 5400, view: 800 });
      expect(inputCommands()).toHaveLength(1);
    });

    it("at the bottom nothing moved", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      const bottom = { entries: [pageEntry(4600)], overFrame: false };
      probe(bottom, [bottom]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 0, target: "page", position: 4600, size: 5400, view: 800, reason: "end" });
    });

    it("an inner container scrolled instead of the window", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      const inner = (top: number) => ({ page: false, index: 7, top, left: 0, sh: 2000, sw: 300, ch: 500, cw: 300, oy: true, ox: false });
      probe({ entries: [inner(0), pageEntry(0, 800)], overFrame: false }, [{ entries: [inner(640), pageEntry(0, 800)], overFrame: false }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true, moved: 640, target: "container", containerIndex: 7, position: 640, size: 2000, view: 500 });
    });

    it("a page that cannot be measured still scrolls", async () => {
      evalResults.push(["innerWidth", { w: 1000, h: 800 }]);
      expect(await driver.scroll({ direction: "down" })).toEqual({ ok: true });
      expect(inputCommands()).toHaveLength(1);
    });
  });

  it("upload sets files on a file input and refuses other elements", async () => {
    evalResults.push(["type === \"file\"", "file"]);
    await driver.upload({ index: 4, paths: ["C:\\a.png"] });
    const cmd = chrome.debugger.commands.find((c) => c.method === "DOM.setFileInputFiles");
    expect(cmd?.params).toEqual({ files: ["C:\\a.png"], nodeId: 42 });
    const q = chrome.debugger.commands.find((c) => c.method === "DOM.querySelector");
    expect(q?.params).toEqual({ nodeId: 1, selector: '[data-browsertodo-index="4"]' });

    evalResults.length = 0;
    evalResults.push(["type === \"file\"", "notfile"]);
    await expect(driver.upload({ index: 4, paths: ["C:\\a.png"] })).rejects.toThrow(/not a file input/);
    evalResults.length = 0;
    evalResults.push(["type === \"file\"", "missing"]);
    await expect(driver.upload({ index: 4, paths: ["C:\\a.png"] })).rejects.toThrow("element 4 not found; call read_page again");
  });

  it("screenshot captures a JPEG", async () => {
    expect(await driver.screenshot()).toEqual({ base64: "SU1H", mimeType: "image/jpeg" });
    const cmd = chrome.debugger.commands.find((c) => c.method === "Page.captureScreenshot");
    expect(cmd?.params).toEqual({ format: "jpeg", quality: 70 });
  });

  it("navigate waits for readyState complete and returns url and title", async () => {
    let polls = 0;
    chrome.debugger.respond = (method, params) => {
      if (method === "Page.navigate") return { frameId: "f" };
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr === "document.readyState") return { result: { value: ++polls < 3 ? "loading" : "complete" } };
        return { result: { value: { url: "https://example.com/", title: "Example" } } };
      }
      return {};
    };
    expect(await driver.navigate({ url: "https://example.com/" })).toEqual({ url: "https://example.com/", title: "Example" });
    expect(polls).toBe(3);
  });

  it("navigate rejects unsupported schemes and navigation errors", async () => {
    await expect(driver.navigate({ url: "javascript:alert(1)" })).rejects.toThrow(/http/);
    chrome.debugger.respond = () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(driver.navigate({ url: "https://nope.invalid/" })).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
  });

  it("readPage evaluates the snapshot function by value", async () => {
    const snap = { url: "u", title: "t", text: "", elements: [], truncated: false };
    evalResults.push(["data-browsertodo-index", snap]);
    expect(await driver.readPage()).toEqual(snap);
    const cmd = chrome.debugger.commands.find((c) => c.method === "Runtime.evaluate");
    expect(cmd?.params).toMatchObject({ expression: snapshotExpression(), returnByValue: true });
  });

  it("surfaces page exceptions", async () => {
    chrome.debugger.respond = () => ({ result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x" } } });
    await expect(driver.readPage()).rejects.toThrow("ReferenceError: x");
  });

  it("currentUrl reads the agent tab", async () => {
    const tabId = await agent.ensureTab();
    chrome.tabs.byId.get(tabId)!.url = "https://example.com/x";
    expect(await driver.currentUrl()).toEqual({ url: "https://example.com/x" });
  });
});

describe("snapshotExpression", () => {
  it("is a self-contained expression with the limits baked in", () => {
    const expr = snapshotExpression();
    expect(expr).toMatch(/^\(function/);
    expect(expr).toContain("(8000, 300)");
    expect(expr).not.toMatch(/__name|__vite|_interop|import\(/);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});
