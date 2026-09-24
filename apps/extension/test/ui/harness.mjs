// Visual harness for the side panel and options page, without the real background.
// Bundles only the UI entry points, serves them from a local static server, injects
// a `chrome` stub with canned data, and takes screenshots in light and dark mode.
//
// Usage: node apps/extension/test/ui/harness.mjs [--headed] [--only=<substring>]
// --only matches the screenshot file name, e.g. --only=panel-tasks-480-dark or --only=composer.
// Exits non-zero on page errors or layout problems (composer not flush, overlap, clipping).
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const shots = join(here, "screenshots");
const headed = process.argv.includes("--headed");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// 1. Bundle the UI entry points only (the background may be mid-refactor).
const out = mkdtempSync(join(tmpdir(), "browsertodo-ui-"));
const common = { bundle: true, platform: "browser", target: "chrome120", format: "esm", logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "src/sidepanel/sidepanel.ts")], outfile: join(out, "sidepanel.js") });
await build({ ...common, entryPoints: [join(root, "src/options/options.ts")], outfile: join(out, "options.js") });
cpSync(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(out, "xterm.css"));
for (const f of ["sidepanel.html", "options.html", "ui.css", "sidepanel.css", "options.css"]) {
  cpSync(join(root, "static", f), join(out, f));
}

// 2. Static server.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  try {
    const file = join(out, new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "sidepanel.html");
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// 3. Canned data.
const browser = await chromium.launch({ headless: !headed });

