// Pages that contain another extension's frame (e.g. Streak inside Gmail).
// Chrome refuses chrome.debugger for such a tab: attach and every command fail
// with "Cannot access a chrome-extension:// URL of different extension". The
// driver must switch that tab to its fallback (chrome.scripting +
// captureVisibleTab) and keep the debugger for clean pages.
//
// Loads the built extension plus test/fixtures/iframe-injector, which appends
// its own chrome-extension:// iframe to every page (unless <meta name="no-inject">).
// Usage: pnpm --filter @browsertodo/extension build && node apps/extension/test/foreign-frame.e2e.mjs [--headed]
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driverCall, launchExtension } from "../../../test/e2e/lib/extension.mjs";
import { serveHtml } from "../../../test/e2e/lib/serve.mjs";
import { createSuite } from "../../../test/e2e/lib/suite.mjs";
import { driverPage, findIndex, OTHER_PAGE } from "../../../test/fixtures/driver-page.mjs";

const injector = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "iframe-injector");
const NOTE = "(Using fallback mode: another extension's frame on this page blocks Chrome's debugger. Clicks and typing are simulated.)";

/** The driver page; unless `clean`, the injector adds its frame (after `delay` ms). */
const fixture = ({ clean = false, delay = 0 } = {}) =>
  driverPage({
    title: clean ? "Clean page" : "Foreign frame page",
    heading: `${clean ? "Clean" : "Mail"} fixture`,
    head: `${clean ? '<meta name="no-inject">' : ""}${delay ? `<meta name="inject-delay" content="${delay}">` : ""}`,
  });
const PAGES = { "/other": OTHER_PAGE, "/clean": fixture({ clean: true }), "/late": fixture({ delay: 1500 }) };
const site = await serveHtml((path) => PAGES[path] ?? fixture());
const { base } = site;

const { step, finish } = createSuite("foreign-frame");
const ext = await launchExtension({ name: "foreign", extensions: [injector] });
const { context, sw, profile } = ext;
const uploadFile = join(profile, "upload-me.txt");
writeFileSync(uploadFile, "hello upload");

try {
  const call = driverCall(sw);
  const mode = () =>
    sw.evaluate(async () => ({
      fallback: globalThis.__browsertodo.driver.inFallback,
      attached: globalThis.__browsertodo.cdp.attachedTabId,
      tab: await globalThis.__browsertodo.agentTab.tabId(),
    }));

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

  await step("scroll in fallback moves the page and reports how far", async () => {
    const r = await call("scroll", { direction: "down", amount: 1 });
    const s = await call("readPage");
    const y = Number(/ScrollY: (\d+)/.exec(s.text)?.[1]);
    assert.ok(y > 300, `scrollY ${y}`);
    assert.equal(r.target, "page", JSON.stringify(r));
    assert.equal(r.moved, y);
    assert.equal(r.position, y);
    await call("scroll", { direction: "down", amount: 20 });
    const end = await call("scroll", { direction: "down", amount: 1 });
    assert.equal(end.moved, 0, JSON.stringify(end));
    assert.equal(end.reason, "end");
    await call("scroll", { direction: "up", amount: 20 });
    return `scrollY ${y}, then at the bottom: ${end.position} of ${end.size}`;
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
  await ext.close();
  await site.close();
}

finish();
