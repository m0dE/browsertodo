// Pages that contain another extension's frame (e.g. Streak inside Gmail).
// Chrome refuses chrome.debugger for such a tab: attach and every command fail
// with "Cannot access a chrome-extension:// URL of different extension". The
// driver must switch that tab to its fallback (chrome.scripting +
// captureVisibleTab) and keep the debugger for clean pages.
//
// Loads the built extension plus test/fixtures/iframe-injector, which appends
// its own chrome-extension:// iframe to every page (unless <meta name="no-inject">).
// Usage: pnpm --filter @browsertodo/extension build && node apps/extension/test/foreign-frame.e2e.mjs [--headed]
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "..", "..", "dist");
const injector = join(root, "test", "fixtures", "iframe-injector");
const headed = process.argv.includes("--headed");
const NOTE = "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger. Clicks and typing are simulated.)";

const fixture = ({ clean = false, delay = 0 } = {}) => `<!doctype html><html><head><title>${clean ? "Clean page" : "Foreign frame page"}</title>
${clean ? '<meta name="no-inject">' : ""}${delay ? `<meta name="inject-delay" content="${delay}">` : ""}
<style>body{font-family:sans-serif} .tall{height:3000px}</style></head><body>
<h1>${clean ? "Clean" : "Mail"} fixture</h1>
<a href="/other" data-testid="other-link">Other page</a>
<button data-testid="incButton" onclick="document.getElementById('count').textContent = String(++window.clicks); document.getElementById('trusted').textContent = String(event.isTrusted)">Increment</button>
<p>Count: <span id="count">0</span> trusted: <span id="trusted">-</span></p>
<form onsubmit="event.preventDefault(); document.getElementById('submitted').textContent = document.getElementById('name').value">
<label for="name">Your name</label><input id="name" type="text"></form>
<p>Submitted: <span id="submitted">none</span></p>
<div id="editor" role="textbox" contenteditable="true" aria-label="Compose text" style="border:1px solid #999;min-height:40px"></div>
<input type="file" id="file">
<p>Last key: <span id="lastkey">none</span></p>
<p>ScrollY: <span id="scrolly">0</span></p>
<div class="tall"></div>
<script>
window.clicks = 0;
document.addEventListener('keydown', e => { document.getElementById('lastkey').textContent = (e.ctrlKey ? 'Control+' : '') + e.key; });
addEventListener('scroll', () => { document.getElementById('scrolly').textContent = String(Math.round(scrollY)); });
</script></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (req.url === "/other") res.end("<title>Other</title><p>other page</p>");
  else if (req.url === "/clean") res.end(fixture({ clean: true }));
  else if (req.url === "/late") res.end(fixture({ delay: 1500 }));
  else res.end(fixture());
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "browsertodo-foreign-"));
const uploadFile = join(profile, "upload-me.txt");
writeFileSync(uploadFile, "hello upload");

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

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !headed,
  args: [`--disable-extensions-except=${dist},${injector}`, `--load-extension=${dist},${injector}`],
});

try {
  let sw = context.serviceWorkers().find((w) => w.url().endsWith("/background.js"));
  if (!sw) sw = await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js"), timeout: 15_000 });

  const call = (method, params = {}) => sw.evaluate(async ([m, p]) => globalThis.__browsertodo.driver[m](p), [method, params]);
  const mode = () =>
    sw.evaluate(async () => ({
      fallback: globalThis.__browsertodo.driver.inFallback,
      attached: globalThis.__browsertodo.cdp.attachedTabId,
      tab: await globalThis.__browsertodo.agentTab.tabId(),
    }));
  const findIndex = (snap, pred) => {
    const el = snap.elements.find(pred);
    if (!el) throw new Error(`element not found in ${JSON.stringify(snap.elements)}`);
    return el.index;
  };

  const page = await context.newPage();
  await page.goto(`${base}/clean`);
  await page.bringToFront();

  await step("clean page: the run's tab is driven through the debugger", async () => {
    await sw.evaluate(() => globalThis.__browsertodo.agentTab.prepare("current-tab"));
    const snap = await call("readPage");
    assert.equal(snap.title, "Clean page");
    assert.equal(snap.note, undefined);
    const m = await mode();
    assert.equal(m.fallback, false);
    assert.equal(m.attached, m.tab);
    return `${snap.elements.length} elements`;
  });

  await step("reproduction: chrome.debugger refuses a tab with another extension's frame", async () => {
    const other = await context.newPage();
    await other.goto(`${base}/`);
    await other.waitForSelector("#foreign-extension-frame");
    const err = await sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      try {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        return "attached";
      } catch (e) {
        return e.message;
      }
    }, `${base}/`);
    await other.close();
    assert.equal(err, "Cannot access a chrome-extension:// URL of different extension");
    return err;
  });

  let snap;
  await step("navigate onto the page with the foreign frame switches to fallback, with the note once", async () => {
    const nav = await call("navigate", { url: `${base}/` });
    assert.equal(nav.title, "Foreign frame page");
    assert.equal(nav.note, NOTE);
    await page.waitForSelector("#foreign-extension-frame");
    // After a navigation the debugger is tried again; it is refused again here.
    snap = await call("readPage");
    assert.equal(snap.note, undefined, "note only once");
    assert.equal((await mode()).fallback, true);
    return nav.url;
  });

  await step("readPage in fallback lists the page's elements, not the foreign frame's", async () => {
    snap = await call("readPage");
    const names = snap.elements.map((e) => `${e.role}:${e.name}`);
    assert.ok(names.includes("link:Other page"), names.join(" | "));
    assert.ok(names.includes("button:Increment"));
    assert.ok(names.includes("textbox:Your name"));
    assert.ok(names.includes("textbox:Compose text"));
    assert.ok(!names.some((n) => n.includes("Foreign extension")));
    assert.ok(snap.text.includes("Mail fixture"));
    return `${snap.elements.length} elements`;
  });

  await step("screenshot in fallback returns a JPEG", async () => {
    const shot = await call("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    const buf = Buffer.from(shot.base64, "base64");
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    const out = join(tmpdir(), "browsertodo-foreign-shot.jpg");
    writeFileSync(out, buf);
    return `${buf.length} bytes -> ${out}`;
  });

  await step("click in fallback runs the page's handler (untrusted)", async () => {
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 2 trusted: false/);
    return "count 2";
  });

  await step("type in fallback fills an input and a contenteditable editor", async () => {
    snap = await call("readPage");
    await call("type", { index: findIndex(snap, (e) => e.name === "Your name"), text: "Ada" });
    await call("type", { index: findIndex(snap, (e) => e.name === "Compose text"), text: "Hello from browsertodo" });
    const s = await call("readPage");
    assert.equal(s.elements.find((e) => e.name === "Your name").value, "Ada");
    assert.ok(s.text.includes("Hello from browsertodo"), s.text);
    return "input value Ada, editor text set";
  });

  await step("paste and pressKey in fallback", async () => {
    await call("paste", { text: "!" });
    let s = await call("readPage");
    assert.ok(s.text.includes("Hello from browsertodo!"), "paste appended at caret");
    await call("pressKey", { key: "Control+a" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Control\+a/);
    await call("pressKey", { key: "Escape" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Escape/);
    return "Control+a and Escape seen by the page";
  });

  await step("Enter in a form input submits the form in fallback", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.name === "Your name") });
    await call("pressKey", { key: "Enter" });
    const s = await call("readPage");
    assert.match(s.text, /Submitted: Ada/);
    return "submitted";
  });

  await step("scroll in fallback moves the page", async () => {
    await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    await call("scroll", { direction: "up", amount: 5 });
    return `scrollY ${y}`;
  });

  await step("upload in fallback fails with a clear reason", async () => {
    snap = await call("readPage");
    const err = await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [uploadFile] }).catch((e) => e.message);
    assert.match(String(err), /upload is not possible on this page because another extension/);
    return String(err).slice(0, 90);
  });

  await step("clicking a link in fallback navigates", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.role === "link") });
    await page.waitForURL(`${base}/other`);
    assert.equal((await call("currentUrl")).url, `${base}/other`);
    return `${base}/other`;
  });

  await step("navigate to a clean page returns to the debugger (trusted clicks)", async () => {
    const nav = await call("navigate", { url: `${base}/clean` });
    assert.equal(nav.title, "Clean page");
    snap = await call("readPage");
    const m = await mode();
    assert.equal(m.fallback, false);
    assert.equal(m.attached, m.tab);
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 1 trusted: true/);
    assert.equal(s.note, undefined);
    return "debugger attached, isTrusted true";
  });

  await step("a frame injected after attach: next call falls back without a second note", async () => {
    await call("navigate", { url: `${base}/late` });
    await page.waitForSelector("#foreign-extension-frame");
    const s = await call("readPage");
    assert.equal(s.title, "Foreign frame page");
    assert.equal(s.note, undefined, "note already shown for this tab");
    assert.equal((await mode()).fallback, true);
    await call("click", { index: findIndex(s, (e) => e.testId === "incButton") });
    assert.match((await call("readPage")).text, /Count: 1 trusted: false/);
    return "fell back after target_closed";
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} foreign-frame steps passed`);
process.exit(failed.length ? 1 : 0);