// A small JPEG "screenshot" for thumbnails.
const thumbPage = await browser.newPage({ viewport: { width: 320, height: 200 } });
await thumbPage.setContent(
  `<body style="margin:0;font:14px system-ui;background:#fff"><div style="background:#000;color:#fff;padding:10px">X</div>
   <div style="padding:12px">What's happening?<div style="margin-top:40px;float:right;background:#1d9bf0;color:#fff;border-radius:16px;padding:6px 14px">Post</div></div></body>`,
);
const thumbnail = (await thumbPage.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
await thumbPage.close();

function scenario(kind) {
  const now = Date.now();
  const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const helper = {
    version: "0.2.0",
    jevAvailable: true,
    claudePath: "C:\\Users\\me\\.local\\bin\\claude.exe",
    logDir: "C:\\Users\\me\\AppData\\Local\\browsertodo\\logs",
    ptyAvailable: true,
    selfTest: { ok: true, ms: 5300, at: iso(-30) },
  };
  const running = {
    sessionId: "s-live",
    source: "local",
    taskId: "t2",
    title: "Post the launch thread on X from @browsertodo and reply to the first comment",
    brain: "claude-api",
    jev: true,
    startedAt: iso(-2),
  };
  const settings = {
    brain: "auto", anthropicApiKey: "set", anthropicModel: "claude-sonnet-5", jevApiKey: "", cloudEnabled: false,
    apiBase: "", runnerKey: "", maxConsecutiveFailures: 3, retryAfterMinutes: 10, intervalMinutes: 15,
    delayMinSec: 60, delayMaxSec: 180, maxToolCalls: 60, maxTaskMinutes: 10, jevEnabled: true, jevThreshold: 0.8,
    paused: false, pauseRetryMinutes: 15,
  };
  const state = {
    settings,
    brain: { effective: "claude-api", helper, hasApiKey: true, jevActive: true },
    running,
    paused: false,
    nextRunAt: iso(12),
    lastRunAt: iso(-3),
    terminal: null,
  };
  if (kind === "idle" || kind === "empty") state.running = null;
  if (kind === "nobrain") {
    state.brain = { effective: null, note: "No brain available: add a Claude API key, or install the helper for Claude Code.", helper: null, helperError: "Specified native messaging host not found.", hasApiKey: false, jevActive: false };
    state.running = null;
    settings.anthropicApiKey = "";
  }
  if (kind === "paused") {
    state.paused = true;
    state.pausedReason = "3 tasks failed in a row (last: could not verify the post)";
    state.running = null;
  }
  const task = (id, status, instructions, extra = {}) => ({
    id, instructions, status, account: null, mediaIds: [], notBefore: null, priority: 0, attempts: 0,
    leaseOwner: null, leaseExpiresAt: null, retryAfter: null, resultSummary: null, resultUrl: null,
    resultScreenshotId: null, pauseReason: null, failReason: null, createdAt: iso(-600), updatedAt: iso(-60),
    repeat: null, media: [], ...extra,
  });
  const tasks = [
    task("t2", "running", running.title, { account: "browsertodo" }),
    task("t1", "pending", "Reply to new mentions with a short thank-you\nKeep it friendly.", { account: "browsertodo", notBefore: iso(95), repeat: { dailyAt: ["09:00", "18:00"] } }),
    task("t3", "pending", "Post the photo of the week with the caption from the doc", { media: [{ id: "m1", name: "week38.jpg", type: "image/jpeg", size: 184000 }] }),
    task("t4", "pending", "Like the three newest posts from @anthropic", { retryAfter: iso(8), attempts: 1 }),
    task("t5", "paused", "Log in to example.com and download the September invoice", { pauseReason: "Needs a one-time code sent by SMS" }),
    task("t6", "done", "Post 'good morning' on X", { account: "browsertodo", resultUrl: "https://x.com/browsertodo/status/1838912345678901234", updatedAt: iso(-180) }),
    task("t7", "failed", "Share yesterday's blog post on LinkedIn", { failReason: "LinkedIn asked for a captcha", updatedAt: iso(-1500) }),
  ];
  const ev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-live" });
  const events = [
    ev(-2, { type: "status", text: "Started with Claude API + Jev" }),
    ev(-2, { type: "assistant_text", text: "I'll open X, check that the right account is active, then write the thread." }),
    ev(-2, { type: "tool_call", id: "1", name: "switch_x_account", args: { handle: "@browsertodo" } }),
    ev(-2, { type: "tool_result", id: "1", name: "switch_x_account", text: "Already on @browsertodo" }),
    ev(-2, { type: "tool_call", id: "2", name: "navigate", args: { url: "https://x.com/compose/post" } }),
    ev(-2, { type: "tool_result", id: "2", name: "navigate", text: "Opened https://x.com/compose/post (title: Compose new post / X)" }),
    ev(-1, { type: "tool_call", id: "3", name: "act", args: { steps: [{ goal: "focus the post text box" }, { goal: "type the first post", text: "We just shipped..." }, { goal: "add another post to the thread" }] } }),
    ev(-1, { type: "jev", goal: "focus the post text box", operation: "click", index: 14, confidence: 0.97, executed: true, ms: 184 }),
    ev(-1, { type: "jev", goal: "type the first post", operation: "type", index: 14, confidence: 0.93, executed: true, ms: 211 }),
    ev(-1, { type: "jev", goal: "add another post to the thread", operation: "click", index: null, confidence: 0.42, executed: false, ms: 176 }),
    ev(-1, { type: "tool_result", id: "3", name: "act", text: "step 1 ok\nstep 2 ok\nstep 3 not confident: no element matched 'add another post'. Use click/type.\n" + "[12] button \"Add post\"\n[13] button \"Post all\"\n".repeat(3) }),
    ev(-1, { type: "tool_call", id: "4", name: "screenshot", args: {} }),
    ev(-1, { type: "tool_result", id: "4", name: "screenshot", thumbnail }),
    ev(-1, { type: "user_message", text: "Use the second draft for the last post, please" }),
    ev(0, { type: "assistant_text", text: "Got it, switching the last post to the second draft." }),
    ev(0, { type: "tool_call", id: "5", name: "type", args: { index: 22, text: "Try it: add a task, close the laptop lid, and it still posts on time." } }),
  ];
  const sessions = [
    running,
    { sessionId: "s-2", source: "local", taskId: "t6", title: "Post 'good morning' on X", brain: "claude-code", jev: false, startedAt: iso(-182), endedAt: iso(-180), outcome: "done", url: "https://x.com/browsertodo/status/1838912345678901234" },
    { sessionId: "s-3", source: "adhoc", title: "Find the cheapest flight to Lisbon next weekend", brain: "claude-api", jev: true, startedAt: iso(-400), endedAt: iso(-390), outcome: "paused", reason: "Needs you to pick dates" },
    { sessionId: "s-4", source: "local", taskId: "t7", title: "Share yesterday's blog post on LinkedIn", brain: "claude-api", jev: true, startedAt: iso(-1502), endedAt: iso(-1500), outcome: "failed", reason: "LinkedIn asked for a captcha" },
  ];
  if (kind === "idle") tasks[0] = { ...tasks[0], status: "pending", notBefore: iso(40) };
  if (kind === "empty") tasks.splice(0, tasks.length);
  return { state, tasks, events, sessions, pastEvents: events.slice(0, 6).map((e) => ({ ...e, sessionId: "s-2" })) };
}

/** Runs in the page before any script: a minimal chrome.runtime. */
function installChromeStub(data) {
  const pushListeners = [];
  const results = {
    "state.get": () => data.state,
    "settings.save": (req) => {
      const s = { ...data.state.settings, ...req.settings };
      for (const k of ["anthropicApiKey", "jevApiKey", "runnerKey"]) if (k in req.settings) s[k] = req.settings[k] ? "set" : "";
      data.state = { ...data.state, settings: s };
      return data.state;
    },
    "settings.testClaude": () => ({ ok: true, detail: "Claude answered in 1.2 s (claude-sonnet-5)." }),
    "settings.testJev": () => ({ ok: false, detail: "No Jev key set." }),
    "settings.testCloud": () => ({ ok: true, detail: "Server reachable, runner key accepted." }),
    "helper.connect": () => data.state,
    "run.adhoc": () => ({ sessionId: "s-new" }),
    "run.due": () => ({ started: false, detail: "Nothing is due right now." }),
    "run.stop": () => ({ ok: true }),
    "run.say": () => ({ ok: true }),
    "agent.show": () => ({ ok: true }),
    "schedule.pause": () => ({ ...data.state, paused: true }),
    "schedule.resume": () => ({ ...data.state, paused: false }),
    "tasks.list": () => ({ tasks: data.tasks }),
    "tasks.add": () => ({ task: data.tasks[0] }),
    "tasks.delete": () => ({ ok: true }),
    "tasks.retry": () => ({ task: data.tasks[0] }),
    "sessions.list": () => ({ sessions: data.sessions }),
    "sessions.events": (req) =>
      req.sessionId === "s-live"
        ? { session: data.sessions[0], events: data.events }
        : { session: data.sessions.find((s) => s.sessionId === req.sessionId), events: data.pastEvents },
    "terminal.start": () => ({ terminalId: "term-1" }),
    "terminal.input": () => ({ ok: true }),
    "terminal.resize": () => ({ ok: true }),
    "terminal.stop": () => ({ ok: true }),
    "vault.list": () => ({ locked: false, sites: ["example.com", "news.ycombinator.com"] }),
    "vault.unlock": () => ({ ok: true }),
    "vault.lock": () => ({ ok: true }),
    "vault.set": () => ({ ok: true }),
    "vault.delete": () => ({ ok: true }),
  };
  window.__requests = [];
  window.__push = (msg) => pushListeners.forEach((l) => l(msg));
  window.chrome = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      sendMessage: async (req) => {
        window.__requests.push(req);
        const fn = results[req.type];
        return fn ? { ok: true, data: fn(req) } : { ok: false, error: `unknown request ${req.type}` };
      },
      connect: () => ({
        onMessage: { addListener: (l) => pushListeners.push(l) },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
      openOptionsPage: () => {},
    },
  };
}

// Fake Claude Code TUI output.
const TERM_DATA = [
  "\x1b[38;5;208m╭───────────────────────────────────────────╮\x1b[0m\r\n",
  "\x1b[38;5;208m│\x1b[0m \x1b[1m✻ Welcome to Claude Code!\x1b[0m                 \x1b[38;5;208m│\x1b[0m\r\n",
  "\x1b[38;5;208m│\x1b[0m   cwd: ~\\AppData\\Local\\browsertodo\\workspace\x1b[38;5;208m│\x1b[0m\r\n",
  "\x1b[38;5;208m╰───────────────────────────────────────────╯\x1b[0m\r\n\r\n",
  "\x1b[2m> \x1b[0mopen x.com and tell me my newest notification\r\n\r\n",
  "\x1b[32m●\x1b[0m \x1b[1mbrowsertodo:navigate\x1b[0m(url: \"https://x.com/notifications\")\r\n",
  "  \x1b[2m⎿  Opened https://x.com/notifications\x1b[0m\r\n\r\n",
  "\x1b[32m●\x1b[0m \x1b[1mbrowsertodo:read_page\x1b[0m\r\n",
  "  \x1b[2m⎿  84 elements\x1b[0m\r\n\r\n",
  "\x1b[37m●\x1b[0m Your newest notification: \x1b[1m@anthropic\x1b[0m liked your post “We just shipped…”.\r\n\r\n",
  "\x1b[2m────────────────────────────────────────────\x1b[0m\r\n> \x1b[7m \x1b[0m\r\n",
];

const SIZES = [
  { w: 360, h: 800 },
  { w: 480, h: 900 },
];
const SCHEMES = ["light", "dark"];
mkdirSync(shots, { recursive: true });
const taken = [];

/** True when --only is unset or matches the screenshot file name for this size and scheme. */
const want = (name, size, scheme) => !only || `${name}-${size.w}-${scheme}`.includes(only);
const wantAny = (names, size, scheme) => names.some((n) => want(n, size, scheme));
let failures = 0;

async function shoot(page, name, size, scheme) {
  if (!want(name, size, scheme)) return;
  const file = join(shots, `${name}-${size.w}-${scheme}.png`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: file });
  taken.push(file);
}

