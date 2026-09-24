import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { AgentWindow } from "../src/agent-window.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import { snapshotExpression } from "../src/page-snapshot.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentWindow;
let driver: Driver;
/** Values returned by Runtime.evaluate, matched by a substring of the expression. */
let evalResults: [string, unknown][];

beforeEach(() => {
  chrome = installChromeFake();
  cdp = new Cdp();
  agent = new AgentWindow();
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

describe("AgentWindow", () => {
  it("creates one unfocused window and reuses it", async () => {
    const a = await agent.ensureTab();
    const b = await agent.ensureTab();
    expect(a).toBe(b);
    expect(chrome.windows.createCalls).toEqual([{ url: "about:blank", focused: false, type: "normal", width: 1280, height: 900 }]);
    expect(typeof chrome.storage.session.data.agentWindowId).toBe("number");
    expect(await agent.isAgentTab(a)).toBe(true);
    expect(await agent.isAgentTab(999)).toBe(false);
  });

  it("puts the agent tab in a tab group titled browsertodo, once", async () => {
    const groups = new Map<number, { title?: string; color?: string }>();
    const tabGroup = new Map<number, number>();
    const c = chrome as unknown as Record<string, any>;
    const realGet = c.tabs.get;
    c.tabs.get = async (id: number) => ({ ...(await realGet(id)), groupId: tabGroup.get(id) ?? -1 });
    c.tabs.group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
      const gid = 77;
      groups.set(gid, {});
      tabIds.forEach((t) => tabGroup.set(t, gid));
      return gid;
    });
    c.tabGroups = {
      get: async (gid: number) => ({ id: gid, ...groups.get(gid) }),
      update: vi.fn(async (gid: number, props: { title: string; color: string }) => void groups.set(gid, props)),
    };
    const tab = await agent.ensureTab();
    await agent.ensureTab();
    expect(tabGroup.get(tab)).toBe(77);
    expect(groups.get(77)).toEqual({ title: "browsertodo", color: "blue" });
    expect(c.tabs.group).toHaveBeenCalledTimes(1);
    expect(c.tabGroups.update).toHaveBeenCalledTimes(1);
  });

  it("still works when tab groups are unavailable", async () => {
    const c = chrome as unknown as Record<string, any>;
    c.tabs.group = async () => {
      throw new Error("no groups");
    };
    c.tabGroups = { get: async () => ({}), update: async () => {} };
    expect(typeof (await agent.ensureTab())).toBe("number");
  });

  it("recreates the window when it was closed", async () => {
    const first = await agent.ensureTab();
    await chrome.windows.remove(chrome.storage.session.data.agentWindowId as number);
    const second = await agent.ensureTab();
    expect(second).not.toBe(first);
    expect(chrome.windows.createCalls).toHaveLength(2);
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
