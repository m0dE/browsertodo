// The agent never takes over the user's screen, in the built extension in a HEADED
// Playwright Chromium (a real window, so tab visibility is real): a one-off run starts in
// tab A, the user switches to tab B, and the run keeps working in A (reads, screenshots,
// opens and switches tabs, a second turn) while B stays the active tab the whole time.
// Screenshots of the background tab A are checked against A's real colour: prints whether
// they were real or skipped ("Screenshot skipped: the tab is in the background ...").
// The brain is a scripted fake installed in the service worker (no helper, no API key).
// Usage: pnpm build && node apps/extension/test/focus.e2e.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "..", "..", "dist");

// Each page fills the window with its own colour, so a screenshot shows which page it is.
const COLORS = { a: [224, 48, 48], b: [48, 80, 224], c: [48, 192, 80] };
const server = createServer((req, res) => {
  const name = (req.url ?? "/").slice(1) || "home";
  const [r, g, b] = COLORS[name] ?? [255, 255, 255];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Page ${name}</title><body style="margin:0;height:100vh;background:rgb(${r},${g},${b})">
<h1>Page ${name}</h1><button onclick="document.getElementById('n').textContent = String(++window.clicks)">Count</button>
<p>Clicks: <span id="n">0</span></p><script>window.clicks = 0;</script></body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "browsertodo-focus-"));
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
const waitFor = async (fn, what, ms = 15_000) => {
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

// Headed on purpose: a headless browser has no real window visibility.
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: false,
  // Without Playwright's flags that keep hidden tabs rendering, as in a user's Chrome.
  ignoreDefaultArgs: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const version = context.browser()?.version() ?? (await sw.evaluate(() => navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "?"));
  console.log(`Chromium ${version} (headed)`);

  // The spy: every tabs.update({active}) / windows.update({focused}) the extension makes,
  // and every tab activation, whoever caused it.
  await sw.evaluate(() => {
    const spy = (globalThis.__spy = { takeovers: [], activated: [] });
    const tabsUpdate = chrome.tabs.update.bind(chrome.tabs);
    chrome.tabs.update = (...args) => {
      const props = typeof args[0] === "number" ? args[1] : args[0];
      if (props?.active || props?.highlighted) spy.takeovers.push({ api: "tabs.update", args: JSON.stringify(args), stack: new Error().stack });
      return tabsUpdate(...args);
    };
    const winUpdate = chrome.windows.update.bind(chrome.windows);
    chrome.windows.update = (id, props) => {
      if (props?.focused || props?.drawAttention) spy.takeovers.push({ api: "windows.update", args: JSON.stringify([id, props]), stack: new Error().stack });
      return winUpdate(id, props);
    };
    chrome.tabs.onActivated.addListener((info) => spy.activated.push(info.tabId));
  });

  // The fake brain: a turn waits for its gate, then works in the run's tab like a real agent would.
  await sw.evaluate((colors) => {
    const fake = (globalThis.__fake = { gates: {}, shots: [], log: [] });
    /** What a screenshot shows: the page's colour (real), blank/other, or skipped (the tool's error). */
    const classify = async (call) => {
      try {
        const shot = await call();
        const bytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: shot.mimeType }));
        const ctx = new OffscreenCanvas(8, 8).getContext("2d");
        ctx.drawImage(bmp, 0, 0, 8, 8);
        const d = ctx.getImageData(4, 6, 1, 1).data; // bottom middle: page background, not the heading
        const near = (c) => c.every((v, i) => Math.abs(v - d[i]) < 24);
        const page = Object.keys(colors).find((k) => near(colors[k])) ?? `other rgb(${d[0]},${d[1]},${d[2]})`;
        return { kind: "real", page, size: `${bmp.width}x${bmp.height}` };
      } catch (e) {
        return { kind: "skipped", error: String(e?.message ?? e) };
      }
    };
    const turn = (opts, name) => {
      let resolve;
      const done = new Promise((r) => (resolve = r));
      const b = opts.browser;
      (async () => {
        opts.onEvent({ type: "assistant_text", text: `working on ${name}` });
        await new Promise((r) => (fake.gates[name] = r));
        delete fake.gates[name];
        const snap = await b.call("browser.readPage", {});
        fake.shots.push({ turn: name, of: "t1", ...(await classify(() => b.call("browser.screenshot", {}))) });
        await b.call("browser.click", { index: snap.elements.find((e) => e.name === "Count").index });
        if (name === "task A") {
          // Another tab of the run, made current: it must stay in the background too.
          await b.call("browser.openTabs", { urls: [`${opts.base}/c`], background: false });
          fake.shots.push({ turn: name, of: "t2", ...(await classify(() => b.call("browser.screenshot", {}))) });
          await b.call("browser.switchTab", { tab: "t1" });
          await b.call("browser.switchTab", { tab: "t2" });
          await b.call("browser.switchTab", { tab: "t1" });
          await b.call("browser.navigate", { url: `${opts.base}/a` });
          fake.shots.push({ turn: name, of: "t1 after navigate", ...(await classify(() => b.call("browser.screenshot", {}))) });
        }
        fake.log.push({ name, url: snap.url });
        resolve({ outcome: "done", summary: `clicked on ${snap.title}` });
      })().catch((e) => resolve({ outcome: "failed", reason: String(e?.message ?? e) }));
      return { done, sendUserMessage: async () => true, abort: (reason, outcome) => resolve({ outcome, reason }) };
    };
    const brain = {
      kind: "claude-api",
      start: (opts) => turn({ ...opts, base: fake.base }, opts.task.instructions),
      continue: (opts) => turn({ ...opts, base: fake.base }, opts.text),
      isOpen: () => true,
    };
    globalThis.__browsertodo.runner.deps.resolveBrain = async () => ({
      brain,
      status: { effective: "claude-api", helper: null, hasApiKey: true, jevActive: false },
    });
  }, COLORS);
  await sw.evaluate((b) => void (globalThis.__fake.base = b), base);
  const release = (name) =>
    sw.evaluate(async (n) => {
      for (let i = 0; i < 200 && !globalThis.__fake.gates[n]; i++) await new Promise((r) => setTimeout(r, 50));
      if (!globalThis.__fake.gates[n]) throw new Error(`no run of ${n} is waiting`);
      globalThis.__fake.gates[n]();
    }, name);
  const sessionOf = (id) => sw.evaluate(async (i) => globalThis.__browsertodo.sessions.get(i), id);

  const panel = await context.newPage();
  const extensionId = new URL(sw.url()).host;
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const pageA = await context.newPage();
  await pageA.goto(`${base}/a`);
  const pageB = await context.newPage();
  await pageB.goto(`${base}/b`);
  const ids = await sw.evaluate(async (b) => {
    const find = async (url) => (await chrome.tabs.query({ url }))[0];
    const [p, a, bb] = [await find(`chrome-extension://${chrome.runtime.id}/sidepanel.html`), await find(`${b}/a`), await find(`${b}/b`)];
    for (const t of [a, bb]) if (t.windowId !== p.windowId) await chrome.tabs.move(t.id, { windowId: p.windowId, index: -1 });
    return { a: a.id, b: bb.id, windowId: p.windowId };
  }, base);
  // The user's own tab switches: through Playwright, not the extension's spied chrome.tabs.update.
  const userSwitchesTo = async (page, tabId) => {
    await page.bringToFront();
    await waitFor(() => sw.evaluate(async (t) => (await chrome.tabs.get(t)).active, tabId), `tab ${tabId} to be active`);
  };
  const ui = (msg) =>
    panel.evaluate(async (m) => {
      const res = await chrome.runtime.sendMessage(m);
      if (!res?.ok) throw new Error(res?.error ?? "no response");
      return res.data;
    }, msg);
  // Samples the active tab of the window every 25 ms while a turn runs.
  const watchActive = () =>
    sw.evaluate((w) => {
      const seen = (globalThis.__seen = new Set());
      globalThis.__watch = setInterval(async () => {
        const [t] = await chrome.tabs.query({ active: true, windowId: w });
        if (t) seen.add(t.id);
      }, 25);
    }, ids.windowId);
  const stopWatch = () =>
    sw.evaluate(() => {
      clearInterval(globalThis.__watch);
      return [...globalThis.__seen];
    });
  const resetSpy = () => sw.evaluate(() => ((globalThis.__spy.takeovers = []), (globalThis.__spy.activated = [])));
  const spy = () => sw.evaluate(() => globalThis.__spy);

  let a;
  await step("a one-off run starts in tab A; the user switches to tab B during the run", async () => {
    await userSwitchesTo(pageA, ids.a);
    a = await ui({ type: "run.adhoc", instructions: "task A", tabId: ids.a });
    await waitFor(() => sw.evaluate(() => !!globalThis.__fake.gates["task A"]), "task A to start");
    await userSwitchesTo(pageB, ids.b);
    await resetSpy();
    return `session ${a.sessionId} in tab ${ids.a}`;
  });

  await step("tab B stays active for the whole run while it reads, clicks, screenshots, opens and switches tabs in A", async () => {
    await watchActive();
    await release("task A");
    const s = await waitFor(async () => {
      const x = await sessionOf(a.sessionId);
      return x?.endedAt ? x : null;
    }, "task A to end");
    const seen = await stopWatch();
    const { takeovers, activated } = await spy();
    assert.equal(s.outcome, "done", s.reason);
    assert.deepEqual(takeovers.map((t) => `${t.api} ${t.args}`), [], "no tab activation / window focus by the extension");
    assert.deepEqual(activated, [], "no tab was activated");
    assert.deepEqual(seen, [ids.b], "only tab B was ever the active tab");
    assert.equal(await sw.evaluate(async (t) => (await chrome.tabs.get(t)).active, ids.b), true);
    assert.equal(await pageA.evaluate(() => location.pathname), "/a");
    return `${s.outcome}; active tab samples: ${JSON.stringify(seen)}`;
  });

  await step("the next message in A's chat, sent while the user is on B, does not bring A to the front", async () => {
    await resetSpy();
    await watchActive();
    const r = await ui({ type: "run.message", sessionId: a.sessionId, text: "again A", tabId: ids.a });
    assert.equal(r.mode, "turn");
    await release("again A");
    await waitFor(async () => (await sessionOf(a.sessionId))?.turns === 2 && (await sessionOf(a.sessionId))?.endedAt, "turn 2 to end");
    const seen = await stopWatch();
    const { takeovers, activated } = await spy();
    assert.deepEqual(takeovers.map((t) => `${t.api} ${t.args}`), []);
    assert.deepEqual(activated, []);
    assert.deepEqual(seen, [ids.b]);
    assert.equal(await pageA.evaluate(() => window.clicks), 1, "clicked in tab A (reloaded by turn 1's navigate)");
    assert.equal(await pageB.evaluate(() => window.clicks), 0, "tab B was never acted on");
    return `turn 2 ended; active tab samples: ${JSON.stringify(seen)}`;
  });

  await step("screenshots of the background tabs", async () => {
    const shots = await sw.evaluate(() => globalThis.__fake.shots);
    assert.ok(shots.length >= 4, `screenshots taken: ${shots.length}`);
    const expected = { t1: "a", t2: "c", "t1 after navigate": "a" };
    for (const s of shots) {
      if (s.kind === "real") assert.equal(s.page, expected[s.of], `a real screenshot of ${s.of} shows its page (${JSON.stringify(s)})`);
      else assert.match(s.error, /Screenshot skipped: the tab is in the background/);
    }
    const real = shots.filter((s) => s.kind === "real").length;
    console.log(`     background screenshots: ${real} real, ${shots.length - real} skipped`);
    for (const s of shots) console.log(`       ${s.turn} / ${s.of}: ${s.kind === "real" ? `real (page ${s.page}, ${s.size})` : s.error}`);
    return `${real}/${shots.length} real`;
  });

  await step("Show Tab (a user action) still brings the run's tab to the front", async () => {
    await resetSpy();
    // Show Tab is offered while a run is going: start one that waits.
    const s = await ui({ type: "run.message", sessionId: a.sessionId, text: "third", tabId: ids.a });
    assert.equal(s.mode, "turn");
    await waitFor(() => sw.evaluate(() => !!globalThis.__fake.gates.third), "turn 3 to start");
    assert.equal(await ui({ type: "agent.show", sessionId: a.sessionId }).then((x) => x.ok), true);
    await waitFor(() => sw.evaluate(async (t) => (await chrome.tabs.get(t)).active, ids.a), "tab A to be active");
    const { takeovers } = await spy();
    assert.ok(takeovers.some((t) => t.api === "tabs.update"), "Show Tab activated the tab");
    await release("third");
    await waitFor(async () => (await sessionOf(a.sessionId))?.turns === 3 && (await sessionOf(a.sessionId))?.endedAt, "turn 3 to end");
    return "tab A shown";
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} focus steps passed`);
process.exit(failed.length ? 1 : 0);
