// Smoke test of the built extension in Playwright's Chromium.
// Usage: pnpm --filter @browsertodo/extension build && node apps/extension/test/smoke.e2e.mjs [--headed]
// The helper is not needed; the status must show it as not connected.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const k of ["driver", "runner", "localStore", "sessions", "helper", "settings"]) assert.ok(hook.includes(k), `hook has ${k}`);
    return extensionId;
  });

  await step("alarm scheduled on install", async () => {
    const alarm = await sw.evaluate(() => chrome.alarms.get("browsertodo-run"));
    assert.equal(alarm?.periodInMinutes, 15);
    return `period ${alarm.periodInMinutes} min`;
  });

  // UI protocol requests, sent from an extension page like the side panel does.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const ui = async (msg) => {
    const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    if (!res?.ok) throw new Error(`${msg.type}: ${res?.error ?? "no response"}`);
    return res.data;
  };

  await step("state.get without helper or key: no brain, helper error shown", async () => {
    const state = await ui({ type: "state.get" });
    assert.equal(state.brain.effective, null);
    assert.equal(state.settings.brain, "auto");
    assert.ok(state.brain.note, "has a note");
    return state.brain.note.slice(0, 120);
  });

  await step("settings.save: partial update, secrets redacted, alarm rescheduled", async () => {
    const state = await ui({ type: "settings.save", settings: { anthropicApiKey: "sk-smoke", intervalMinutes: 30, delayMinSec: 0, delayMaxSec: 1 } });
    assert.equal(state.settings.anthropicApiKey, "set");
    assert.equal(state.brain.effective, "claude-api");
    const stored = await sw.evaluate(() => chrome.storage.local.get("settings"));
    assert.equal(stored.settings.anthropicApiKey, "sk-smoke");
    await page.waitForTimeout(200);
    const alarm = await sw.evaluate(() => chrome.alarms.get("browsertodo-run"));
    assert.equal(alarm?.periodInMinutes, 30);
    await ui({ type: "settings.save", settings: { anthropicApiKey: "" } });
    return "key set then cleared, interval 30";
  });

  await step("settings.testCloud reports missing configuration", async () => {
    const r = await ui({ type: "settings.testCloud" });
    assert.equal(r.ok, false);
    return r.detail;
  });

  await step("tasks.add / tasks.list with a file stored in IndexedDB", async () => {
    const { task } = await ui({
      type: "tasks.add",
      instructions: "smoke task",
      notBefore: new Date(Date.now() + 3600_000).toISOString(),
      media: [{ name: "note.txt", type: "text/plain", dataBase64: Buffer.from("hello media").toString("base64") }],
    });
    const { tasks } = await ui({ type: "tasks.list" });
    const t = tasks.find((x) => x.id === task.id);
    assert.deepEqual(t.media.map((m) => [m.name, m.size]), [["note.txt", 11]]);
    const due = await sw.evaluate(() => chrome.alarms.get("browsertodo-due"));
    assert.ok(due, "due alarm scheduled for the task's time");
    return `${tasks.length} task(s), due alarm at ${new Date(due.scheduledTime).toISOString()}`;
  });

  await step("run.due with no brain records lastError and does not run", async () => {
    // Claude API mode without a key: no brain, whatever helper is installed on this machine.
    await ui({ type: "settings.save", settings: { brain: "claude-api" } });
    await ui({ type: "tasks.add", instructions: "due now" });
    const r = await ui({ type: "run.due" });
    assert.equal(r.started, true);
    await sw.evaluate(() => globalThis.__browsertodo.runner.idle());
    const state = await ui({ type: "state.get" });
    assert.ok(state.lastError, "lastError set");
    const { tasks } = await ui({ type: "tasks.list" });
    assert.equal(tasks.find((t) => t.instructions === "due now").status, "pending");
    return state.lastError.slice(0, 120);
  });

  await step("vault via background requests, getCredential", async () => {
    const send = (m) => sw.evaluate((x) => globalThis.__browsertodo.router.handle(x), m);
    assert.deepEqual(await send({ type: "vault.unlock", passphrase: "smoke passphrase" }), { ok: true, data: { ok: true } });
    await send({ type: "vault.set", site: "example.com", username: "alice", password: "pw1" });
    const cred = await sw.evaluate(() => globalThis.__browsertodo.vault.getCredential("login.example.com"));
    assert.deepEqual(cred, { found: true, username: "alice", password: "pw1" });
    await send({ type: "vault.lock" });
    return "parent-domain match ok, lock ok";
  });

  let materializedPath = null;
  await step("media materialization writes a real file with chrome.downloads", async () => {
    const out = await sw.evaluate(async () => {
      const m = await globalThis.__browsertodo.media.materialize("smoke-session", [
        { kind: "blob", name: "upload-me.txt", blob: new Blob(["hello upload"], { type: "text/plain" }) },
      ]);
      globalThis.__smokeMedia = m;
      return m.paths;
    });
    assert.equal(out.length, 1);
    assert.ok(existsSync(out[0]), `file exists: ${out[0]}`);
    assert.equal(readFileSync(out[0], "utf8"), "hello upload");
    materializedPath = out[0];
    return out[0];
  });

  // Driver against the fixture page, in the agent tab.
  const call = (method, params = {}) =>
    sw.evaluate(async ([m, p]) => globalThis.__browsertodo.driver[m](p), [method, params]);
  const findIndex = (snap, pred) => {
    const el = snap.elements.find(pred);
    if (!el) throw new Error(`element not found in ${JSON.stringify(snap.elements)}`);
    return el.index;
  };

  const counts = () =>
    sw.evaluate(async () => ({ windows: (await chrome.windows.getAll()).length, tabs: (await chrome.tabs.query({})).length }));

  await step("one-off run on an extension page opens a grouped tab next to it, same window", async () => {
    await page.bringToFront();
    const before = await counts();
    const out = await sw.evaluate(async () => {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = await globalThis.__browsertodo.agentTab.prepare("current-tab");
      const tab = await chrome.tabs.get(tabId);
      const group = tab.groupId !== -1 ? await chrome.tabGroups.get(tab.groupId) : null;
      return { activeUrl: active.url, activeIndex: active.index, activeWindow: active.windowId, tab, group };
    });
    const after = await counts();
    assert.match(out.activeUrl, /^chrome-extension:\/\//);
    assert.equal(out.tab.windowId, out.activeWindow, "same window");
    assert.equal(out.tab.index, out.activeIndex + 1, "right after the active tab");
    assert.equal(out.tab.active, true);
    assert.equal(out.group?.title, "browsertodo");
    assert.equal(out.group?.color, "blue");
    assert.equal(after.windows, before.windows, "no new window");
    assert.equal(after.tabs, before.tabs + 1);
    return `tab ${out.tab.id} at index ${out.tab.index} in group "${out.group.title}"`;
  });

  await step("navigate runs in the agent tab", async () => {
    const before = await counts();
    const nav = await call("navigate", { url: `${base}/` });
    assert.equal(nav.title, "Smoke fixture");
    const after = await counts();
    assert.deepEqual(after, before, "no new window or tab");
    const attached = await sw.evaluate(async () => [globalThis.__browsertodo.cdp.attachedTabId, await globalThis.__browsertodo.agentTab.tabId()]);
    assert.equal(attached[0], attached[1], "debugger attached to the agent tab");
    return nav.url;
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

  await step("scroll moves the page and reports how far", async () => {
    const r = await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    const page = await sw.evaluate(async () => {
      const tabId = await globalThis.__browsertodo.agentTab.tabId();
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ h: document.documentElement.scrollHeight, view: document.documentElement.clientHeight }),
      });
      return res.result;
    });
    assert.equal(r.target, "page", JSON.stringify(r));
    assert.equal(r.moved, y, `moved ${r.moved} vs scrollY ${y}`);
    assert.equal(r.position, y);
    assert.equal(r.size, page.h);
    assert.equal(r.view, page.view);
    assert.equal(r.reason, undefined);
    return `moved ${r.moved} px, now ${r.position} of ${r.size} (view ${r.view})`;
  });

  await step("scroll at the bottom reports that nothing moved", async () => {
    const toEnd = await call("scroll", { direction: "down", amount: 20 });
    assert.ok(toEnd.moved > 0, JSON.stringify(toEnd));
    assert.ok(toEnd.position >= toEnd.size - toEnd.view - 1, `at the end: ${JSON.stringify(toEnd)}`);
    const r = await call("scroll", { direction: "down", amount: 1 });
    assert.equal(r.moved, 0, JSON.stringify(r));
    assert.equal(r.reason, "end");
    assert.equal(r.target, "page");
    const top = await call("scroll", { direction: "up", amount: 20 });
    assert.equal(top.position, 0, JSON.stringify(top));
    return `bottom at ${r.position} of ${r.size}; back to top`;
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

  await step("upload works with a materialized path, which cleanup removes", async () => {
    if (!materializedPath) throw new Error("no materialized file");
    snap = await call("readPage");
    await call("upload", { index: findIndex(snap, (e) => e.type === "file"), paths: [materializedPath] });
    const s = await call("readPage");
    assert.match(s.text, /Files: \S*:12/);
    await sw.evaluate(() => globalThis.__smokeMedia.cleanup());
    assert.ok(!existsSync(materializedPath), "file removed");
    return /Files: (\S*)/.exec(s.text)?.[1];
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

  await step("scheduled runs reuse the agent tab", async () => {
    const before = await counts();
    const [a, b] = await sw.evaluate(async () => [await globalThis.__browsertodo.agentTab.tabId(), await globalThis.__browsertodo.agentTab.prepare("own-tab")]);
    assert.equal(b, a);
    await call("navigate", { url: `${base}/` });
    assert.deepEqual(await counts(), before);
  });

  await step("one-off run on the user's page acts on that tab; closing it fails the next call", async () => {
    const userPage = await context.newPage();
    await userPage.goto(`${base}/other`);
    await userPage.bringToFront();
    const out = await sw.evaluate(async () => {
      const tabId = await globalThis.__browsertodo.agentTab.prepare("current-tab");
      await globalThis.__browsertodo.driver.ready();
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, group: tab.groupId !== -1 ? (await chrome.tabGroups.get(tab.groupId)).title : null, groups: (await chrome.tabGroups.query({ title: "browsertodo" })).length };
    });
    assert.equal(out.url, `${base}/other`);
    assert.equal(out.group, "browsertodo");
    assert.equal(out.groups, 1, "reuses the existing browsertodo group");
    const snap = await call("readPage");
    assert.ok(snap.text.includes("other page"), snap.text);
    await userPage.close();
    await assert.rejects(call("readPage"), /the agent tab was closed/);
    return "user tab driven, closed-tab error readable";
  });
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke steps passed`);
process.exit(failed.length ? 1 : 0);
