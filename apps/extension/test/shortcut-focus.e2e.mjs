// The keyboard shortcut (Ctrl+.) must put the real keyboard focus in the side panel's chat input, also when the
// panel is ALREADY open and the focus is in the web page, in the built extension in a HEADED Playwright Chromium
// (a real window, so focus is real). The voice shortcut (Ctrl+,) goes the same way, then starts voice input.
//
// Owner's report: "a lot of the time when the extension is already open, when I press ctrl+. it doesn't focus the
// input field." Chrome gives a side panel the keyboard focus only when it creates the panel's page, so with the
// focus in the page the shortcut recreates the panels (see panel-command.ts); the chat, the text in the box and
// other windows' panels must survive that.
//
// The shortcut is pressed through shortcutPresser: the command handler in a real user gesture of the service
// worker (CDP Extensions.triggerAction -> action.onClicked, dispatched like chrome.commands.onCommand), since
// Playwright key presses do not reach Chrome's extension shortcuts. The real side panel is not a Playwright page:
// it is read through chrome.extension.getViews() from an extension tab (same extension process).
//
// No OS-level keystrokes are sent. Usage: pnpm build && node apps/extension/test/shortcut-focus.e2e.mjs
import assert from "node:assert/strict";
import { launchExtension, routerUi, sessionWhen, shortcutPresser } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite, waitFor } from "../../../test/e2e/lib/suite.mjs";

const TASK = "Say hello";
/** The scripted agent's answer: the chat shows it. */
const REPLY = "Hello from the scripted agent";
const DRAFT = "half a message";
const site = await serveHtml(() => `<!doctype html><title>Web page</title><body><input id="q" placeholder="a field in the page"></body>`);
const { step, finish } = createSuite("shortcut-focus");
// Headed on purpose: keyboard focus between the page and the side panel is only real in a real window.
const ext = await launchExtension({ name: "shortcut-focus", headed: true });
const { context, sw, extensionId } = ext;

