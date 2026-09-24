// Smoke test of the built extension in Playwright's Chromium.
// Usage: pnpm --filter @browsertodo/extension build && node apps/extension/test/smoke.e2e.mjs [--headed]
// The helper is not needed; the status must show it as not connected.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Output to the repo root so Chrome's "Load unpacked" points at <repo>/dist.
const dist = join(root, "..", "..", "dist");
const expectedId = readFileSync(join(root, "extension-id.txt"), "utf8").trim();
const headed = process.argv.includes("--headed");

const FIXTURE = `<!doctype html><html><head><title>Smoke fixture</title>
<style>body{font-family:sans-serif} .tall{height:3000px} #gone{display:none}</style></head><body>
<h1>Driver smoke page</h1>
<a href="/other" data-testid="other-link">Other page</a>
<button id="inc" data-testid="incButton" onclick="document.getElementById('count').textContent = String(++window.clicks)">Increment</button>
<p>Count: <span id="count">0</span></p>
<label for="name">Your name</label><input id="name" type="text">
<div id="editor" role="textbox" contenteditable="true" aria-label="Compose text" style="border:1px solid #999;min-height:40px"></div>
<input type="file" id="file" style="display:none" onchange="document.getElementById('files').textContent = [...this.files].map(f => f.name + ':' + f.size).join(',')">
<p>Files: <span id="files">none</span></p>
<p>Last key: <span id="lastkey">none</span></p>
<p>ScrollY: <span id="scrolly">0</span></p>
<button id="gone">Invisible button</button>
<input type="hidden" name="secret" value="x">
<div class="tall"></div>
<script>
window.clicks = 0;
document.addEventListener('keydown', e => { document.getElementById('lastkey').textContent = (e.ctrlKey ? 'Control+' : '') + e.key; });
addEventListener('scroll', () => { document.getElementById('scrolly').textContent = String(Math.round(scrollY)); });
</script></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/other" ? "<title>Other</title><p>other page</p>" : FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "browsertodo-smoke-"));
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
  channel: "chromium", // new headless mode, which supports extensions
  headless: !headed,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;

  await step("extension loads with the pinned ID", async () => {
    assert.equal(extensionId, expectedId);
    const hook = await sw.evaluate(() => Object.keys(globalThis.__browsertodo ?? {}));
    assert.ok(hook.includes("driver") && hook.includes("coordinator"));
    return extensionId;
  });

  await step("alarm scheduled on install", async () => {
    const alarm = await sw.evaluate(() => chrome.alarms.get("browsertodo-run"));
    assert.equal(alarm?.periodInMinutes, 15);
    return `period ${alarm.periodInMinutes} min`;
  });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  await step("options page renders with helper not connected", async () => {
    await options.getByRole("heading", { name: "browsertodo" }).waitFor();
    await options.waitForFunction(() => document.getElementById("st-helper")?.textContent !== "…");
    const helper = await options.locator("#st-helper").textContent();
    assert.match(helper, /not connected/);
    const cmd = await options.locator("#install-cmd").textContent();
    assert.ok(cmd.includes(`--extension-id ${extensionId}`));
    return helper;
  });

  await step("options page saves settings and reschedules the alarm", async () => {
    await options.locator("#f-apiBase").fill("http://127.0.0.1:9/");
    await options.locator("#f-runnerKey").fill("bt_smoke");
    await options.locator("#f-intervalMinutes").fill("30");
    await options.locator("#f-delayMinSec").fill("0");
    await options.locator("#f-delayMaxSec").fill("1");
    await options.getByRole("button", { name: "Save settings" }).click();
    await options.locator("#save-msg", { hasText: "Saved." }).waitFor();
    const stored = await sw.evaluate(() => chrome.storage.local.get("settings"));
    assert.equal(stored.settings.apiBase, "http://127.0.0.1:9");
    assert.equal(stored.settings.intervalMinutes, 30);
    assert.equal(stored.settings.runnerKey, "bt_smoke");
    await options.waitForTimeout(200);
    const alarm = await sw.evaluate(() => chrome.alarms.get("browsertodo-run"));
    assert.equal(alarm?.periodInMinutes, 30);
    return "apiBase trimmed, interval 30";
  });

  await step("Test API connection reports an unreachable API", async () => {
    await options.getByRole("button", { name: "Test API connection" }).click();
    await options.locator("#action-msg", { hasText: "failed" }).waitFor({ timeout: 15_000 });
    return (await options.locator("#action-msg").textContent()).slice(0, 120);
  });

  await step("Run now without a helper records 'Helper not connected'", async () => {
    await options.getByRole("button", { name: "Run now" }).click();
    await options.locator("#st-error", { hasText: "Helper not connected" }).waitFor({ timeout: 15_000 });
    const running = await options.locator("#st-run").textContent();
    return `${(await options.locator("#st-error").textContent()).slice(0, 120)} (run: ${running})`;
  });

  await step("vault unlock, add, list, getCredential", async () => {
    await options.locator("#vault-pass").fill("smoke passphrase");
    await options.getByRole("button", { name: "Unlock" }).click();
    await options.locator("#vault-state", { hasText: "unlocked" }).waitFor();
    await options.locator("#va-site").fill("example.com");
    await options.locator("#va-user").fill("alice");
    await options.locator("#va-pass").fill("pw1");
    await options.getByRole("button", { name: "Add or replace" }).click();
    await options.locator("#vault-sites li", { hasText: "example.com" }).waitFor();
    const cred = await sw.evaluate(() => globalThis.__browsertodo.vault.getCredential("login.example.com"));
    assert.deepEqual(cred, { found: true, username: "alice", password: "pw1" });
    await options.getByRole("button", { name: "Lock", exact: true }).click();
    await options.locator("#vault-state", { hasText: /^locked$/ }).waitFor();
    return "parent-domain match ok, lock ok";
  });

  // Driver against the fixture page, in the agent window.
  const call = (method, params = {}) =>
    sw.evaluate(async ([m, p]) => globalThis.__browsertodo.driver[m](p), [method, params]);
  const findIndex = (snap, pred) => {
    const el = snap.elements.find(pred);
    if (!el) throw new Error(`element not found in ${JSON.stringify(snap.elements)}`);
    return el.index;
  };

  await step("navigate opens the agent window", async () => {
    const before = await sw.evaluate(async () => (await chrome.windows.getAll()).length);
    const nav = await call("navigate", { url: `${base}/` });
    assert.equal(nav.title, "Smoke fixture");
    const after = await sw.evaluate(async () => (await chrome.windows.getAll()).length);
    const win = await sw.evaluate(async () => {
      const { agentWindowId } = await chrome.storage.session.get("agentWindowId");
      const w = await chrome.windows.get(agentWindowId);
      return { width: w.width, height: w.height, type: w.type };
    });
    assert.equal(after, before + 1);
    return `${nav.url} in ${win.type} window ${win.width}x${win.height}`;
  });

  let snap;
  await step("readPage lists interactive elements", async () => {
    snap = await call("readPage");
    const names = snap.elements.map((e) => `${e.role}:${e.name}`);
    assert.ok(names.includes("link:Other page"), names.join(" | "));
    assert.ok(names.includes("button:Increment"));
    assert.ok(names.includes("textbox:Your name"));
    assert.ok(names.includes("textbox:Compose text"));
    assert.ok(snap.elements.some((e) => e.type === "file"), "hidden file input included");
    assert.ok(!names.some((n) => n.includes("Invisible")), "display:none button skipped");
    assert.ok(!snap.elements.some((e) => e.type === "hidden"));
    assert.equal(snap.elements.find((e) => e.role === "link").testId, "other-link");
    assert.ok(snap.text.includes("Driver smoke page"));
    return `${snap.elements.length} elements: ${names.join(", ")}`;
  });

  await step("click is a trusted click", async () => {
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    await call("click", { index: findIndex(snap, (e) => e.testId === "incButton") });
    const s = await call("readPage");
    assert.match(s.text, /Count: 2/);
    return "count 2";
  });

  await step("type into input and contenteditable", async () => {
    snap = await call("readPage");
    await call("type", { index: findIndex(snap, (e) => e.name === "Your name"), text: "Ada" });
    await call("type", { index: findIndex(snap, (e) => e.name === "Compose text"), text: "Hello from browsertodo" });
    const s = await call("readPage");
    assert.equal(s.elements.find((e) => e.name === "Your name").value, "Ada");
    assert.ok(s.text.includes("Hello from browsertodo"), s.text);
    return "input value Ada, editor text set";
  });

  await step("paste and pressKey", async () => {
    await call("paste", { text: "!" });
    await call("pressKey", { key: "Control+a" });
    let s = await call("readPage");
    assert.match(s.text, /Last key: Control\+a/);
    await call("pressKey", { key: "Escape" });
    s = await call("readPage");
    assert.match(s.text, /Last key: Escape/);
    assert.ok(s.text.includes("Hello from browsertodo!"), "paste appended at caret");
    return "Control+a and Escape seen by the page";
  });

  await step("scroll moves the page", async () => {
    await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    await call("scroll", { direction: "up", amount: 5 });
    return `scrollY ${y}`;
  });

  await step("upload sets files on a hidden file input", async () => {
    snap = await call("readPage");
    await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [uploadFile] });
    const s = await call("readPage");
    assert.match(s.text, /Files: upload-me\.txt:12/);
    const err = await call("upload", { index: findIndex(snap, (e) => e.role === "link"), paths: [uploadFile] }).catch((e) => e.message);
    assert.match(String(err), /not a file input/);
    return "upload-me.txt:12";
  });

  await step("click on a stale index errors clearly", async () => {
    const err = await call("click", { index: 999 }).catch((e) => e.message);
    assert.match(String(err), /element 999 not found; call read_page again/);
  });

  await step("screenshot returns a JPEG", async () => {
    const shot = await call("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    const buf = Buffer.from(shot.base64, "base64");
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    const out = join(tmpdir(), "browsertodo-smoke-shot.jpg");
    writeFileSync(out, buf);
    return `${buf.length} bytes -> ${out}`;
  });

  await step("navigate by clicking a link, then currentUrl", async () => {
    snap = await call("readPage");
    await call("click", { index: findIndex(snap, (e) => e.role === "link") });
    await new Promise((r) => setTimeout(r, 800));
    const { url } = await call("currentUrl");
    assert.equal(url, `${base}/other`);
    return url;
  });

  await step("agent window is reused", async () => {
    const before = await sw.evaluate(async () => (await chrome.windows.getAll()).length);
    await call("navigate", { url: `${base}/` });
    const after = await sw.evaluate(async () => (await chrome.windows.getAll()).length);
    assert.equal(after, before);
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke steps passed`);
process.exit(failed.length ? 1 : 0);