async function openPanel(ctx, kind, waitFor = ".task") {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(installChromeStub, scenario(kind));
  await page.goto(`${base}/sidepanel.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(waitFor);
  page.errors = errors;
  return page;
}

function reportErrors(page, label) {
  if (!page.errors.length) return;
  console.error(`page errors (${label}):`, page.errors);
  failures++;
}

/** The composer sits flush at the bottom, nothing overlaps it, nothing in it is clipped. */
async function checkLayout(page, label) {
  const problems = await page.evaluate(() => {
    const out = [];
    const comp = document.getElementById("composer");
    const main = document.querySelector("main");
    if (document.documentElement.scrollWidth > window.innerWidth) out.push("horizontal page scroll");
    if (comp.hidden) return out;
    const c = comp.getBoundingClientRect();
    if (Math.abs(c.bottom - window.innerHeight) > 1) out.push(`composer bottom ${c.bottom} != viewport ${window.innerHeight}`);
    if (main.getBoundingClientRect().bottom > c.top + 1) out.push("main overlaps the composer");
    for (const el of comp.querySelectorAll("button, input:not([type=file]), label, textarea")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > c.right + 0.5 || r.left < c.left - 0.5) out.push(`#${el.id} clipped horizontally`);
    }
    return out;
  });
  if (!problems.length) return;
  console.error(`layout (${label}):`, problems);
  failures++;
}

