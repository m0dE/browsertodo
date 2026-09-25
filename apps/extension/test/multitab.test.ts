import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { AgentTab } from "../src/agent-tab.js";
import { Cdp } from "../src/cdp.js";
import { Driver } from "../src/driver.js";
import { createBrowserCaller } from "../src/engine/browser-caller.js";
import { FALLBACK_NOTE } from "../src/fallback-driver.js";
import { snapshotPage } from "../src/page-snapshot.js";

let chrome: ChromeFake;
let cdp: Cdp;
let agent: AgentTab;
let driver: Driver;
let windowId: number;
let mainTab: number;
/** Called on every fake sleep (the driver polls tab loading with it). */
let onSleep: () => void;

/** Snapshot the fake page of a tab returns: its URL and title. */
const snapOf = (tabId: number) => {
  const t = chrome.tabs.byId.get(tabId)!;
  return { url: t.url, title: t.title ?? "", text: `text of ${t.url}`, elements: [], truncated: false };
};

beforeEach(async () => {
  chrome = installChromeFake();
  cdp = new Cdp();
  agent = new AgentTab();
  onSleep = () => {};
  driver = new Driver(cdp, agent, { sleep: async () => onSleep() });
  const win = await chrome.windows.create({ url: "https://mail.test/", focused: true, type: "normal" });
  windowId = win.id;
  mainTab = win.tabs[0]!.id;
  await agent.prepare("current-tab");
  chrome.debugger.respond = (method) => {
    const tabId = chrome.debugger.commands.at(-1)!.tabId;
    if (method === "Runtime.evaluate") return { result: { value: snapOf(tabId) } };
    if (method === "Page.captureScreenshot") return { data: "Q0RQ" };
    return {};
  };
  chrome.scripting.respond = (func, _args) => (func === snapshotPage ? { ...snapOf(chrome.scripting.calls.at(-1)!.tabId), text: "via scripting" } : { ok: true, value: true });
});

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://mail.test/m/${i + 1}`);
const activations = () => chrome.tabs.updateCalls.filter((c) => c.props.active);

