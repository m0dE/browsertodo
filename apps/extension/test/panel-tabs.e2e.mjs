// The side panel is per tab, in the built extension in a HEADED Playwright Chromium (a real window: tab visibility
// and keyboard focus are real). Owner's request: "if i have the extension enabled in one tab, if i switch to another
// tab, it shouldn't show the extension".
//
// Checked: the toolbar button opens the panel of the tab it is clicked in; another tab shows no panel; back on the
// tab its panel shows again, the same page (state kept); the toolbar button closes it and it stays off there; the
// shortcut (Ctrl+.) in another tab opens that tab's own panel with the focus in its input and recreates only that
// tab's panel; closing a tab's panel disables it for the tab; a restarted service worker still knows the tabs with a
// panel; a closed tab is forgotten; a chat started from the panel of a tab showing a chrome:// page goes on in a tab
// in the background while the panel keeps showing it.
//
// The toolbar button is clicked with CDP's Extensions.triggerAction; the shortcut is pressed through shortcutPresser
// (see test/e2e/lib/extension.mjs). The real side panels are read through chrome.extension.getViews() from an
// extension tab. No OS-level keystrokes are sent.
// Usage: pnpm build && node apps/extension/test/panel-tabs.e2e.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchExtension, routerUi, shortcutPresser } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

const REPLY = "Done in the agent's tab";
const site = await serveHtml(() => `<!doctype html><title>Web page</title><body><input id="q" placeholder="a field in the page"></body>`);
const { step, finish } = createSuite("panel-tabs");
// The DevTools port: a click in a real side panel (not a Playwright page) is sent over its own CDP target.
const ext = await launchExtension({ name: "panel-tabs", headed: true, args: ["--remote-debugging-port=0"] });
const { context, extensionId } = ext;
let sw = ext.sw;
const isOurWorker = (w) => w.url().endsWith("/background.js");

