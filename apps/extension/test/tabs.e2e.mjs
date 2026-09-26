// A chat per browser tab, in the built extension in Playwright's Chromium: one-off runs
// started from two tabs run at the same time, each acting on its own tab (even after the
// user switched away), the side panel's chat follows the active tab, a chat whose tab shows
// a chrome:// page moves to a new tab, and closing a chat's tab stops its run.
// The brain is a scripted fake installed in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/tabs.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { launchExtension, openPanelWithTabs, pageUi, sessionOf, sessionWhen } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

// /a, /b, /c: a page with a Count button (the fake agent clicks it) and its own title.
const site = await serveHtml((path) => {
  const name = path.slice(1) || "home";
  return `<!doctype html><title>Page ${name}</title><h1>Page ${name}</h1>
<button onclick="document.getElementById('n').textContent = String(++window.clicks)">Count</button>
<p>Clicks: <span id="n">0</span></p><script>window.clicks = 0;</script>`;
});
const { base } = site;

const { step, finish } = createSuite("tab");
const ext = await launchExtension({ name: "tabs" });
const { context, sw } = ext;

try {
  // The fake brain: each run waits for its gate, then reads its tab and clicks Count there.
  const fake = await installFakeBrain(sw, {
    gated: true,
    makeAct: () => {
      const log = (globalThis.__turns = []);
      return async ({ browser }, name) => {
        const snap = await browser.call("browser.readPage", {});
        const btn = snap.elements.find((e) => e.name === "Count");
        await browser.call("browser.click", { index: btn.index });
        log.push({ name, url: snap.url });
        return `clicked on ${snap.title}`;
      };
    },
  });
  const bindings = () => sw.evaluate(() => globalThis.__browsertodo.tabChats.all());

  // The side panel page as a background tab of the same window, so it follows that window's active tab.
  const {
    panel,
    pages: [pageA, pageB],
    ids: {
      panel: panelTab,
      tabs: [tabA, tabB],
      windowId,
    },
  } = await openPanelWithTabs(ext, [`${base}/a`, `${base}/b`]);
  const ui = pageUi(panel);
  const activate = (tabId) => sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), tabId);
  const panelView = () =>
    panel.evaluate(() => ({
      // The chat's first message: the prompt that opened it.
      title: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent ?? null,
      empty: !!document.querySelector("#chat-log .chat-empty"),
      chips: [...document.querySelectorAll("#chat-switch:not([hidden]) .act-chip")].map((c) => c.textContent.trim()),
    }));
  const clicks = (page) => page.evaluate(() => window.clicks);
  const turnEnded = (sessionId, turns, what) => sessionWhen(sw, sessionId, what, { until: (s) => s.turns === turns && s.endedAt });

  let a;
  let b;
  await step("tab A: a new chat, then a one-off started there is bound to it", async () => {
    await activate(tabA);
    await waitFor(async () => (await panelView()).empty, "tab A's empty chat");
    a = await ui({ type: "run.adhoc", instructions: "task A", tabId: tabA });
    assert.equal((await bindings())[tabA], a.sessionId);
    await waitFor(async () => (await panelView()).title === "task A", "the panel showing task A");
    return `session ${a.sessionId} in tab ${tabA}`;
  });

  await step("switching to tab B shows B's (empty) chat with a chip for A's running chat", async () => {
    await activate(tabB);
    const v = await waitFor(async () => {
      const x = await panelView();
      return x.empty && x.chips.length === 1 ? x : null;
    }, "tab B's empty chat");
    assert.deepEqual(v.chips, ["task A"]);
    return JSON.stringify(v);
  });

  await step("tab B runs its own chat at the same time; each acts on its own tab", async () => {
    b = await ui({ type: "run.adhoc", instructions: "task B", tabId: tabB });
    await waitFor(async () => (await panelView()).title === "task B", "the panel showing task B");
    const running = await ui({ type: "state.get" });
    assert.deepEqual(running.runningSessions.map((s) => s.title).sort(), ["task A", "task B"]);
    assert.deepEqual(running.runningTabs[a.sessionId], [tabA]);
    assert.deepEqual(running.runningTabs[b.sessionId], [tabB]);
    // The user is on tab B; A's agent still acts on tab A.
    await fake.release("task A");
    await fake.release("task B");
    await waitFor(async () => (await sessionOf(sw, a.sessionId))?.outcome === "done" && (await sessionOf(sw, b.sessionId))?.outcome === "done", "both runs to end");
    const log = await sw.evaluate(() => globalThis.__turns);
    assert.equal(log.find((l) => l.name === "task A").url, `${base}/a`);
    assert.equal(log.find((l) => l.name === "task B").url, `${base}/b`);
    assert.equal(await clicks(pageA), 1);
    assert.equal(await clicks(pageB), 1);
    assert.equal((await sessionOf(sw, a.sessionId)).summary, "clicked on Page a");
    return "A clicked on /a, B on /b";
  });

  await step("the panel's chat follows the active tab", async () => {
    await activate(tabA);
    await waitFor(async () => (await panelView()).title === "task A", "tab A's chat");
    await activate(tabB);
    await waitFor(async () => (await panelView()).title === "task B", "tab B's chat");
    await activate(panelTab);
    await waitFor(async () => (await panelView()).empty, "a tab without a chat");
    return "A -> task A, B -> task B, other -> new chat";
  });

  await step("the next message in tab A's chat acts on tab A again", async () => {
    await activate(tabB);
    // Sent from tab A's panel (the composer names its tab), while the user looks at B.
    const r = await ui({ type: "run.message", sessionId: a.sessionId, text: "again A", tabId: tabA });
    assert.equal(r.mode, "turn");
    await fake.release("again A");
    await waitFor(async () => (await clicks(pageA)) === 2, "a second click on tab A");
    assert.equal(await clicks(pageB), 1);
    await turnEnded(a.sessionId, 2, "turn 2 to end");
    return "clicks: A 2, B 1";
  });

  await step("New Chat in tab B clears only B's chat; Open in Chat binds it to the current tab", async () => {
    await ui({ type: "run.newChat", sessionId: b.sessionId, tabId: tabB });
    let map = await bindings();
    assert.equal(map[tabB], undefined);
    assert.equal(map[tabA], a.sessionId);
    await waitFor(async () => (await panelView()).empty, "tab B's new chat");
    const st = await ui({ type: "chat.bind", sessionId: b.sessionId, tabId: tabB });
    assert.equal(st.tabChats[tabB], b.sessionId);
    await waitFor(async () => (await panelView()).title === "task B", "task B back in tab B");
    map = await bindings();
    return JSON.stringify(map);
  });

  await step("the Activity Log: clicking a past run opens that conversation in Chat, bound to the active tab", async () => {
    await ui({ type: "run.newChat", sessionId: b.sessionId, tabId: tabB });
    await waitFor(async () => (await panelView()).empty, "tab B's new chat");
    await panel.click("#tab-btn-history");
    const row = panel.locator(`.sessions li button[data-id="${b.sessionId}"]`);
    await row.waitFor();
    await row.click();
    const shown = await waitFor(
      () =>
        panel.evaluate(() => ({
          tab: document.querySelector(".tabs [aria-selected=true]")?.id,
          title: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent,
          ends: document.querySelectorAll("#chat-log .ev-end").length,
          readOnlyView: !!document.getElementById("hist-past"),
        })).then((v) => (v.tab === "tab-btn-chat" && v.title === "task B" && v.ends > 0 ? v : null)),
      "task B in Chat",
    );
    assert.equal(shown.readOnlyView, false, "no read-only run view any more");
    assert.equal((await bindings())[tabB], b.sessionId, "bound to the active tab");
    return JSON.stringify(shown);
  });

  await step("a chat whose tab shows a chrome:// page moves to a new tab, and the panel follows it", async () => {
    const pageC = await context.newPage();
    await pageC.goto(`${base}/c`);
    const c = await sw.evaluate(async ([u, w]) => {
      const [t] = await chrome.tabs.query({ url: u });
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
      await chrome.tabs.update(t.id, { active: true });
      return t.id;
    }, [`${base}/c`, windowId]);
    const s = await ui({ type: "run.adhoc", instructions: "task C", tabId: c });
    await fake.release("task C");
    await sessionWhen(sw, s.sessionId, "task C", { until: (x) => x.outcome === "done" });
    // The tab now shows a browser page; the next turn cannot act there.
    await sw.evaluate(async (t) => void (await chrome.tabs.update(t, { url: "chrome://version/" })), c);
    await waitFor(() => sw.evaluate(async (t) => (await chrome.tabs.get(t)).url.startsWith("chrome://"), c), "chrome://version");
    await ui({ type: "run.message", sessionId: s.sessionId, text: "again C", tabId: c });
    const moved = await waitFor(async () => {
      const m = await bindings();
      const tab = Object.keys(m).find((k) => m[k] === s.sessionId);
      return tab && Number(tab) !== c ? Number(tab) : null;
    }, "the chat to move to a new tab");
    const info = await sw.evaluate(async ([n, old]) => [await chrome.tabs.get(n), await chrome.tabs.get(old)], [moved, c]);
    assert.equal(info[0].active, true);
    assert.equal(info[0].index, info[1].index + 1, "right after the old tab");
    await waitFor(async () => (await panelView()).title === "task C", "the panel following the new tab");
    await fake.release("again C");
    await turnEnded(s.sessionId, 2, "turn 2 of task C");
    return `tab ${c} (chrome://version) -> tab ${moved}`;
  });

  await step("closing a chat's tab while it runs stops it (paused); the session stays", async () => {
    const pageD = await context.newPage();
    await pageD.goto(`${base}/d`);
    const d = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/d`);
    const s = await ui({ type: "run.adhoc", instructions: "task D", tabId: d });
    await fake.started("task D");
    await pageD.close();
    const ended = await sessionWhen(sw, s.sessionId, "task D to stop");
    assert.equal(ended.outcome, "paused");
    assert.equal(ended.reason, "The tab was closed");
    assert.equal((await bindings())[d], undefined);
    const { sessions } = await ui({ type: "sessions.list" });
    assert.ok(sessions.some((x) => x.sessionId === s.sessionId), "still in the Activity Log");
    return `${ended.outcome}: ${ended.reason}`;
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
