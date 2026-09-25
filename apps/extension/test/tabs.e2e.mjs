// A chat per browser tab, in the built extension in Playwright's Chromium: one-off runs
// started from two tabs run at the same time, each acting on its own tab (even after the
// user switched away), the side panel's chat follows the active tab, a chat whose tab shows
// a chrome:// page moves to a new tab, and closing a chat's tab stops its run.
// The brain is a scripted fake installed in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/tabs.e2e.mjs [--headed]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "..", "..", "dist");
const headed = process.argv.includes("--headed");

// /a, /b, /c: a page with a Count button (the fake agent clicks it) and its own title.
const server = createServer((req, res) => {
  const name = (req.url ?? "/").slice(1) || "home";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Page ${name}</title><h1>Page ${name}</h1>
<button onclick="document.getElementById('n').textContent = String(++window.clicks)">Count</button>
<p>Clicks: <span id="n">0</span></p><script>window.clicks = 0;</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "browsertodo-tabs-"));
const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok   ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL ${name} - ${err.stack ?? err.message}`);
  }
};
const waitFor = async (fn, what, ms = 10_000) => {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !headed,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;

  // The fake brain: each run waits for its gate, then reads its tab and clicks Count there.
  await sw.evaluate(() => {
    const fake = (globalThis.__fake = { gates: {}, log: [] });
    /** One turn named `name` (the task, or the next message) in the turn's tab. */
    const turn = (opts, name) => {
      let resolve;
      const done = new Promise((r) => (resolve = r));
      (async () => {
        opts.onEvent({ type: "assistant_text", text: `working on ${name}` });
        await new Promise((r) => (fake.gates[name] = r));
        delete fake.gates[name];
        const snap = await opts.browser.call("browser.readPage", {});
        const btn = snap.elements.find((e) => e.name === "Count");
        await opts.browser.call("browser.click", { index: btn.index });
        fake.log.push({ name, url: snap.url });
        resolve({ outcome: "done", summary: `clicked on ${snap.title}` });
      })().catch((e) => resolve({ outcome: "failed", reason: String(e?.message ?? e) }));
      return { done, sendUserMessage: async () => true, abort: (reason, outcome) => resolve({ outcome, reason }) };
    };
    const brain = {
      kind: "claude-api",
      start: (opts) => turn(opts, opts.task.instructions),
      // The next turn keeps the conversation's agent session: named by the user's message.
      continue: (opts) => turn(opts, opts.text),
      isOpen: () => true,
    };
    globalThis.__browsertodo.runner.deps.resolveBrain = async () => ({
      brain,
      status: { effective: "claude-api", helper: null, hasApiKey: true, jevActive: false },
    });
  });
  const release = (name) =>
    sw.evaluate(async (n) => {
      for (let i = 0; i < 200 && !globalThis.__fake.gates[n]; i++) await new Promise((r) => setTimeout(r, 50));
      if (!globalThis.__fake.gates[n]) throw new Error(`no run of ${n} is waiting`);
      globalThis.__fake.gates[n]();
    }, name);
  const sessionOf = (id) => sw.evaluate(async (i) => globalThis.__browsertodo.sessions.get(i), id);
  const bindings = () => sw.evaluate(() => globalThis.__browsertodo.tabChats.all());

  // The side panel page as a background tab of the same window, so it follows that window's active tab.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const pageA = await context.newPage();
  await pageA.goto(`${base}/a`);
  const pageB = await context.newPage();
  await pageB.goto(`${base}/b`);
  const ids = await sw.evaluate(async (b) => {
    const find = async (url) => (await chrome.tabs.query({ url }))[0];
    const [p, a, bb] = [await find(`chrome-extension://${chrome.runtime.id}/sidepanel.html`), await find(`${b}/a`), await find(`${b}/b`)];
    // One window for all three.
    for (const t of [a, bb]) if (t.windowId !== p.windowId) await chrome.tabs.move(t.id, { windowId: p.windowId, index: -1 });
    return { panel: p.id, a: a.id, b: bb.id, windowId: p.windowId };
  }, base);
  const activate = (tabId) => sw.evaluate(async (t) => void (await chrome.tabs.update(t, { active: true })), tabId);
  const ui = (msg) =>
    panel.evaluate(async (m) => {
      const res = await chrome.runtime.sendMessage(m);
      if (!res?.ok) throw new Error(res?.error ?? "no response");
      return res.data;
    }, msg);
  const panelView = () =>
    panel.evaluate(() => ({
      title: document.getElementById("chat-titles").hidden ? null : document.getElementById("chat-title").textContent,
      empty: !!document.querySelector("#chat-log .chat-empty"),
      chips: [...document.querySelectorAll("#chat-switch:not([hidden]) .act-chip")].map((c) => c.textContent.trim()),
    }));
  const clicks = (page) => page.evaluate(() => window.clicks);

  let a;
  let b;
  await step("tab A: a new chat, then a one-off started there is bound to it", async () => {
    await activate(ids.a);
    await waitFor(async () => (await panelView()).empty, "tab A's empty chat");
    a = await ui({ type: "run.adhoc", instructions: "task A", tabId: ids.a });
    assert.equal((await bindings())[ids.a], a.sessionId);
    await waitFor(async () => (await panelView()).title === "task A", "the panel showing task A");
    return `session ${a.sessionId} in tab ${ids.a}`;
  });

  await step("switching to tab B shows B's (empty) chat with a chip for A's running chat", async () => {
    await activate(ids.b);
    const v = await waitFor(async () => {
      const x = await panelView();
      return x.empty && x.chips.length === 1 ? x : null;
    }, "tab B's empty chat");
    assert.deepEqual(v.chips, ["task A"]);
    return JSON.stringify(v);
  });

  await step("tab B runs its own chat at the same time; each acts on its own tab", async () => {
    b = await ui({ type: "run.adhoc", instructions: "task B", tabId: ids.b });
    await waitFor(async () => (await panelView()).title === "task B", "the panel showing task B");
    const running = await ui({ type: "state.get" });
    assert.deepEqual(running.runningSessions.map((s) => s.title).sort(), ["task A", "task B"]);
    assert.deepEqual(running.runningTabs[a.sessionId], [ids.a]);
    assert.deepEqual(running.runningTabs[b.sessionId], [ids.b]);
    // The user is on tab B; A's agent still acts on tab A.
    await release("task A");
    await release("task B");
    await waitFor(async () => (await sessionOf(a.sessionId))?.outcome === "done" && (await sessionOf(b.sessionId))?.outcome === "done", "both runs to end");
    const log = await sw.evaluate(() => globalThis.__fake.log);
    assert.equal(log.find((l) => l.name === "task A").url, `${base}/a`);
    assert.equal(log.find((l) => l.name === "task B").url, `${base}/b`);
    assert.equal(await clicks(pageA), 1);
    assert.equal(await clicks(pageB), 1);
    assert.equal((await sessionOf(a.sessionId)).summary, "clicked on Page a");
    return "A clicked on /a, B on /b";
  });

  await step("the panel's chat follows the active tab", async () => {
    await activate(ids.a);
    await waitFor(async () => (await panelView()).title === "task A", "tab A's chat");
    await activate(ids.b);
    await waitFor(async () => (await panelView()).title === "task B", "tab B's chat");
    await activate(ids.panel);
    await waitFor(async () => (await panelView()).empty, "a tab without a chat");
    return "A -> task A, B -> task B, other -> new chat";
  });

  await step("the next message in tab A's chat acts on tab A again", async () => {
    await activate(ids.b);
    // Sent from tab A's panel (the composer names its tab), while the user looks at B.
    const r = await ui({ type: "run.message", sessionId: a.sessionId, text: "again A", tabId: ids.a });
    assert.equal(r.mode, "turn");
    await release("again A");
    await waitFor(async () => (await clicks(pageA)) === 2, "a second click on tab A");
    assert.equal(await clicks(pageB), 1);
    await waitFor(async () => (await sessionOf(a.sessionId))?.endedAt && (await sessionOf(a.sessionId)).turns === 2, "turn 2 to end");
    return "clicks: A 2, B 1";
  });

  await step("New Chat in tab B clears only B's chat; Open in Chat binds it to the current tab", async () => {
    await ui({ type: "run.newChat", sessionId: b.sessionId, tabId: ids.b });
    let map = await bindings();
    assert.equal(map[ids.b], undefined);
    assert.equal(map[ids.a], a.sessionId);
    await waitFor(async () => (await panelView()).empty, "tab B's new chat");
    const st = await ui({ type: "chat.bind", sessionId: b.sessionId, tabId: ids.b });
    assert.equal(st.tabChats[ids.b], b.sessionId);
    await waitFor(async () => (await panelView()).title === "task B", "task B back in tab B");
    map = await bindings();
    return JSON.stringify(map);
  });

  await step("a chat whose tab shows a chrome:// page moves to a new tab, and the panel follows it", async () => {
    const pageC = await context.newPage();
    await pageC.goto(`${base}/c`);
    const c = await sw.evaluate(async ([u, w]) => {
      const [t] = await chrome.tabs.query({ url: u });
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
      await chrome.tabs.update(t.id, { active: true });
      return t.id;
    }, [`${base}/c`, ids.windowId]);
    const s = await ui({ type: "run.adhoc", instructions: "task C", tabId: c });
    await release("task C");
    await waitFor(async () => (await sessionOf(s.sessionId))?.outcome === "done", "task C");
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
    await release("again C");
    await waitFor(async () => (await sessionOf(s.sessionId))?.turns === 2 && (await sessionOf(s.sessionId))?.endedAt, "turn 2 of task C");
    return `tab ${c} (chrome://version) -> tab ${moved}`;
  });

  await step("closing a chat's tab while it runs stops it (paused); the session stays", async () => {
    const pageD = await context.newPage();
    await pageD.goto(`${base}/d`);
    const d = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/d`);
    const s = await ui({ type: "run.adhoc", instructions: "task D", tabId: d });
    await waitFor(() => sw.evaluate(() => !!globalThis.__fake.gates["task D"]), "task D to start");
    await pageD.close();
    const ended = await waitFor(async () => {
      const x = await sessionOf(s.sessionId);
      return x?.endedAt ? x : null;
    }, "task D to stop");
    assert.equal(ended.outcome, "paused");
    assert.equal(ended.reason, "the tab was closed");
    assert.equal((await bindings())[d], undefined);
    const { sessions } = await ui({ type: "sessions.list" });
    assert.ok(sessions.some((x) => x.sessionId === s.sessionId), "still in the Activity Log");
    return `${ended.outcome}: ${ended.reason}`;
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tab steps passed`);
process.exit(failed.length ? 1 : 0);