const LONG_TEXT = [
  "Post the launch thread on X from @browsertodo:",
  "1. We just shipped browsertodo 0.2",
  "2. It runs your todo list in the browser, on a schedule",
  "3. Try it: add a task, close the laptop lid, and it still posts on time.",
  "4. Link to the blog post",
  "5. Thank the beta testers",
  "6. Pin the thread",
  "7. Reply to the first comment",
  "8. Like the replies from people we follow",
  "9. Tell me when it is done",
].join("\n");

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme, deviceScaleFactor: 1 });
    const label = `${size.w} ${scheme}`;

    // Idle: nothing running, the composer starts a one-off task.
    if (wantAny(["panel-tasks-idle", "panel-composer-long", "panel-composer-files"], size, scheme)) {
      const p = await openPanel(ctx, "idle");
      await checkLayout(p, `idle ${label}`);
      await shoot(p, "panel-tasks-idle", size, scheme);
      if (want("panel-composer-long", size, scheme)) {
        await p.click("#now-text");
        await p.keyboard.insertText(LONG_TEXT);
        await p.fill("#now-account", "browsertodo");
        await checkLayout(p, `composer-long ${label}`);
        await shoot(p, "panel-composer-long", size, scheme);
        await p.fill("#now-text", "");
      }
      if (want("panel-composer-files", size, scheme)) {
        await p.setInputFiles("#now-files", [
          { name: "week38-photo-of-the-week-final.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") },
          { name: "caption.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
        ]);
        await p.click("#now-text");
        await p.keyboard.insertText("Post the photo of the week with this caption");
        await checkLayout(p, `composer-files ${label}`);
        await shoot(p, "panel-composer-files", size, scheme);
      }
      reportErrors(p, `idle ${label}`);
      await p.close();
    }

    // Empty todo list.
    if (want("panel-tasks-empty", size, scheme)) {
      const p = await openPanel(ctx, "empty", "#tasks-empty:not([hidden])");
      await checkLayout(p, `empty ${label}`);
      await shoot(p, "panel-tasks-empty", size, scheme);
      reportErrors(p, `empty ${label}`);
      await p.close();
    }

    // A running session: the composer talks to the agent (Send + Stop).
    const runningShots = ["panel-tasks", "panel-add-form", "panel-finished-menu", "panel-activity", "panel-history", "panel-past-session", "panel-terminal"];
    if (wantAny(runningShots, size, scheme)) {
      const page = await openPanel(ctx, "ok");
      await checkLayout(page, `tasks ${label}`);
      await shoot(page, "panel-tasks", size, scheme);
      if (want("panel-add-form", size, scheme)) {
        await page.click("#add-toggle");
        await page.fill("#add-text", "Post the weekly recap");
        await page.fill("#add-repeat", "9:00, 18:30");
        await checkLayout(page, `add ${label}`);
        await shoot(page, "panel-add-form", size, scheme);
        await page.click("#add-cancel");
      }
      if (want("panel-finished-menu", size, scheme)) {
        await page.locator("#finished > summary").click();
        await page.locator("#finished-list .menu summary").first().click();
        await page.locator("#finished-list .menu[open] .menu-pop").scrollIntoViewIfNeeded();
        await shoot(page, "panel-finished-menu", size, scheme);
        await page.locator("#tab-tasks .section-head h2").click();
      }
      if (wantAny(["panel-activity", "panel-history", "panel-past-session"], size, scheme)) {
        await page.click("#tab-btn-activity");
        await page.waitForSelector(".ev-tool");
        await page.locator("details.ev-result").first().evaluate((d) => (d.open = true));
        await page.locator("#act-log").evaluate((l) => (l.scrollTop = l.scrollHeight));
        await checkLayout(page, `activity ${label}`);
        await shoot(page, "panel-activity", size, scheme);
        await page.click("#act-show");
        if (!(await page.evaluate(() => window.__requests.some((r) => r.type === "agent.show")))) {
          console.error(`Show tab did not send agent.show (${label})`);
          failures++;
        }
        await page.click("#act-history");
        await page.waitForSelector(".sessions li");
        await checkLayout(page, `history ${label}`);
        await shoot(page, "panel-history", size, scheme);
        await page.locator(".sessions li button").nth(1).click();
        await page.waitForSelector(".ev-text");
        await shoot(page, "panel-past-session", size, scheme);
      }
      if (want("panel-terminal", size, scheme)) {
        await page.click("#tab-btn-terminal");
        if (!(await page.locator("#composer").isHidden())) {
          console.error(`composer visible on the Terminal tab (${label})`);
          failures++;
        }
        await page.click("#term-start");
        await page.waitForTimeout(100);
        for (const d of TERM_DATA) await page.evaluate((data) => window.__push({ type: "terminal.data", terminalId: "term-1", data }), d);
        await shoot(page, "panel-terminal", size, scheme);
      }
      reportErrors(page, `running ${label}`);
      await page.close();
    }

    // Warning states.
    if (wantAny(["panel-nobrain-tasks", "panel-nobrain-terminal"], size, scheme)) {
      const p = await openPanel(ctx, "nobrain");
      await checkLayout(p, `nobrain ${label}`);
      await shoot(p, "panel-nobrain-tasks", size, scheme);
      await p.click("#tab-btn-terminal");
      await shoot(p, "panel-nobrain-terminal", size, scheme);
      reportErrors(p, `nobrain ${label}`);
      await p.close();
    }
    if (want("panel-paused-idle-activity", size, scheme)) {
      const p = await openPanel(ctx, "paused");
      await p.click("#tab-btn-activity");
      await p.waitForSelector(".sessions li");
      await checkLayout(p, `paused ${label}`);
      await shoot(p, "panel-paused-idle-activity", size, scheme);
      reportErrors(p, `paused ${label}`);
      await p.close();
    }
    await ctx.close();
  }
}

