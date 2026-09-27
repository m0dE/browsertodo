/** Each tab's own side panel: its page's address, and the tabs with an open panel kept across worker restarts. */
import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { panelPath, panelTabOf, StoredPanelTabs } from "../src/panel-tabs.js";

describe("a tab's panel page", () => {
  it("names its tab, and the page knows it from its address", () => {
    expect(panelPath(42)).toBe("sidepanel.html?tab=42");
    expect(panelTabOf(new URL(`chrome-extension://x/${panelPath(42)}`).search)).toBe(42);
  });

  it("the page opened as a tab (no tab named, or nonsense) is not a tab's panel", () => {
    expect(panelTabOf("")).toBeNull();
    expect(panelTabOf("?tab=")).toBeNull();
    expect(panelTabOf("?tab=abc")).toBeNull();
    expect(panelTabOf("?tab=-1")).toBeNull();
    expect(panelTabOf("?tab=1.5")).toBeNull();
    expect(panelTabOf("#opener")).toBeNull();
  });
});

describe("StoredPanelTabs: the tabs with an open panel", () => {
  let chrome: ChromeFake;
  beforeEach(() => {
    chrome = installChromeFake();
  });
  const stored = async () => (await chrome.storage.session.get("panelTabs")).panelTabs;

  it("kept in chrome.storage.session, so a restarted service worker knows them", async () => {
    const tabs = new StoredPanelTabs({ exists: async () => true });
    await tabs.ready;
    tabs.add(7);
    tabs.add(8);
    tabs.delete(7);
    await new Promise((r) => setTimeout(r, 0));
    expect(await stored()).toEqual([8]);
    // The worker restarts.
    const again = new StoredPanelTabs({ exists: async () => true });
    expect(again.has(8)).toBe(false);
    await again.ready;
    expect(again.has(8)).toBe(true);
    expect(again.has(7)).toBe(false);
  });

  it("drops tabs closed while the worker was not running", async () => {
    await chrome.storage.session.set({ panelTabs: [1, 2, "x"] });
    const tabs = new StoredPanelTabs({ exists: async (t) => t === 2 });
    await tabs.ready;
    expect([tabs.has(1), tabs.has(2)]).toEqual([false, true]);
    expect(await stored()).toEqual([2]);
  });

  it("changes made before the stored tabs were read are kept (a panel opened or closed right at wake-up)", async () => {
    await chrome.storage.session.set({ panelTabs: [1, 2] });
    const tabs = new StoredPanelTabs({ exists: async () => true });
    tabs.add(3);
    tabs.delete(1);
    await tabs.ready;
    expect([1, 2, 3].map((t) => tabs.has(t))).toEqual([false, true, true]);
    expect([...((await stored()) as number[])].sort()).toEqual([2, 3]);
  });
});