try {
  const A = `${site.base}/?a`;
  const B = `${site.base}/?b`;
  const HOST = `chrome-extension://${extensionId}/mic-permission.html`;
  const cdp = await context.browser().newBrowserCDPSession();
  const tabOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0], url);

  const pageA = await context.newPage();
  await pageA.goto(A);
  const pageB = await context.newPage();
  await pageB.goto(B);
  // The probe's extension tab, in the same window, behind the others.
  const host = await context.newPage();
  await host.goto(HOST);
  const { id: tabA, windowId } = await tabOf(A);
  const { id: tabB } = await tabOf(B);
  await sw.evaluate(async ([u, w]) => {
    const [t] = await chrome.tabs.query({ url: u });
    if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: 0 });
  }, [HOST, windowId]);

  /** Every side panel page: its tab (from its address), whether it shows, its focus, the box, the chat, a mark. */
  const panels = () =>
    host.evaluate(() =>
      chrome.extension
        .getViews()
        .filter((v) => v.location.pathname === "/sidepanel.html" && v.location.search)
        .map((v) => {
          const d = v.document;
          return {
            tab: Number(new URLSearchParams(v.location.search).get("tab")),
            visible: d.visibilityState === "visible",
            hasFocus: d.hasFocus(),
            active: d.activeElement?.id || d.activeElement?.tagName,
            draft: d.getElementById("now-text").value,
            chat: d.getElementById("chat-log").textContent,
            mark: v.__mark ?? null,
            agentTab: d.querySelector("#job-agent-tab:not([hidden]) .job-tab-name")?.textContent ?? null,
          };
        }),
    );
  const panelOf = async (tab) => (await panels()).find((p) => p.tab === tab) ?? null;
  /** Runs `what` in tab `tab`'s panel page. */
  const inPanel = (tab, what, arg) =>
    host.evaluate(
      ([tab, what, arg]) => {
        const v = chrome.extension.getViews().find((x) => x.location.pathname === "/sidepanel.html" && new URLSearchParams(x.location.search).get("tab") === String(tab));
        if (!v) throw new Error(`no side panel for tab ${tab}`);
        const d = v.document;
        if (what === "mark") v.__mark = arg;
        else if (what === "type") {
          const t = d.getElementById("now-text");
          t.value = arg;
          t.dispatchEvent(new v.Event("input", { bubbles: true }));
        } else if (what === "send") {
          const t = d.getElementById("now-text");
          t.value = arg;
          t.dispatchEvent(new v.Event("input", { bubbles: true }));
          d.getElementById("now-form").requestSubmit();
        } else if (what === "close") v.close();
        return true;
      },
      [tab, what, arg],
    );
  const options = (tab) => sw.evaluate((t) => chrome.sidePanel.getOptions({ tabId: t }), tab);
  const remembered = () => sw.evaluate(async () => (await chrome.storage.session.get("panelTabs")).panelTabs ?? []);
  const activate = async (page, tab) => {
    await sw.evaluate((t) => chrome.tabs.update(t, { active: true }), tab);
    await page.bringToFront();
  };
  const clickToolbar = async (url) => {
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const t = targetInfos.find((x) => x.url === url);
    await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: t.targetId });
  };
  const panelShows = (tab, what) => waitFor(async () => ((await panelOf(tab))?.visible ? panelOf(tab) : null), what);

  await step("there is no window-wide panel: the default is off, and a tab has none until opened there", async () => {
    const def = await sw.evaluate(() => chrome.sidePanel.getOptions({}));
    assert.equal(def.enabled, false);
    assert.equal(def.path, undefined, "the manifest names no default page");
    assert.equal((await options(tabA)).enabled, false);
    return JSON.stringify(def);
  });

  await activate(pageA, tabA);
  await step("the toolbar button in tab A opens A's own panel, with the focus in its input", async () => {
    await clickToolbar(A);
    const p = await panelShows(tabA, "A's panel to show");
    await waitFor(async () => (await panelOf(tabA))?.hasFocus, "A's panel to have the focus");
    assert.deepEqual(await options(tabA), { enabled: true, path: `sidepanel.html?tab=${tabA}`, tabId: tabA });
    await waitFor(async () => (await remembered()).includes(tabA), "tab A remembered in chrome.storage.session");
    return JSON.stringify({ tab: p.tab, visible: p.visible });
  });

  await step("switching to tab B: no panel shows (A's is hidden, B has none)", async () => {
    await inPanel(tabA, "mark", "A-page");
    await inPanel(tabA, "type", "A's draft");
    await activate(pageB, tabB);
    await waitFor(async () => (await panelOf(tabA))?.visible === false, "A's panel to hide");
    assert.equal(await panelOf(tabB), null);
    assert.equal((await panels()).filter((p) => p.visible).length, 0);
    assert.equal((await options(tabB)).enabled, false);
    return JSON.stringify(await panels());
  });

  await step("back to tab A: its panel shows again, the same page with its text", async () => {
    await activate(pageA, tabA);
    const p = await panelShows(tabA, "A's panel to show again");
    assert.equal(p.mark, "A-page", "the same page");
    assert.equal(p.draft, "A's draft");
    return JSON.stringify({ mark: p.mark, draft: p.draft });
  });

  await step("the toolbar button in A again closes A's panel (Chrome's toggle), and A's panel stays off", async () => {
    await clickToolbar(A);
    await waitFor(async () => (await panelOf(tabA)) === null, "A's panel to close");
    await waitFor(async () => (await options(tabA)).enabled === false, "A's panel to be disabled");
    await waitFor(async () => !(await remembered()).includes(tabA), "tab A forgotten");
    await activate(pageB, tabB);
    await activate(pageA, tabA);
    assert.equal(await panelOf(tabA), null, "not back after switching away and back");
    // Clicked again: open (action.onClicked, since the tab has no panel now).
    await clickToolbar(A);
    await panelShows(tabA, "A's panel to open again");
    return "closed, stayed off, opened again";
  });

  const press = await shortcutPresser({ context, sw, extensionId });
  await step("Ctrl+. in tab B opens B's own panel with the real focus in its input; A's panel is left as it is", async () => {
    await inPanel(tabA, "mark", "A-page-2");
    await activate(pageB, tabB);
    assert.equal(await press(B), "opened");
    const p = await waitFor(async () => {
      const b = await panelOf(tabB);
      return b?.visible && b.hasFocus && b.active === "now-text" ? b : null;
    }, "B's panel input to have the focus", { timeout: 5000 });
    const a = await panelOf(tabA);
    assert.equal(a.visible, false);
    assert.equal(a.mark, "A-page-2", "A's page not recreated");
    return JSON.stringify({ b: { visible: p.visible, active: p.active }, a: { visible: a.visible } });
  });

  await step("Ctrl+. with the focus in B's page recreates only B's panel (focus and text back), A's stays", async () => {
    await inPanel(tabB, "mark", "B-page");
    await inPanel(tabB, "type", "B's draft");
    await pageB.bringToFront();
    await pageB.click("#q");
    await waitFor(async () => (await panelOf(tabB))?.hasFocus === false, "B's panel to lose the focus to the page");
    assert.equal(await press(B), "reopened");
    const p = await waitFor(async () => {
      const b = await panelOf(tabB);
      return b?.hasFocus && b.mark === null && b.draft === "B's draft" ? b : null;
    }, "B's new panel with the focus and its text", { timeout: 5000 });
    assert.equal((await panelOf(tabA))?.mark, "A-page-2", "A's page untouched");
    return JSON.stringify({ active: p.active, draft: p.draft });
  });

  await step("closing A's panel (as its close button does) disables it for tab A only", async () => {
    await activate(pageA, tabA);
    await panelShows(tabA, "A's panel to show");
    await inPanel(tabA, "close");
    await waitFor(async () => (await panelOf(tabA)) === null, "A's panel to close");
    await waitFor(async () => (await options(tabA)).enabled === false, "A's panel disabled");
    assert.equal((await options(tabB)).enabled, true, "B keeps its panel");
    await waitFor(async () => {
      const r = await remembered();
      return !r.includes(tabA) && r.includes(tabB);
    }, "A forgotten, B remembered");
    await activate(pageB, tabB);
    await panelShows(tabB, "B's panel to show");
    await activate(pageA, tabA);
    assert.equal(await panelOf(tabA), null);
    return JSON.stringify(await remembered());
  });

  await step("a restarted service worker still knows B's panel: Ctrl+. there recreates it with the focus", async () => {
    await activate(pageB, tabB);
    await panelShows(tabB, "B's panel to show");
    await sw.evaluate(() => (globalThis.__before = true));
    // The worker is ended (as Chrome ends an idle one); B's panel reconnects (port.ts), which starts it again.
    // Playwright keeps the same handle for the new worker; evaluating in the dead one hangs, hence the time limit.
    const { targetInfos } = await cdp.send("Target.getTargets");
    const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/background.js"));
    await cdp.send("Target.closeTarget", { targetId: worker.targetId });
    const inTime = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 1000))]);
    sw = await waitFor(async () => {
      const w = context.serviceWorkers().find(isOurWorker);
      const fresh = w && (await inTime(w.evaluate(() => !!globalThis.__browsertodo && !globalThis.__before).catch(() => false)));
      return fresh ? w : null;
    }, "a new service worker to run", { timeout: 20_000 });
    await sw.evaluate(() => globalThis.__browsertodo.panelTabs.ready);
    // Read back from chrome.storage.session, not from a hello.
    assert.equal(await sw.evaluate((t) => globalThis.__browsertodo.panelTabs.has(t), tabB), true);
    assert.equal(await sw.evaluate((t) => globalThis.__browsertodo.panelCommands.hasPanel(t), tabB), true);
    await waitFor(() => sw.evaluate((w) => globalThis.__browsertodo.panelCommands.isOpen(w), windowId), "B's panel to say hello again");
    const again = await shortcutPresser({ context, sw, extensionId });
    await pageB.bringToFront();
    await pageB.click("#q");
    await waitFor(async () => (await panelOf(tabB))?.hasFocus === false, "B's panel to lose the focus to the page");
    assert.equal(await again(B), "reopened");
    await waitFor(async () => {
      const b = await panelOf(tabB);
      return b?.hasFocus && b.active === "now-text" ? b : null;
    }, "B's panel input to have the focus", { timeout: 5000 });
    return "remembered; recreated with the focus";
  });

  await step("a chat started in the panel of a tab showing a chrome:// page goes on in a background tab; the panel keeps it", async () => {
    await installFakeBrain(sw, { makeAct: (reply) => async () => reply, arg: REPLY });
    const ui = routerUi(sw);
    const page = await context.newPage();
    await page.goto("chrome://version/");
    const { id: tabC } = await tabOf("chrome://version/");
    await sw.evaluate(async ([t, w]) => {
      const tab = await chrome.tabs.get(t);
      if (tab.windowId !== w) await chrome.tabs.move(t, { windowId: w, index: -1 });
      await chrome.tabs.update(t, { active: true });
    }, [tabC, windowId]);
    await page.bringToFront();
    await clickToolbar("chrome://version/");
    await panelShows(tabC, "the chrome:// tab's panel to show");
    const tabsBefore = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
    await inPanel(tabC, "send", "Say hello");
    const moved = await waitFor(async () => {
      const chats = (await ui({ type: "state.get" })).tabChats ?? {};
      const [tab] = Object.entries(chats).find(([t]) => Number(t) !== tabC) ?? [];
      return tab ? Number(tab) : null;
    }, "the chat to go on in a new tab");
    await waitFor(async () => (await panelOf(tabC))?.chat.includes(REPLY), "the reply in the chrome:// tab's panel");
    const active = await sw.evaluate(async (w) => (await chrome.tabs.query({ active: true, windowId: w }))[0].id, windowId);
    assert.equal(active, tabC, "the user stays on the tab with the panel");
    assert.equal((await panelOf(tabC)).visible, true);
    // The panel names the tab the chat went on in, to watch it there (the user is not on it).
    const row = await waitFor(async () => (await panelOf(tabC))?.agentTab, "the agent's tab row in the chrome:// tab's panel");
    // A second message from that panel goes to the same chat, in the same agent tab (no new tab each time).
    await inPanel(tabC, "send", "Again");
    await waitFor(async () => ((await panelOf(tabC))?.chat.match(new RegExp(REPLY, "g")) ?? []).length >= 2, "the second reply in the panel");
    const tabsAfter = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
    assert.equal(tabsAfter, tabsBefore + 1, "one agent tab");
    return `chat in tab ${moved}; the panel of tab ${tabC} shows both replies and the agent's tab ("${row}"); the user stayed on ${tabC}`;
  });

  await step("another tab's running job, opened in B's panel: the row under its header names the agent's tab, and View brings that tab to the front, with its own panel open on that job", async () => {
    const fake = await installFakeBrain(sw, { gated: true, makeAct: (reply) => async () => reply, arg: REPLY });
    const ui = routerUi(sw);
    const { sessionId } = await ui({ type: "run.adhoc", instructions: "Wait in A", tabId: tabA });
    await fake.started("Wait in A");
    await activate(pageB, tabB);
    await panelShows(tabB, "B's panel to show");
    // B's list has A's running job: opened, its page shows the agent's tab (A's page title), with View.
    await waitFor(() => host.evaluate(([id, key]) => {
      const v = chrome.extension.getViews().find((x) => x.location.search === `?tab=${id}`);
      const row = v?.document.querySelector(`.job-row[data-key="${key}"]`);
      row?.click();
      return v?.document.querySelector("#job-agent-tab:not([hidden]) .job-tab-name")?.textContent === "Web page";
    }, [tabB, `chat:${sessionId}`]), "A's running job in B's panel, with the agent's tab and View");
    // The user's click in the real side panel: a trusted gesture there (sidePanel.open needs one).
    const port = Number(readFileSync(join(ext.profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.url.endsWith(`/sidepanel.html?tab=${tabB}`));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    const answered = new Promise((resolve) => (ws.onmessage = (m) => resolve(JSON.parse(m.data))));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `document.querySelector("#job-agent-tab button").click()`, userGesture: true } }));
    await answered;
    ws.close();
    const p = await panelShows(tabA, "A's own panel to open and show");
    const active = await sw.evaluate(async (w) => (await chrome.tabs.query({ active: true, windowId: w }))[0].id, windowId);
    assert.equal(active, tabA, "tab A in front");
    // A's panel opens on the job working in its tab.
    await waitFor(async () => (await panelOf(tabA))?.chat.includes("Wait in A"), "A's job in A's panel");
    await fake.release("Wait in A");
    await waitFor(async () => (await ui({ type: "state.get" })).runningSessions.every((s) => s.sessionId !== sessionId), "the run to end");
    return JSON.stringify({ tab: p.tab, visible: p.visible });
  });

  await step("closing tab B forgets its panel", async () => {
    await pageB.close();
    await waitFor(async () => !(await remembered()).includes(tabB), "tab B forgotten");
    assert.equal(await sw.evaluate((t) => globalThis.__browsertodo.panelCommands.hasPanel(t), tabB), false);
    return JSON.stringify(await remembered());
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