// Options page: a wider viewport too, since it opens in a tab.
for (const scheme of SCHEMES) {
  for (const size of [{ w: 480, h: 900 }, { w: 1000, h: 1400 }]) {
    if (!want("options", size, scheme)) continue;
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("options error:", String(e)));
    await page.addInitScript(installChromeStub, scenario("ok"));
    await page.goto(`${base}/options.html`);
    await page.waitForSelector("#helper-headline:not(:empty)");
    await page.locator("[data-secret=jevApiKey] input").fill("jev-123");
    await page.check("#f-cloudEnabled");
    await page.locator("details.advanced").evaluateAll((els) => els.forEach((d) => (d.open = true)));
    await page.waitForTimeout(250); // let the switch transition finish
    await page.screenshot({ path: join(shots, `options-${size.w}-${scheme}.png`), fullPage: true });
    taken.push(join(shots, `options-${size.w}-${scheme}.png`));
    await ctx.close();
  }
}

// Options with nothing usable and a key marked for removal.
for (const scheme of SCHEMES) {
  if (!want("options-nobrain", { w: 480 }, scheme)) continue;
  const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("options error:", String(e)));
  const data = scenario("nobrain");
  data.state.settings.runnerKey = "set";
  data.state.settings.cloudEnabled = true;
  data.state.settings.apiBase = "https://tasks.example.com";
  await page.addInitScript(installChromeStub, data);
  await page.goto(`${base}/options.html`);
  await page.waitForSelector("#helper-headline:not(:empty)");
  await page.locator("[data-secret=runnerKey] button", { hasText: "Clear" }).click();
  await page.click("#test-jev");
  await page.waitForTimeout(200);
  const file = join(shots, `options-nobrain-480-${scheme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  taken.push(file);
  await ctx.close();
}

await browser.close();
server.close();
rmSync(out, { recursive: true, force: true });
console.log(`${taken.length} screenshots in ${shots}`);
if (failures) {
  console.error(`${failures} problem(s) found, see above`);
  process.exitCode = 1;
}