try {
  const WEB = `${site.base}/`;
  const WEB2 = `${site.base}/?window=2`;
  const HOST = `chrome-extension://${extensionId}/mic-permission.html`;
  const press = await shortcutPresser(ext);
  const pc = (fn, ...args) => sw.evaluate(([fn, args]) => globalThis.__browsertodo.panelCommands[fn](...args), [fn, args]);
  const tabOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0], url);

  const web = await context.newPage();
  await web.goto(WEB);
  // The probe's extension tab, in the web page's window, behind the web page.
  const host = await context.newPage();
  await host.goto(HOST);
  const { id: webTab, windowId } = await tabOf(WEB);
  await sw.evaluate(async ([u, w]) => {
    const [t] = await chrome.tabs.query({ url: u });
    if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: 0 });
  }, [HOST, windowId]);

  /** The real side panel of `w`: its page's focus, the focused element, the selected tab, the box, the chat, a mark. */
  const panelOf = (w = windowId) =>
    host.evaluate(async (w) => {
      for (const v of chrome.extension.getViews()) {
        if (v.location.pathname !== "/sidepanel.html") continue;
        if ((await v.chrome.windows.getCurrent()).id !== w) continue;
        const d = v.document;
        return {
          hasFocus: d.hasFocus(),
          active: d.activeElement?.id || d.activeElement?.tagName,
          tab: d.querySelector("[role=tab][aria-selected=true]")?.id,
          draft: d.getElementById("now-text").value,
          chat: d.getElementById("chat-log").textContent,
          voice: d.querySelector(".voice-mic")?.dataset.state ?? null,
          tip: d.querySelector(".voice-tip:not([hidden])")?.textContent ?? null,
          mark: v.__mark ?? null,
        };
      }
      return null;
    }, w);
  /** Runs `what` in the real side panel of `w`. */
  const inPanel = (what, arg, w = windowId) =>
    host.evaluate(
      async ([what, arg, w]) => {
        for (const v of chrome.extension.getViews()) {
          if (v.location.pathname !== "/sidepanel.html" || (await v.chrome.windows.getCurrent()).id !== w) continue;
          const d = v.document;
          if (what === "activity-log") {
            d.getElementById("tab-btn-history").click();
            d.getElementById("tab-btn-history").focus();
          } else if (what === "type") {
            const t = d.getElementById("now-text");
            t.value = arg;
            t.dispatchEvent(new v.Event("input", { bubbles: true }));
          } else if (what === "mark") {
            v.__mark = arg;
          }
          return true;
        }
        throw new Error(`no side panel in window ${w}`);
      },
      [what, arg, w],
    );
  /** The user clicks into the web page: the keyboard focus leaves the panel. */
  const userClicksIntoPage = async () => {
    await web.bringToFront();
    await web.click("#q");
    await waitFor(async () => (await panelOf())?.hasFocus === false, "the panel to lose the focus to the page");
  };
  /** The panel's input has the real keyboard focus, in Chat. */
  const inputHasRealFocus = async (what, w = windowId) => {
    const t0 = Date.now();
    const got = await waitFor(
      async () => {
        const f = await panelOf(w);
        return f?.hasFocus && f.active === "now-text" && f.tab === "tab-btn-chat" ? f : null;
      },
      what,
      { timeout: 3000 },
    ).catch(() => null);
    const f = await panelOf(w);
    assert.ok(got, `${what}: panel ${JSON.stringify(f)} (expected hasFocus=true, active=now-text, tab=tab-btn-chat)`);
    return { panel: got, ms: Date.now() - t0 };
  };

  // A conversation of the web tab (a scripted brain), so there is a chat to keep.
  await installFakeBrain(sw, { makeAct: (reply) => async () => reply, arg: REPLY });
  const ui = routerUi(sw);
  const { sessionId } = await ui({ type: "run.adhoc", instructions: TASK, tabId: webTab });
  await sessionWhen(sw, sessionId, "the web tab's run to end");
  await web.bringToFront();

  await step("no panel open: the shortcut opens it with the real keyboard focus in the input", async () => {
    assert.equal(await press(WEB), "opened");
    const { panel, ms } = await inputHasRealFocus("the new panel's input to have the focus");
    await waitFor(async () => (await panelOf()).chat.includes(REPLY), "the web tab's chat in the panel");
    return `focused ${ms} ms after the handler; ${JSON.stringify({ hasFocus: panel.hasFocus, active: panel.active })}`;
  });

  await step("focus in the panel (on the Activity Log tab): the shortcut focuses the input in Chat, without reloading the panel", async () => {
    await inPanel("mark", "kept");
    await inPanel("activity-log");
    await waitFor(async () => (await panelOf())?.active === "tab-btn-history", "the Activity Log tab to have the focus");
    assert.equal(await press(WEB), "focused");
    const { panel } = await inputHasRealFocus("the input to have the focus");
    assert.equal(panel.mark, "kept", "the same panel page");
    return "same page, input focused";
  });

  await step("focus in the web page, text in the box: the shortcut recreates the panel with the real focus in the input, the text and the chat", async () => {
    await inPanel("type", DRAFT);
    await userClicksIntoPage();
    const t0 = Date.now();
    assert.equal(await press(WEB), "reopened");
    const { panel, ms } = await inputHasRealFocus("the input to have the real keyboard focus after the shortcut");
    assert.equal(panel.mark, null, "a new panel page");
    // The page says hello once it runs; the background then gives it the focus with the text back.
    await waitFor(async () => (await panelOf()).draft === DRAFT, "the text in the box to be back", { timeout: 3000 });
    await waitFor(async () => (await panelOf()).chat.includes(REPLY), "the web tab's chat in the new panel", { timeout: 3000 });
    const shown = Date.now() - t0;
    assert.ok((await panelOf()).hasFocus, "the focus stayed in the panel");
    return `focused ${ms} ms after the handler; the box has ${JSON.stringify(DRAFT)} and the chat "${REPLY}" ${shown} ms after the press`;
  });

  await step("the second press, with the cursor in the input, only focuses it again (voice has its own key) and keeps the panel", async () => {
    await inPanel("mark", "kept");
    assert.equal(await press(WEB), "focused");
    const { panel } = await inputHasRealFocus("the input to keep the focus");
    assert.equal(panel.mark, "kept", "the same panel page");
    assert.equal(panel.voice, "locked", "voice did not start");
    assert.equal(panel.tip, null, "no voice tip");
    return "focused";
  });

  await step("the voice key with the focus in the web page: the panel is recreated with the focus, then voice starts (signed out: the locked mic says why, with Choose a plan)", async () => {
    await userClicksIntoPage();
    assert.equal(await press(WEB, "voice"), "reopened");
    const got = await waitFor(
      async () => {
        const f = await panelOf();
        return f?.hasFocus && f.mark === null && f.tab === "tab-btn-chat" && f.tip ? f : null;
      },
      "the new panel to have the focus and the locked-mic tip",
      { timeout: 5000 },
    );
    assert.match(got.tip, /Voice needs/);
    assert.match(got.tip, /Choose a plan/);
    assert.equal(got.active, "BUTTON", "the mic has the focus (it points at the lock)");
    return JSON.stringify({ tip: got.tip, active: got.active });
  });

  await step("the voice key with the focus in the panel: no panel is recreated", async () => {
    await inPanel("mark", "kept");
    assert.equal(await press(WEB, "voice"), "voice");
    assert.equal((await panelOf())?.mark, "kept", "the same panel page");
    return "voice";
  });

  await step("on the Activity Log with the focus in the web page: the shortcut focuses the input in Chat", async () => {
    await inPanel("activity-log");
    await userClicksIntoPage();
    assert.equal(await press(WEB), "reopened");
    const { ms } = await inputHasRealFocus("the input to have the real keyboard focus after the shortcut");
    return `focused ${ms} ms after the handler`;
  });

  await step("another window's panel is opened again with the text its box had (Chrome closes every window's panel)", async () => {
    const web2 = await context.newPage();
    await web2.goto(WEB2);
    const { id: tab2 } = await tabOf(WEB2);
    const w2 = await sw.evaluate(async (t) => (await chrome.windows.create({ tabId: t, focused: true })).id, tab2);
    assert.equal(await press(WEB2), "opened");
    await inputHasRealFocus("window 2's panel input to have the focus", w2);
    await inPanel("type", "window 2 draft", w2);
    // Back to window 1, its focus in the page.
    await userClicksIntoPage();
    assert.equal(await press(WEB), "reopened");
    const { ms } = await inputHasRealFocus("window 1's input to have the real keyboard focus");
    const other = await waitFor(async () => {
      const p = await panelOf(w2);
      return p?.draft === "window 2 draft" ? p : null;
    }, "window 2's panel back with its text", { timeout: 3000 });
    const contexts = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length);
    assert.equal(contexts, 2, "both windows have their panel");
    return `window 1 focused ${ms} ms after the handler; window 2's box ${JSON.stringify(other.draft)}`;
  });
} finally {
  await ext.close();
  await site.close();
}

finish();