describe("Driver with several tabs", () => {
  it("opens tabs in the background of the agent window, in the browsertodo group, and waits for all to load", async () => {
    // The second tab keeps loading for a few polls.
    let polls = 0;
    onSleep = () => {
      if (++polls === 3) {
        const t = [...chrome.tabs.byId.values()].find((x) => x.url.endsWith("/m/2"))!;
        t.status = "complete";
        t.title = "Second";
      }
    };
    const origCreate = chrome.tabs.create;
    chrome.tabs.create = async (opts) => {
      const tab = await origCreate(opts);
      const t = chrome.tabs.byId.get(tab.id)!;
      t.title = `Mail ${opts.url}`;
      if (opts.url?.endsWith("/m/2")) t.status = "loading";
      return tab;
    };
    const r = await driver.openTabs({ urls: urls(3) });
    expect(r.tabs.map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
    expect(r.tabs[1]).toEqual({ id: "t3", url: "https://mail.test/m/2", title: "Second", current: false });
    expect(r.tabs.every((t) => !t.error)).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(chrome.tabs.createCalls).toEqual([
      { windowId, index: 1, active: false, url: "https://mail.test/m/1" },
      { windowId, index: 2, active: false, url: "https://mail.test/m/2" },
      { windowId, index: 3, active: false, url: "https://mail.test/m/3" },
    ]);
    // The user's tab stays in front and stays current.
    expect((await chrome.tabs.get(mainTab)).active).toBe(true);
    expect(await agent.tabId()).toBe(mainTab);
    const group = chrome.tabs.byId.get(mainTab)!.groupId;
    for (const t of r.tabs) expect(chrome.tabs.byId.get(await agent.resolve(t.id))!.groupId).toBe(group);
    expect(chrome.tabGroups.byId.get(group)!.title).toBe("browsertodo");
  });

  it("reports a tab that is still loading after 30 s instead of waiting forever", async () => {
    const origCreate = chrome.tabs.create;
    chrome.tabs.create = async (opts) => {
      const tab = await origCreate(opts);
      chrome.tabs.byId.get(tab.id)!.status = "loading";
      return tab;
    };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    onSleep = () => void (now += 1000);
    try {
      const r = await driver.openTabs({ urls: urls(1) });
      expect(r.tabs[0]!.error).toBe("still loading after 30 s");
    } finally {
      Date.now = realNow;
    }
  });

  it("background: false shows the first new tab and makes it current", async () => {
    const r = await driver.openTabs({ urls: urls(2), background: false });
    expect(r.tabs.map((t) => t.current)).toEqual([true, false]);
    const first = await agent.resolve("t2");
    expect((await chrome.tabs.get(first)).active).toBe(true);
    await driver.click({ index: 1 });
    expect(chrome.debugger.commands.filter((c) => c.method.startsWith("Input.")).every((c) => c.tabId === first)).toBe(true);
  });

  it("rejects non-http URLs and too many tabs", async () => {
    await expect(driver.openTabs({ urls: ["javascript:alert(1)"] })).rejects.toThrow(/http/);
    await driver.openTabs({ urls: urls(8) });
    await driver.openTabs({ urls: urls(8) });
    await expect(driver.openTabs({ urls: urls(8) })).rejects.toThrow(/too many tabs: 17 open/);
  });

  it("reads several tabs without activating them or changing the current tab", async () => {
    await driver.ready();
    const { tabs } = await driver.openTabs({ urls: urls(3) });
    chrome.tabs.updateCalls.length = 0;
    const snaps = await Promise.all(tabs.map((t) => driver.readPage({ tab: t.id })));
    expect(snaps.map((s) => s.url)).toEqual(urls(3));
    expect(activations()).toEqual([]);
    expect((await chrome.tabs.get(mainTab)).active).toBe(true);
    const ids = await Promise.all(tabs.map((t) => agent.resolve(t.id)));
    // The debugger is attached to every read tab at once, and the current tab is unchanged.
    expect([...chrome.debugger.attached].sort()).toEqual([mainTab, ...ids].sort());
    expect(cdp.attachedTabId).toBe(mainTab);
    const evals = chrome.debugger.commands.filter((c) => c.method === "Runtime.evaluate").map((c) => c.tabId);
    expect(evals.sort()).toEqual([...ids].sort());
    // The default read is still the current tab.
    expect((await driver.readPage()).url).toBe("https://mail.test/");
  });

  it("reads a tab that refuses the debugger with chrome.scripting, next to debugger tabs, noting which tab", async () => {
    const { tabs } = await driver.openTabs({ urls: urls(2) });
    const blocked = await agent.resolve("t3");
    chrome.debugger.blocked.add(blocked);
    const [a, b] = await Promise.all(tabs.map((t) => driver.readPage({ tab: t.id })));
    expect(a!.text).toBe("text of https://mail.test/m/1");
    expect(a!.note).toBeUndefined();
    expect(b!.text).toBe("via scripting");
    expect(b!.note).toBe(`Tab t3: ${FALLBACK_NOTE}`);
    expect(chrome.scripting.calls.map((c) => c.tabId)).toEqual([blocked]);
    expect(activations()).toEqual([]);
    // Once per tab; the main tab still uses the debugger.
    expect((await driver.readPage({ tab: "t3" })).note).toBeUndefined();
    await driver.readPage();
    expect(chrome.debugger.commands.at(-1)).toMatchObject({ tabId: mainTab, method: "Runtime.evaluate" });
    expect(driver.inFallback).toBe(false);
    // Switching to the blocked tab drives it through the fallback.
    await driver.switchTab({ tab: "t3" });
    expect(driver.inFallback).toBe(true);
    await driver.click({ index: 2 });
    expect(chrome.scripting.calls.at(-1)!.tabId).toBe(blocked);
  });

  it("switch_tab makes later calls act on that tab, showing it only when the agent was visible", async () => {
    await driver.openTabs({ urls: urls(2) });
    const t2 = await agent.resolve("t2");
    const info = await driver.switchTab({ tab: "t2" });
    expect(info).toMatchObject({ id: "t2", url: "https://mail.test/m/1", current: true });
    // The agent's tab was in front, so the new current tab is shown.
    expect((await chrome.tabs.get(t2)).active).toBe(true);
    await driver.click({ index: 4 });
    await driver.pressKey({ key: "Enter" });
    const input = chrome.debugger.commands.filter((c) => c.method.startsWith("Input."));
    expect(input.length).toBeGreaterThan(0);
    expect(input.every((c) => c.tabId === t2)).toBe(true);
    expect(cdp.attachedTabId).toBe(t2);

    // The user looks at another tab: switching no longer steals the view.
    const user = await chrome.tabs.create({ windowId, url: "https://user.test/", active: true });
    chrome.tabs.updateCalls.length = 0;
    await driver.switchTab({ tab: "t3" });
    expect(activations()).toEqual([]);
    expect((await chrome.tabs.get(user.id)).active).toBe(true);
    await expect(driver.switchTab({ tab: "t9" })).rejects.toThrow('unknown tab "t9"; call list_tabs');
  });

  it("screenshot of a background current tab activates it first", async () => {
    await driver.openTabs({ urls: urls(1) });
    const t2 = await agent.resolve("t2");
    await chrome.tabs.update(mainTab, { active: true });
    await agent.setCurrent("t2");
    chrome.tabs.updateCalls.length = 0;
    expect(await driver.screenshot()).toEqual({ base64: "Q0RQ", mimeType: "image/jpeg" });
    expect(chrome.tabs.updateCalls).toEqual([{ id: t2, props: { active: true } }]);
    expect(chrome.debugger.commands.at(-1)).toMatchObject({ tabId: t2, method: "Page.captureScreenshot" });
    // Already in front: no extra activation.
    chrome.tabs.updateCalls.length = 0;
    await driver.screenshot();
    expect(chrome.tabs.updateCalls).toEqual([]);
  });

  it("lists and closes opened tabs, never the first one", async () => {
    await driver.openTabs({ urls: urls(3) });
    await driver.switchTab({ tab: "t3" });
    const t3 = await agent.resolve("t3");
    expect((await driver.listTabs()).tabs.map((t) => [t.id, t.current])).toEqual([
      ["t1", false],
      ["t2", false],
      ["t3", true],
      ["t4", false],
    ]);
    await expect(driver.closeTabs({ tabs: ["t1"] })).rejects.toThrow(/t1 is the tab the task started on/);
    await expect(driver.closeTabs({ tabs: ["t2", "t7"] })).rejects.toThrow(/unknown tab "t7"/);
    expect(chrome.tabs.byId.size).toBe(4);
    const r = await driver.closeTabs({ tabs: ["t3", "T2"] });
    expect(r.closed.sort()).toEqual(["t2", "t3"]);
    expect(r.tabs.map((t) => [t.id, t.current])).toEqual([
      ["t1", true],
      ["t4", false],
    ]);
    expect(chrome.tabs.byId.has(t3)).toBe(false);
    expect(chrome.debugger.attached.has(t3)).toBe(false);
    expect(await agent.tabId()).toBe(mainTab);
  });

  it("a closed current tab fails once, then the first tab is current again", async () => {
    await driver.openTabs({ urls: urls(1) });
    await driver.switchTab({ tab: "t2" });
    await chrome.tabs.remove(await agent.resolve("t2"));
    await expect(driver.readPage()).rejects.toThrow("tab t2 was closed; the current tab is now t1");
    expect((await driver.readPage()).url).toBe("https://mail.test/");
    await expect(driver.readPage({ tab: "t2" })).rejects.toThrow(/unknown tab "t2"/);
  });

  it("closes the tabs it opened when the run ends, but not the user's tab", async () => {
    await driver.openTabs({ urls: urls(3) });
    await driver.readPage({ tab: "t2" });
    await driver.switchTab({ tab: "t4" });
    expect(await driver.closeOpenedTabs()).toBe(3);
    expect([...chrome.tabs.byId.keys()]).toEqual([mainTab]);
    expect(await agent.tabId()).toBe(mainTab);
    expect(await agent.isAgentTab(mainTab)).toBe(true);
    await driver.ready();
    expect([...chrome.debugger.attached]).toEqual([mainTab]);
    expect(await driver.closeOpenedTabs()).toBe(0);
  });

  it("the next run closes tabs an interrupted run left open", async () => {
    await driver.openTabs({ urls: urls(2) });
    const left = await Promise.all(["t2", "t3"].map((t) => agent.resolve(t)));
    expect(await agent.isAgentTab(left[0]!)).toBe(true);
    await agent.prepare("own-tab");
    for (const id of left) expect(chrome.tabs.byId.has(id)).toBe(false);
    expect(chrome.tabs.byId.has(mainTab)).toBe(true);
  });

  it("is reachable through the browser caller used by the executor", async () => {
    const caller = createBrowserCaller(driver, { getCredential: async () => ({ found: false }) });
    const opened = await caller.call("browser.openTabs", { urls: urls(2) });
    expect(opened.tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect((await caller.call("browser.readPage", { tab: "t3" })).url).toBe("https://mail.test/m/2");
    expect((await caller.call("browser.readPage", {})).url).toBe("https://mail.test/");
    expect((await caller.call("browser.switchTab", { tab: "t2" })).id).toBe("t2");
    expect((await caller.call("browser.listTabs", {})).tabs).toHaveLength(3);
    expect((await caller.call("browser.closeTabs", { tabs: ["t2"] })).closed).toEqual(["t2"]);
  });
});

describe("Cdp with several tabs", () => {
  it("keeps several tabs attached and a user cancel ends all of them", async () => {
    let canceled = 0;
    cdp.onUserCancel = () => void canceled++;
    await cdp.attach(mainTab);
    const other = await chrome.tabs.create({ windowId, url: "https://b.test/", active: false });
    await cdp.sendTo(other.id, "Page.enable");
    expect(cdp.attachedTabs.sort()).toEqual([mainTab, other.id].sort());
    expect(cdp.attachedTabId).toBe(mainTab);
    // An unexpected detach of one tab: reattached on its next command.
    chrome.debugger.attached.delete(other.id);
    cdp.handleDetach({ tabId: other.id }, "target_closed");
    await cdp.sendTo(other.id, "Page.enable");
    expect(chrome.debugger.attached.has(other.id)).toBe(true);
    cdp.handleDetach({ tabId: other.id }, "canceled_by_user");
    expect(canceled).toBe(1);
    expect(cdp.attachedTabs).toEqual([]);
    await expect(cdp.sendTo(mainTab, "Page.enable")).rejects.toThrow("debugger detached by user");
  });

  it("attaches a tab once when it is read in parallel", async () => {
    let attaches = 0;
    const orig = chrome.debugger.attach;
    chrome.debugger.attach = async (t, v) => {
      attaches++;
      await new Promise((r) => setTimeout(r, 5));
      return orig(t, v);
    };
    await Promise.all([cdp.sendTo(mainTab, "A"), cdp.sendTo(mainTab, "B")]);
    expect(attaches).toBe(1);
  });
});
