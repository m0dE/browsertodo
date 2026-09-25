// Multi-tab check of the built extension in Playwright's Chromium: opens 5 local
// pages in parallel tabs, reads them all at once without activating them,
// switches, screenshots a background tab (left in the background), closes, and compares the wall time
// with the one-tab way (navigate + read_page, page after page).
// Usage: pnpm --filter @browsertodo/extension build && node apps/extension/test/multitab.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, sleep } from "../../../test/e2e/lib/suite.mjs";

const PAGES = 5;
/** Server latency per page, like a real site (Gmail takes far longer). */
const PAGE_DELAY_MS = 400;

const site = await serveHtml(async (path) => {
  const m = /^\/mail\/(\d+)/.exec(path);
  if (!m) {
    const links = Array.from({ length: PAGES }, (_, i) => `<li><a href="/mail/${i + 1}">Message ${i + 1}</a></li>`).join("");
    return `<!doctype html><title>Inbox</title><h1>Search results</h1><ul>${links}</ul>`;
  }
  await sleep(PAGE_DELAY_MS);
  const n = m[1];
  return `<!doctype html><title>Message ${n}</title><h1>Message ${n}</h1><p>Body of message ${n}: the invoice number is INV-${n}00.</p>
      <button onclick="document.title='clicked ${n}'">Reply</button>`;
});
const { base } = site;
const urls = Array.from({ length: PAGES }, (_, i) => `${base}/mail/${i + 1}`);

const { step, finish } = createSuite("multi-tab");
const ext = await launchExtension({ name: "multitab" });
const { context, sw } = ext;

try {
  const call = driverCall(sw);
  const evalSw = (fn, arg) => sw.evaluate(fn, arg);

  const userPage = await context.newPage();
  await userPage.goto(`${base}/`);
  await userPage.bringToFront();
  const mainTab = await evalSw(async () => {
    const id = await globalThis.__browsertodo.agentTab.prepare("current-tab");
    await globalThis.__browsertodo.driver.ready();
    return id;
  });
  const tabCount = () => evalSw(async () => (await chrome.tabs.query({})).length);
  const baseTabs = await tabCount();

  let sequentialMs = 0;
  await step(`sequential: navigate + read_page for ${PAGES} pages in one tab`, async () => {
    const t0 = Date.now();
    for (const url of urls) {
      await call("navigate", { url });
      const snap = await call("readPage");
      assert.match(snap.text, /the invoice number is INV-\d00/);
    }
    sequentialMs = Date.now() - t0;
    await call("navigate", { url: `${base}/` });
    return `${sequentialMs} ms`;
  });

  let parallelMs = 0;
  let opened;
  await step(`parallel: open_tabs(${PAGES}) + one multi-tab read`, async () => {
    const t0 = Date.now();
    opened = await call("openTabs", { urls });
    const snaps = await evalSw(
      (ids) => Promise.all(ids.map((tab) => globalThis.__browsertodo.driver.readPage({ tab }))),
      opened.tabs.map((t) => t.id),
    );
    parallelMs = Date.now() - t0;
    assert.deepEqual(
      opened.tabs.map((t) => [t.id, t.title, t.current, t.error ?? null]),
      urls.map((_, i) => [`t${i + 2}`, `Message ${i + 1}`, false, null]),
    );
    snaps.forEach((s, i) => assert.ok(s.text.includes(`INV-${i + 1}00`), `tab t${i + 2} text: ${s.text}`));
    return `${parallelMs} ms`;
  });

  await step("reading did not activate the tabs; all are in the browsertodo group; several tabs attached", async () => {
    const out = await evalSw(async (main) => {
      const bt = globalThis.__browsertodo;
      const ids = await bt.agentTab.tabIds();
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      const groups = await Promise.all(tabs.map((t) => (t.groupId === -1 ? null : chrome.tabGroups.get(t.groupId).then((g) => g.title))));
      return { mainActive: (await chrome.tabs.get(main)).active, active: tabs.filter((t) => t.active).map((t) => t.id), groups, attached: bt.cdp.attachedTabs.length, windows: new Set(tabs.map((t) => t.windowId)).size };
    }, mainTab);
    assert.equal(out.mainActive, true);
    assert.deepEqual(out.active, [mainTab]);
    assert.ok(out.groups.every((g) => g === "browsertodo"), JSON.stringify(out.groups));
    assert.equal(out.windows, 1, "all in the agent's window");
    assert.equal(out.attached, PAGES + 1);
    return `${out.attached} tabs attached, only the main tab active`;
  });

  await step("switch_tab: later calls act on that tab", async () => {
    const info = await call("switchTab", { tab: "t4" });
    assert.equal(info.id, "t4");
    assert.equal(info.title, "Message 3");
    const snap = await call("readPage");
    assert.ok(snap.text.includes("INV-300"));
    const reply = snap.elements.find((e) => e.name === "Reply");
    await call("click", { index: reply.index });
    assert.equal(await evalSw(async () => (await chrome.tabs.get(await globalThis.__browsertodo.agentTab.tabId())).title), "clicked 3");
    return "clicked Reply in t4";
  });

  await step("screenshot of a background current tab leaves it in the background", async () => {
    await userPage.bringToFront(); // the user looks at the main tab again
    await call("switchTab", { tab: "t5" });
    const before = await evalSw(async () => (await chrome.tabs.get(await globalThis.__browsertodo.agentTab.tabId())).active);
    const shot = await call("screenshot");
    const after = await evalSw(async () => (await chrome.tabs.get(await globalThis.__browsertodo.agentTab.tabId())).active);
    assert.equal(before, false);
    assert.equal(after, false, "the agent never brings its tab to the front");
    assert.ok(shot.base64.length > 1000, "non-empty image");
    return `${shot.base64.length} base64 chars`;
  });

  await step("close_tabs and list_tabs", async () => {
    const r = await call("closeTabs", { tabs: ["t2", "t5"] });
    assert.deepEqual(r.closed.sort(), ["t2", "t5"]);
    assert.deepEqual(r.tabs.map((t) => [t.id, t.current]), [["t1", true], ["t3", false], ["t4", false], ["t6", false]]);
    await assert.rejects(call("closeTabs", { tabs: ["t1"] }), /never closed/);
    assert.equal(await tabCount(), baseTabs + PAGES - 2);
    return "t2, t5 closed; current fell back to t1";
  });

  await step("run end closes the opened tabs but not the user's tab", async () => {
    const n = await evalSw(() => globalThis.__browsertodo.driver.closeOpenedTabs());
    assert.equal(n, PAGES - 2);
    assert.equal(await tabCount(), baseTabs);
    const main = await evalSw((id) => chrome.tabs.get(id).then((t) => t.url), mainTab);
    assert.equal(main, `${base}/`);
    const attached = await evalSw(async () => {
      await globalThis.__browsertodo.driver.ready();
      return globalThis.__browsertodo.cdp.attachedTabs;
    });
    assert.deepEqual(attached, [mainTab]);
    return "main tab kept, debugger only on it";
  });

  console.log(
    `\nTiming for ${PAGES} pages (${PAGE_DELAY_MS} ms server latency each):\n` +
      `  sequential navigate + read_page: ${sequentialMs} ms\n` +
      `  open_tabs + one multi-tab read:  ${parallelMs} ms` +
      (parallelMs ? `  (${(sequentialMs / parallelMs).toFixed(1)}x faster, and 2 tool calls instead of ${PAGES * 2})` : ""),
  );
} finally {
  await ext.close();
  await site.close();
}

finish();
