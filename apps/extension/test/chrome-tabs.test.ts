import { beforeEach, describe, expect, it } from "vitest";
import { installChromeFake, type ChromeFake } from "./chrome-fake.js";
import { addToGroup, removeAgentTabs, TAB_GROUP_TITLE } from "../src/chrome-tabs.js";

let chrome: ChromeFake;
let windowId: number;

beforeEach(async () => {
  chrome = installChromeFake();
  const win = await chrome.windows.create({ url: "https://news.test/", focused: true, type: "normal" });
  windowId = win.id;
});

const newTab = async () => (await chrome.tabs.create({ windowId, url: "about:blank", active: false })).id;
const groupOf = (tabId: number) => chrome.tabGroups.byId.get(chrome.tabs.byId.get(tabId)!.groupId);

describe("the agent's tab group", () => {
  it("is titled with the brand as users see it", async () => {
    const tab = await newTab();
    await addToGroup(tab);
    expect(TAB_GROUP_TITLE).toBe("BrowserTODO");
    expect(groupOf(tab)?.title).toBe("BrowserTODO");
  });

  it("finds a group made by an older version (titled 'browsertodo'), joins it and retitles it", async () => {
    const old = await newTab();
    const groupId = await chrome.tabs.group({ tabIds: [old], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: "browsertodo" });

    const tab = await newTab();
    await addToGroup(tab);

    expect(groupOf(tab)?.id).toBe(groupId);
    expect(groupOf(tab)?.title).toBe("BrowserTODO");
    expect(chrome.tabGroups.byId.size).toBe(1);
  });

  it("still closes agent tabs left in an older version's group", async () => {
    const old = await newTab();
    const groupId = await chrome.tabs.group({ tabIds: [old], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: "browsertodo" });

    expect(await removeAgentTabs([old])).toBe(1);
  });
});
