// Visual harness for the side panel and options page, without the real background.
// Bundles only the UI entry points, serves them from a local static server, injects
// a `chrome` stub with canned data, and takes screenshots in light and dark mode.
//
// Usage: node apps/extension/test/ui/harness.mjs [--headed] [--only=<substring>]
// --only matches the screenshot file name, e.g. --only=panel-todo-480-dark or --only=composer.
// Exits non-zero on page errors or layout problems (composer not flush, overlap, clipping, wrapped bars).
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
    selfTest: { ok: true, ms: 5300, at: iso(-30) },
  };
  const running = {
    sessionId: "s-live",
    source: "local",
    taskId: "t2",
    title: "Post the launch thread on X from @browsertodo and reply to the first comment",
    brain: "claude-api",
    jev: true,
    model: "claude-sonnet-5",
    startedAt: iso(-2),
  };
  const settings = {
    brain: "auto", anthropicApiKey: "set", anthropicModel: "claude-sonnet-5", jevApiKey: "", cloudEnabled: false,
    apiBase: "", runnerKey: "", maxConsecutiveFailures: 3, retryAfterMinutes: 10, intervalMinutes: 15,
    delayMinSec: 60, delayMaxSec: 180, maxToolCalls: 60, maxTaskMinutes: 10, maxParallelTasks: 2, jevEnabled: true, jevThreshold: 0.8,
    paused: false, pauseRetryMinutes: 15, accountApiBase: "https://browsertodo-api.jaeyun.workers.dev",
  };
  const state = {
    settings,
    brain: { effective: "claude-api", helper, hasApiKey: true, jevActive: true },
    running,
    paused: false,
    nextRunAt: iso(12),
    lastRunAt: iso(-3),
    openConversations: [],
    // The panel is in window 1 and tab 1 is active; the running task acts in tab 1.
    tabChats: {},
    runningTabs: { "s-live": [1] },
  };
  // Signed in by default (the TODO tab shows the list); account scenarios below change it.
  const API = "https://browsertodo-api.jaeyun.workers.dev";
  const avatar =
    "data:image/svg+xml;utf8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#0f766e"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">A</text></svg>');
  const FREE = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false };
  const PLUS = { id: "plus", status: "active", currentPeriodEnd: iso(60 * 24 * 30), cancelAtPeriodEnd: false };
  const money = (sub, top, grant = 0) => ({ subscriptionCents: sub, topupCents: top, totalCents: sub + top, periodGrantCents: grant, periodEnd: grant ? iso(60 * 24 * 30) : null });
  state.account = {
    signedIn: true, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/`,
    user: { email: "ada.lovelace@example.com", name: "Ada Lovelace", pictureUrl: avatar },
    plan: FREE, credit: money(0, 0), stripeConfigured: true, fetchedAt: iso(0),
  };
  let tasksSource;
  let keys = [];
  if (kind === "loggedout" || kind === "loggedout-noclient") {
    state.account = { signedIn: false, signInConfigured: kind === "loggedout", apiBase: API, dashboardUrl: `${API}/` };
    state.running = null;
  }
  if (kind === "account" || kind === "hosted-out") {
    // Signed in on Plus: the TODO list is the account's, browsertodo AI runs tasks.
    state.running = null;
    state.brain = { effective: "browsertodo", helper, hasApiKey: false, jevActive: true };
    settings.anthropicApiKey = "";
    state.account = { ...state.account, plan: PLUS, credit: money(421, 1000, 2000), localTasks: 3 };
    tasksSource = "account";
  }
  if (kind === "hosted-out") {
    state.account = { ...state.account, plan: FREE, credit: money(0, 0), localTasks: undefined, outOfCredit: { topupUrl: `${API}/billing` } };
  }
  if (kind === "opt-free") state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
  if (kind === "opt-paid") {
    state.account = { ...state.account, plan: PLUS, credit: money(1540, 1000, 2000) };
    keys = [
      { id: "k1", name: "laptop chrome", role: "runner", createdAt: iso(-60 * 24 * 12), revokedAt: null },
      { id: "k2", name: "weekly scheduler script", role: "creator", createdAt: iso(-60 * 24 * 3), revokedAt: null },
    ];
  }
  if (kind === "opt-out") state.account = { ...state.account, plan: FREE, credit: money(0, 0), outOfCredit: { topupUrl: `${API}/billing` } };
  if (kind === "opt-nobilling") state.account = { ...state.account, plan: FREE, credit: money(0, 0), stripeConfigured: false };
  if (kind === "opt-signedout") state.account = { signedIn: false, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/` };
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
  const eventsBySession = {};
  if (kind === "parallel") {
    // Two due tasks run at once, each in its own tab.
    const second = {
      sessionId: "s-par2", source: "local", taskId: "t3", title: "Post the photo of the week with the caption from the doc",
      brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: iso(-1),
    };
    const pev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-par2" });
    eventsBySession["s-par2"] = [
      pev(-1, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
      pev(-1, { type: "assistant_text", text: "Opening the doc to copy the caption." }),
      pev(-1, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://docs.example.com/d/week38" } }),
      pev(-1, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://docs.example.com/d/week38 (title: Week 38 caption)" }),
    ];
    state.runningSessions = [running, second];
    state.runningTabs = { "s-live": [1], "s-par2": [2] };
    sessions.unshift(second);
    tasks[2] = { ...tasks[2], status: "running" };
  }
  if (kind === "tabs") {
    // A one-off chat runs in tab 1 (it belongs there); tab 2 has no chat yet.
    running.source = "adhoc";
    running.title = "Summarize this pull request and post the summary as a comment";
    state.tabChats = { "1": "s-live" };
    state.runningTabs = { "s-live": [1] };
  }
  if (kind === "conversation") {
    // A one-off conversation with two turns: the second started with the user's message.
    const conv = {
      sessionId: "s-conv", source: "adhoc", title: "Post on X from @alpha: our launch is live", brain: "claude-code", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-2), endedAt: iso(-1), firstStartedAt: iso(-6), outcome: "done", turns: 2,
      summary: "Liked the first reply", url: "https://x.com/alpha/status/1838912345678901299",
      logPath: "C:\\Users\\me\\AppData\\Local\\browsertodo\\runs\\s-conv-2026\\log.jsonl",
    };
    const cev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-conv" });
    eventsBySession["s-conv"] = [
      cev(-6, { type: "status", text: "Claude Code started (claude-sonnet-5)" }),
      cev(-6, { type: "assistant_text", text: "I'll switch to @alpha and post it." }),
      cev(-6, { type: "tool_call", id: "1", name: "switch_x_account", args: { handle: "@alpha" } }),
      cev(-6, { type: "tool_result", id: "1", name: "switch_x_account", text: "Switched to @alpha" }),
      cev(-5, { type: "tool_call", id: "2", name: "act", args: { steps: [{ goal: "type into the Post text box", text: "Our launch is live" }, { goal: "click the Post button in the composer" }] } }),
      cev(-5, { type: "jev", goal: "type into the Post text box", operation: "type", index: 14, confidence: 0.99, executed: true, ms: 96 }),
      cev(-5, { type: "jev", goal: "click the Post button in the composer", operation: "click", index: 22, confidence: 0.98, executed: true, ms: 81 }),
      cev(-5, { type: "tool_result", id: "2", name: "act", text: "step 1 ok\nstep 2 ok" }),
      cev(-5, { type: "status", text: "Jev chose 2 of 2 element picks (clicks and typing)", picks: { jev: 2, claude: 0 } }),
      cev(-5, { type: "status", text: "Post verified" }),
      cev(-5, { type: "task_end", outcome: "done", summary: "Posted from @alpha", url: "https://x.com/alpha/status/1838912345678901234" }),
      cev(-2, { type: "user_message", text: "Now like the first reply to it" }),
      cev(-2, { type: "status", text: "Continuing the same Claude Code session" }),
      cev(-2, { type: "assistant_text", text: "Opening the post and liking the first reply." }),
      cev(-2, { type: "tool_call", id: "3", name: "navigate", args: { url: "https://x.com/alpha/status/1838912345678901234" } }),
      cev(-2, { type: "tool_result", id: "3", name: "navigate", text: "Opened https://x.com/alpha/status/1838912345678901234" }),
      cev(-1, { type: "tool_call", id: "4", name: "act", args: { steps: [{ goal: "click the Like button under the first reply" }] } }),
      cev(-1, { type: "jev", goal: "click the Like button under the first reply", operation: "click", index: 31, confidence: 0.62, executed: false, ms: 120 }),
      cev(-1, { type: "tool_result", id: "4", name: "act", text: "not confident at step 1" }),
      cev(-1, { type: "tool_call", id: "5", name: "act", args: { steps: [{ goal: "click the Like button under the first reply", index: 31 }] } }),
      cev(-1, { type: "tool_result", id: "5", name: "act", text: "step 1: clicked [31] (picked by Claude)" }),
      cev(-1, { type: "status", text: "Jev chose 0 of 1 element pick (clicks and typing); Claude chose 1", picks: { jev: 0, claude: 1 } }),
      cev(-1, { type: "task_end", outcome: "done", summary: "Liked the first reply", url: "https://x.com/alpha/status/1838912345678901299" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-conv" };
    state.brain = { ...state.brain, effective: "claude-code", jevActive: false };
    state.openConversations = ["s-conv"];
    sessions.unshift(conv);
    sessions.splice(1, 1);
  }
  if (kind === "stopped") {
    // The user pressed Stop after the agent typed the post: the run ends paused "stopped by user".
    const stopped = {
      sessionId: "s-stop", source: "adhoc", title: "make a post on X for me about how browsertodo keeps posting while the laptop sleeps",
      brain: "claude-code", jev: false, startedAt: iso(-3),
    };
    const post = "Close the laptop lid, and browsertodo still posts on time. Your todo list runs in your own browser, on a schedule, with your own accounts. Try it";
    const sev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-stop" });
    eventsBySession["s-stop"] = [
      sev(-3, { type: "status", text: "Started with Claude Code" }),
      sev(-3, { type: "assistant_text", text: "I'll open X and write the post." }),
      sev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/home" } }),
      sev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://x.com/home (title: Home / X)" }),
      sev(-2, { type: "tool_call", id: "2", name: "click", args: { index: 31 } }),
      sev(-2, { type: "tool_result", id: "2", name: "click", text: "clicked [31] textbox \"Post text\"" }),
      sev(-2, { type: "tool_call", id: "3", name: "type", args: { index: 31, text: post } }),
      sev(-2, { type: "tool_result", id: "3", name: "type", text: `typed ${post.length} characters` }),
    ];
    eventsBySession["s-3"] = [
      { type: "assistant_text", text: "Searching flights to Lisbon for next weekend." },
      { type: "tool_call", id: "1", name: "navigate", args: { url: "https://www.google.com/travel/flights" } },
      { type: "tool_result", id: "1", name: "navigate", text: "Opened https://www.google.com/travel/flights" },
      { type: "task_end", outcome: "paused", reason: "Needs you to pick dates" },
    ].map((e) => ({ ...e, ts: iso(-395), sessionId: "s-3" }));
    state.running = stopped;
    state.tabChats = { "1": "s-stop" };
    state.runningTabs = { "s-stop": [1] };
    tasks[0] = { ...tasks[0], status: "pending", notBefore: iso(40) };
    tasks[4] = { ...tasks[4], attempts: 1 };
    sessions.unshift({ ...stopped, endedAt: iso(-1), outcome: "paused", reason: "stopped by user" });
    sessions.splice(1, 1);
    sessions.push({ sessionId: "s-5", source: "local", taskId: "t5", title: tasks[4].instructions, brain: "claude-api", jev: true, startedAt: iso(-70), endedAt: iso(-60), outcome: "paused", reason: "Needs a one-time code sent by SMS" });
  }
  if (kind === "hosted-out") {
    // The last run hit the end of the AI credit: paused, with a Top up link.
    const out = {
      sessionId: "s-out", source: "adhoc", title: "Summarize the three newest issues on the tracker", brain: "browsertodo", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-3), endedAt: iso(-2), outcome: "paused", reason: "Out of AI credit",
    };
    const oev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-out" });
    eventsBySession["s-out"] = [
      oev(-3, { type: "status", text: "browsertodo AI (claude-sonnet-5) with Jev" }),
      oev(-3, { type: "assistant_text", text: "Opening the tracker." }),
      oev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://tracker.example.com/issues" } }),
      oev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://tracker.example.com/issues" }),
      oev(-2, { type: "error", text: "Out of AI credit: No AI credit left" }),
      oev(-2, { type: "task_end", outcome: "paused", reason: "Out of AI credit" }),
    ];
    sessions.unshift(out);
    state.tabChats = { "1": "s-out" };
    tasks[0] = { ...tasks[0], status: "paused", pauseReason: "Out of AI credit", attempts: 1 };
  }
  if (kind === "details") {
    // The running task has long instructions with links, files and an account; a one-off chat has a multi-line message.
    const text = [
      "Post the launch thread on X from @browsertodo and reply to the first comment.",
      "",
      "1. We just shipped browsertodo 0.2: https://browsertodo.example.com/blog/2026/09/launch-of-browsertodo-0-2-with-scheduled-runs?utm_source=x&utm_campaign=launch",
      "2. It runs your todo list in the browser, on a schedule",
      "3. Pin the thread",
      "",
      "If the first comment asks about pricing, link https://browsertodo.example.com/pricing.",
    ].join("\n");
    const one = text.replace(/\s+/g, " ").trim();
    running.title = one.length > 80 ? `${one.slice(0, 79)}…` : one;
    tasks[0] = {
      ...tasks[0], instructions: text, attempts: 1,
      media: [
        { id: "m7", name: "launch-banner-final-v3.png", type: "image/png", size: 482133 },
        { id: "m8", name: "thread.txt", type: "text/plain", size: 1210 },
      ],
    };
    tasks[1] = { ...tasks[1], media: [{ id: "m9", name: "thank-you.gif", type: "image/gif", size: 90112 }] };
    const lisbon = sessions.find((x) => x.sessionId === "s-3");
    lisbon.instructions = "Find the cheapest flight to Lisbon next weekend.\nLeave Friday after 17:00, back Sunday night.\nCompare https://www.google.com/travel/flights and https://www.skyscanner.net/transport/flights/ber/lis/ before picking.";
    lisbon.model = "claude-sonnet-5";
  }
  // Nothing runs in tab 1 when the default run is not running.
  if (state.running?.sessionId !== "s-live") delete state.runningTabs["s-live"];
  return { state, tasks, tasksSource, keys, events, sessions, eventsBySession, pastEvents: events.slice(0, 6).map((e) => ({ ...e, sessionId: "s-2" })) };
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
    "run.adhoc": (req) => {
      const s = { sessionId: "s-new", source: "adhoc", title: req.instructions, brain: "claude-api", jev: true, startedAt: new Date().toISOString() };
      data.sessions = [s, ...data.sessions.filter((x) => x.sessionId !== "s-new")];
      data.eventsBySession = { ...(data.eventsBySession ?? {}), "s-new": [] };
      return { sessionId: "s-new" };
    },
    "run.due": () => ({ started: false, detail: "Nothing is due right now." }),
    "run.stop": () => ({ ok: true }),
    "run.continue": (req) => ({ sessionId: req.sessionId }),
    "run.message": (req) => ({ sessionId: req.sessionId ?? "s-new", mode: req.sessionId ? "turn" : "new" }),
    "run.newChat": (req) => {
      if (req.tabId !== undefined && data.state.tabChats?.[req.tabId] === req.sessionId) {
        const rest = { ...data.state.tabChats };
        delete rest[req.tabId];
        data.state = { ...data.state, tabChats: rest };
      }
      return { ok: true };
    },
    "chat.bind": (req) => {
      const rest = Object.fromEntries(Object.entries(data.state.tabChats ?? {}).filter(([, id]) => id !== req.sessionId));
      data.state = { ...data.state, tabChats: { ...rest, [req.tabId]: req.sessionId } };
      return data.state;
    },
    "tab.focus": (req) => {
      setTimeout(() => window.__activateTab(req.tabId), 0);
      return { ok: true };
    },
    "session.log": () => ({ path: "C:\\runs\\s-conv\\log.jsonl", text: '{"type":"task_start"}\n', truncated: false }),
    "agent.show": () => ({ ok: true }),
    "schedule.pause": () => ({ ...data.state, paused: true }),
    "schedule.resume": () => ({ ...data.state, paused: false }),
    "tasks.list": () => ({ tasks: data.tasks, ...(data.tasksSource ? { source: data.tasksSource } : {}) }),
    "tasks.cancel": (req) => ({ task: { ...data.tasks.find((t) => t.id === req.id), status: "cancelled" } }),
    "account.signIn": () => {
      data.state = { ...data.state, account: { ...data.state.account, signedIn: true, user: { email: "ada.lovelace@example.com", name: "Ada Lovelace", pictureUrl: null } } };
      return data.state;
    },
    "account.signOut": () => {
      const a = data.state.account;
      data.state = { ...data.state, account: { signedIn: false, signInConfigured: a.signInConfigured, apiBase: a.apiBase, dashboardUrl: a.dashboardUrl } };
      return data.state;
    },
    "account.refresh": () => data.state,
    "account.migrate": () => {
      const moved = data.state.account.localTasks ?? 0;
      data.state = { ...data.state, account: { ...data.state.account, localTasks: undefined } };
      return { moved, failed: 0, errors: [], state: data.state };
    },
    "account.dismissMigration": () => {
      data.state = { ...data.state, account: { ...data.state.account, localTasks: undefined } };
      return data.state;
    },
    "account.billing": () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_harness" }),
    "account.keys.list": () => ({ keys: data.keys ?? [] }),
    "account.keys.create": (req) => {
      const k = { id: `k${(data.keys?.length ?? 0) + 1}`, name: req.name, role: req.role, createdAt: new Date().toISOString(), revokedAt: null };
      data.keys = [...(data.keys ?? []), k];
      return { id: k.id, name: k.name, role: k.role, key: "bt_EXAMPLE_not_a_real_key_0000000000000000" };
    },
    "account.keys.revoke": (req) => {
      data.keys = (data.keys ?? []).filter((k) => k.id !== req.id);
      return { ok: true };
    },
    "tasks.add": () => ({ task: data.tasks[0] }),
    "tasks.delete": () => ({ ok: true }),
    "tasks.retry": () => ({ task: data.tasks[0] }),
    "sessions.list": () => ({ sessions: data.sessions }),
    "sessions.events": (req) =>
      data.eventsBySession?.[req.sessionId]
        ? { session: data.sessions.find((s) => s.sessionId === req.sessionId) ?? data.state.running, events: data.eventsBySession[req.sessionId] }
        : req.sessionId === "s-live"
        ? { session: data.sessions[0], events: data.events }
        : { session: data.sessions.find((s) => s.sessionId === req.sessionId), events: data.pastEvents },
    "vault.list": () => ({ locked: false, sites: ["example.com", "news.ycombinator.com"] }),
    "vault.unlock": () => ({ ok: true }),
    "vault.lock": () => ({ ok: true }),
    "vault.set": () => ({ ok: true }),
    "vault.delete": () => ({ ok: true }),
  };
  window.__requests = [];
  window.__opened = [];
  window.open = (url) => void window.__opened.push(url);
  window.__push = (msg) => {
    // A pushed state is the background's state from then on.
    if (msg.type === "state") data.state = msg.state;
    pushListeners.forEach((l) => l(msg));
  };
  // One window (1) with tabs; tab 1 is active. __activateTab(n) is the user switching tabs.
  const tabListeners = [];
  let activeTabId = 1;
  window.__activateTab = (tabId) => {
    activeTabId = tabId;
    tabListeners.forEach((l) => l({ tabId, windowId: 1 }));
  };
  const noEvent = { addListener: () => {} };
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
    tabs: {
      query: async () => [{ id: activeTabId, windowId: 1, active: true }],
      onActivated: { addListener: (l) => tabListeners.push(l) },
      onAttached: noEvent,
      onDetached: noEvent,
    },
    windows: { getCurrent: async () => ({ id: 1 }), onFocusChanged: noEvent },
  };
}

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

async function openPanel(ctx, kind, waitFor = "#chat-log > *") {
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(installChromeStub, scenario(kind));
  await page.goto(`${base}/sidepanel.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  try {
    await page.waitForSelector(waitFor);
  } catch (err) {
    console.error(`panel did not load (${kind}):`, errors);
    throw err;
  }
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
    // The tab row and the Chat action bar each stay on one line, inside the panel.
    const one = (sel, what) => {
      const row = document.querySelector(sel);
      if (!row || !row.offsetParent) return;
      const r = row.getBoundingClientRect();
      const kids = [...row.children].filter((k) => k.getBoundingClientRect().width);
      const top = kids[0]?.getBoundingClientRect().top;
      for (const k of kids) {
        const b = k.getBoundingClientRect();
        if (Math.abs(b.top - top) > 1 && !k.classList.contains("bar-sep")) out.push(`${what}: ${k.id || k.textContent.trim()} wraps`);
        if (b.right > r.right + 0.5) out.push(`${what}: ${k.id || k.textContent.trim()} clipped`);
      }
    };
    one(".tabs", "tab row");
    one(".chat-bar", "chat bar");
    const tab = document.querySelector(".tabs [aria-selected=true]")?.dataset.tab;
    const loginOnly = tab === "todo" && document.getElementById("tab-todo").dataset.auth === "out";
    if (comp.hidden !== (tab === "history" || loginOnly)) out.push(`composer ${comp.hidden ? "hidden" : "shown"} on the ${tab} tab${loginOnly ? " (Log In)" : ""}`);
    if (comp.hidden) return out;
    const c = comp.getBoundingClientRect();
    if (Math.abs(c.bottom - window.innerHeight) > 1) out.push(`composer bottom ${c.bottom} != viewport ${window.innerHeight}`);
    if (main.getBoundingClientRect().bottom > c.top + 1) out.push("main overlaps the composer");
    for (const el of comp.querySelectorAll("button, input:not([type=file]), label, textarea")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > c.right + 0.5 || r.left < c.left - 0.5) out.push(`#${el.id} clipped horizontally`);
    }
    // The model chip sits on one row with the other controls.
    const bar = comp.querySelector(".now-bar").getBoundingClientRect();
    for (const el of comp.querySelectorAll(".now-bar > *:not([hidden])")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5)) out.push(`${el.id || el.className} wraps out of the control row`);
    }
    const menu = document.getElementById("model-menu");
    if (!menu.hidden) {
      const m = menu.getBoundingClientRect();
      if (m.left < 0 || m.right > window.innerWidth || m.top < 0) out.push("model menu off screen");
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

    const fail = (what) => {
      console.error(`${what} (${label})`);
      failures++;
    };
    /** The Chat action bar: each button's label, whether it can be used, and its tooltip. */
    const chatBar = (p) =>
      p.evaluate(() =>
        Object.fromEntries(
          ["chat-new", "chat-show", "chat-rawlog"].map((id) => {
            const b = document.getElementById(id);
            return [id, { text: b.textContent, on: b.getAttribute("aria-disabled") !== "true", title: b.title }];
          }),
        ),
      );
    const expectBar = async (p, want, what) => {
      const bar = await chatBar(p);
      const order = await p.evaluate(() => [...document.querySelectorAll(".chat-bar .bar-btn")].map((b) => b.textContent).join(" | "));
      if (order !== "New Chat | Show Tab | Raw Log") fail(`chat bar order "${order}"`);
      for (const [id, on] of Object.entries(want)) {
        if (bar[id].on !== on) fail(`${what}: #${id} ${bar[id].on ? "enabled" : "disabled"}`);
        if (!bar[id].title) fail(`${what}: #${id} has no tooltip`);
      }
      return bar;
    };
    /** Every status chip explains itself. */
    const expectChipHints = async (p, what) => {
      const bare = await p.evaluate(() => [...document.querySelectorAll(".chip")].filter((c) => c.offsetParent && !c.title && !c.closest(".ev-jev")).map((c) => c.textContent));
      if (bare.length) fail(`${what}: chips without a tooltip: ${bare.join(", ")}`);
    };
    const tabsText = (p) => p.evaluate(() => [...document.querySelectorAll(".tabs [role=tab]")].map((t) => t.textContent.trim()).join(" | "));

    // Idle: nothing running. Chat is the default tab and shows an empty new chat; the composer starts a one-off task.
    if (wantAny(["panel-chat-idle", "panel-composer-long", "panel-model-menu", "panel-composer-files"], size, scheme)) {
      const p = await openPanel(ctx, "idle", ".chat-empty");
      if ((await tabsText(p)) !== "Chat | TODO | Activity Log") fail(`tabs "${await tabsText(p)}"`);
      const bar = await expectBar(p, { "chat-new": false, "chat-show": false, "chat-rawlog": false }, "idle chat");
      if (!/already a new chat/.test(bar["chat-new"].title)) fail(`New Chat tooltip "${bar["chat-new"].title}"`);
      // Disabled bar buttons do nothing.
      await p.click("#chat-show", { force: true });
      await p.click("#chat-rawlog", { force: true });
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "agent.show" || r.type === "session.log"))) fail("disabled bar button sent a request");
      await checkLayout(p, `idle ${label}`);
      await shoot(p, "panel-chat-idle", size, scheme);
      if (want("panel-composer-long", size, scheme)) {
        await p.click("#now-text");
        await p.keyboard.insertText(LONG_TEXT);
        await checkLayout(p, `composer-long ${label}`);
        await shoot(p, "panel-composer-long", size, scheme);
        await p.fill("#now-text", "");
      }
      if (want("panel-model-menu", size, scheme)) {
        const chip = p.locator("#now-model");
        if ((await chip.textContent()).trim() !== "Sonnet 5 · Jev") fail(`model chip shows "${(await chip.textContent()).trim()}"`);
        await chip.click();
        await p.waitForSelector("#model-menu:not([hidden])");
        await checkLayout(p, `model-menu ${label}`);
        await shoot(p, "panel-model-menu", size, scheme);
        // Keyboard: Escape closes and returns focus to the chip.
        await p.keyboard.press("Escape");
        const escaped = await p.evaluate(() => document.getElementById("model-menu").hidden && document.activeElement?.id === "now-model");
        // Arrow keys open it again; pick Opus with the keyboard.
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("ArrowDown");
        await p.keyboard.press("Enter");
        await p.waitForFunction(() => document.getElementById("now-model-label").textContent === "Opus 5.5 · Jev");
        const saved = await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.anthropicModel === "claude-opus-5-5"));
        // Click outside closes.
        await chip.click();
        await p.locator(".chat-empty .empty-title").click();
        const outside = await p.evaluate(() => document.getElementById("model-menu").hidden);
        if (!escaped || !saved || !outside) fail(`model menu behaviour: escape=${escaped} saved=${saved} outside=${outside}`);
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

    // Tab memory: values saved by older panels open the renamed tabs.
    if (size.w === 360 && scheme === "light" && !only) {
      const p = await openPanel(ctx, "idle", ".chat-empty");
      for (const [old, tab] of [["tasks", "todo"], ["activity", "chat"], ["history", "history"], ["bogus", "chat"]]) {
        await p.evaluate((v) => localStorage.setItem("tab", v), old);
        await p.reload();
        await p.waitForSelector(`#tab-${tab}:not([hidden])`);
        const sel = await p.evaluate(() => document.querySelector(".tabs [aria-selected=true]").dataset.tab);
        if (sel !== tab) fail(`saved tab "${old}" opened "${sel}"`);
      }
      reportErrors(p, `tab memory ${label}`);
      await p.close();
    }

    // Empty todo list: nothing due, so Run now is disabled and says why; with cloud sync it stays usable.
    if (want("panel-todo-empty", size, scheme)) {
      const p = await openPanel(ctx, "empty", ".chat-empty");
      await p.click("#tab-btn-todo");
      await p.waitForSelector("#tasks-empty:not([hidden])");
      const runNow = () => p.evaluate(() => ({ on: document.getElementById("run-now").getAttribute("aria-disabled") !== "true", title: document.getElementById("run-now").title }));
      const idle = await runNow();
      if (idle.on || idle.title !== "Nothing is waiting to run") fail(`Run now with nothing due ${JSON.stringify(idle)}`);
      await p.click("#run-now", { force: true });
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "run.due"))) fail("disabled Run now sent run.due");
      await checkLayout(p, `empty ${label}`);
      await shoot(p, "panel-todo-empty", size, scheme);
      const st = scenario("empty").state;
      await p.evaluate((s) => window.__push({ type: "state", state: s }), { ...st, settings: { ...st.settings, cloudEnabled: true } });
      const cloud = await runNow();
      if (!cloud.on || !/check the cloud queue/.test(cloud.title)) fail(`Run now with cloud sync ${JSON.stringify(cloud)}`);
      reportErrors(p, `empty ${label}`);
      await p.close();
    }

    // A running session: TODO, then Chat with its action bar, then the Activity Log.
    const runningShots = ["panel-todo", "panel-model-running", "panel-add-form", "panel-finished-menu", "panel-chat-running", "panel-activity-log", "panel-activity-log-past"];
    if (wantAny(runningShots, size, scheme)) {
      const page = await openPanel(ctx, "ok", ".ev-tool");
      await page.click("#tab-btn-todo");
      await page.waitForSelector(".task");
      const rn = await page.evaluate(() => ({ text: document.getElementById("run-now").textContent, on: document.getElementById("run-now").getAttribute("aria-disabled") !== "true", title: document.getElementById("run-now").title }));
      if (rn.text !== "Run now" || !rn.on || rn.title !== "Run the tasks whose time has come, instead of waiting for the next check (every 15 minutes)") fail(`Run now ${JSON.stringify(rn)}`);
      await expectChipHints(page, "todo");
      await checkLayout(page, `todo ${label}`);
      await shoot(page, "panel-todo", size, scheme);
      await page.click("#run-now");
      await page.waitForFunction(() => window.__requests.some((r) => r.type === "run.due"));
      await page.evaluate(() => (document.getElementById("tasks-msg").textContent = ""));
      if (want("panel-model-running", size, scheme)) {
        // The running task keeps its model: the chip shows it but does not open.
        const chip = page.locator("#now-model");
        const disabled = await chip.isDisabled();
        await chip.click({ force: true });
        const closed = await page.evaluate(() => document.getElementById("model-menu").hidden);
        if (!disabled || !closed) fail("model chip usable while running");
        await page.locator("#composer").screenshot({ path: join(shots, `panel-model-running-${size.w}-${scheme}.png`) });
        taken.push(join(shots, `panel-model-running-${size.w}-${scheme}.png`));
      }
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
        await expectChipHints(page, "finished");
        await page.locator("#finished-list .menu summary").first().click();
        await page.locator("#finished-list .menu[open] .menu-pop").scrollIntoViewIfNeeded();
        await shoot(page, "panel-finished-menu", size, scheme);
        await page.locator("#tab-todo .section-head h2").click();
      }
      if (wantAny(["panel-chat-running", "panel-activity-log", "panel-activity-log-past"], size, scheme)) {
        await page.click("#tab-btn-chat");
        await page.waitForSelector("#chat-log .ev-tool");
        // Running on the Claude API: Show Tab works, Raw Log does not exist for this brain.
        const bar = await expectBar(page, { "chat-new": true, "chat-show": true, "chat-rawlog": false }, "running chat");
        if (!/only local Claude Code runs/.test(bar["chat-rawlog"].title)) fail(`Raw Log tooltip "${bar["chat-rawlog"].title}"`);
        await page.locator("details.ev-result").first().evaluate((d) => (d.open = true));
        await page.locator("#chat-log").evaluate((l) => (l.scrollTop = l.scrollHeight));
        await checkLayout(page, `chat ${label}`);
        await shoot(page, "panel-chat-running", size, scheme);
        await page.click("#chat-show");
        const shown = await page.evaluate(() => window.__requests.find((r) => r.type === "agent.show"));
        if (shown?.sessionId !== "s-live") fail(`Show Tab sent ${JSON.stringify(shown)}`);

        // Activity Log: the list of runs, no composer; a finished run opens read-only with a way back.
        await page.click("#tab-btn-history");
        await page.waitForSelector(".sessions li");
        await expectChipHints(page, "activity log");
        await checkLayout(page, `activity log ${label}`);
        await shoot(page, "panel-activity-log", size, scheme);
        await page.locator(".sessions li button").nth(1).click();
        await page.waitForSelector("#hist-log .ev-text");
        const past = await page.evaluate(() => ({
          title: document.getElementById("hist-title").textContent,
          open: !document.getElementById("hist-open").hidden,
          raw: !document.getElementById("hist-rawlog").hidden,
          composer: document.getElementById("composer").hidden,
        }));
        if (past.title !== "Post 'good morning' on X" || !past.open || past.raw || !past.composer) fail(`past run view ${JSON.stringify(past)}`);
        await checkLayout(page, `activity log past ${label}`);
        await shoot(page, "panel-activity-log-past", size, scheme);
        await page.click("#hist-back");
        await page.waitForSelector("#hist-list:not([hidden]) .sessions li");
        // A running one opens in Chat.
        await page.locator(".sessions li button").first().click();
        await page.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-tool");
      }
      reportErrors(page, `running ${label}`);
      await page.close();
    }

    // Task details: the Chat title, a TODO title and a past chat message's title open a sheet with everything known.
    const detailShots = ["panel-details-chat", "panel-details-focus", "panel-details-todo", "panel-details-message"];
    if (wantAny(detailShots, size, scheme)) {
      const p = await openPanel(ctx, "details", ".ev-tool");
      const known = scenario("details");
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      const sheet = () =>
        p.evaluate(() => {
          const d = document.querySelector("dialog.sheet[open]");
          if (!d) return null;
          const r = d.getBoundingClientRect();
          return {
            heading: d.querySelector("h2").textContent,
            text: d.querySelector(".sheet-text")?.textContent ?? null,
            links: [...d.querySelectorAll(".sheet-text a")].map((a) => ({ href: a.href, blank: a.target === "_blank", rel: a.rel })),
            fields: Object.fromEntries([...d.querySelectorAll(".sheet-fields dt")].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])),
            files: [...d.querySelectorAll(".sheet-files li > span:first-child")].map((f) => f.textContent),
            buttons: [...d.querySelectorAll("button")].map((b) => b.textContent),
            focus: document.activeElement?.textContent,
            inView: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
            sideways: [...d.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis").map((el) => el.className || el.tagName),
          };
        });
      const checkSheet = (got, what) => {
        if (!got) return fail(`${what}: no sheet`);
        if (!got.inView) fail(`${what}: sheet off screen`);
        if (got.sideways.length) fail(`${what}: scrolls sideways: ${got.sideways.join(", ")}`);
        if (got.focus !== "Close") fail(`${what}: focus on "${got.focus}", not Close`);
      };

      // Chat: the title is a keyboard-reachable button with a visible focus ring.
      await p.focus("#chat-title");
      const ring = await p.evaluate(() => {
        const t = document.getElementById("chat-title");
        return { tag: t.tagName, visible: t.matches(":focus-visible"), outline: getComputedStyle(t).outlineStyle };
      });
      if (ring.tag !== "BUTTON" || !ring.visible || ring.outline === "none") fail(`chat title focus ${JSON.stringify(ring)}`);
      if (want("panel-details-focus", size, scheme)) {
        const f = join(shots, `panel-details-focus-${size.w}-${scheme}.png`);
        await p.locator("#chat-head").screenshot({ path: f });
        taken.push(f);
      }
      await p.keyboard.press("Enter");
      await p.waitForSelector("dialog.sheet[open]");
      const chat = await sheet();
      checkSheet(chat, "details from chat");
      const t2 = known.tasks[0];
      if (chat.heading !== "Task details" || chat.text !== t2.instructions) fail(`chat details text ${JSON.stringify(chat.text)}`);
      if (chat.links.length !== 2 || chat.links.some((l) => !l.blank || !/noopener/.test(l.rel)) || chat.links[1].href !== "https://browsertodo.example.com/pricing") fail(`chat details links ${JSON.stringify(chat.links)}`);
      for (const [k, v] of [["Status", "running"], ["Account", "@browsertodo"], ["Source", "This browser's TODO list"], ["Attempts", "1"], ["Task id", "t2"], ["Run id", "s-live"], ["Last run by", "Claude API · claude-sonnet-5 · Jev on"]]) {
        if (chat.fields[k] !== v) fail(`chat details ${k}: ${chat.fields[k]}`);
      }
      if (!chat.fields.Created || !chat.fields.Updated) fail("chat details: no times");
      if (chat.files.join() !== "launch-banner-final-v3.png,thread.txt") fail(`chat details files ${chat.files}`);
      if (chat.buttons.join(" | ") !== "Close | Copy instructions | Open in TODO") fail(`chat details buttons ${chat.buttons.join(" | ")}`);
      await shoot(p, "panel-details-chat", size, scheme);
      // Copy instructions puts the full text on the clipboard.
      await p.locator("dialog.sheet button", { hasText: "Copy instructions" }).click();
      await p.waitForFunction(() => document.querySelector("dialog.sheet .msg")?.textContent);
      // The Windows clipboard reads line breaks back as CRLF.
      const copied = (await p.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
      if (copied !== t2.instructions) fail(`copied ${JSON.stringify(copied)}`);
      // Esc closes and focus goes back to the title.
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if ((await p.evaluate(() => document.activeElement?.id)) !== "chat-title") fail("Esc did not return focus to the chat title");
      // Open in TODO: the TODO tab, focused on the task.
      await p.click("#chat-title");
      await p.waitForSelector("dialog.sheet[open]");
      await p.locator("dialog.sheet button", { hasText: "Open in TODO" }).click();
      await p.waitForFunction(() => document.activeElement?.dataset?.taskId === "t2");
      if (await p.locator("#tab-todo").isHidden()) fail("Open in TODO did not show the TODO tab");

      // TODO: a scheduled, repeating task with a file; a click on the backdrop closes it.
      await p.locator('#task-list [data-task-id="t1"]').click();
      await p.waitForSelector("dialog.sheet[open]");
      const todo = await sheet();
      checkSheet(todo, "details from todo");
      if (todo.text !== known.tasks[1].instructions) fail(`todo details text ${JSON.stringify(todo.text)}`);
      for (const [k, v] of [["Status", "scheduled"], ["Repeats", "Every day at 09:00 and 18:00"], ["Attempts", "0"], ["Task id", "t1"]]) {
        if (todo.fields[k] !== v) fail(`todo details ${k}: ${todo.fields[k]}`);
      }
      if (!todo.fields["Not before"]) fail("todo details: no Not before");
      if (todo.files.join() !== "thank-you.gif") fail(`todo details files ${todo.files}`);
      if (todo.buttons.includes("Open in TODO")) fail("todo details offers Open in TODO from the TODO tab");
      await shoot(p, "panel-details-todo", size, scheme);
      await p.mouse.click(size.w / 2, 8);
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if ((await p.evaluate(() => document.activeElement?.dataset?.taskId)) !== "t1") fail("backdrop click did not return focus to the task");

      // Activity Log: a past one-off chat shows the whole message typed.
      await p.click("#tab-btn-history");
      await p.locator(".sessions li button", { hasText: "Lisbon" }).click();
      await p.waitForSelector("#hist-past:not([hidden]) #hist-title");
      await p.click("#hist-title");
      await p.waitForSelector("dialog.sheet[open]");
      const msg = await sheet();
      checkSheet(msg, "details of a chat message");
      const lisbon = known.sessions.find((x) => x.sessionId === "s-3");
      if (msg.heading !== "Chat message" || msg.text !== lisbon.instructions || msg.fields.Source !== "Chat message" || msg.fields["Last pause reason"] !== "Needs you to pick dates") fail(`message details ${JSON.stringify(msg)}`);
      if (msg.buttons.includes("Open in TODO")) fail("chat message offers Open in TODO");
      await shoot(p, "panel-details-message", size, scheme);
      await p.locator("dialog.sheet button", { hasText: "Close" }).click();
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if ((await p.evaluate(() => document.activeElement?.id)) !== "hist-title") fail("Close did not return focus to the run title");
      reportErrors(p, `details ${label}`);
      await p.close();
    }

    // A conversation: two turns in one thread (the second opened by the user's bubble), the composer talks to it,
    // the header says whether its Claude Code session is still open; New Chat empties the thread and goes back to "Do this now".
    const convShots = ["panel-conversation", "panel-conversation-ended", "panel-conversation-newchat", "panel-conversation-todo"];
    if (wantAny(convShots, size, scheme)) {
      const p = await openPanel(ctx, "conversation", "#chat-log .ev-user");
      const composer = () =>
        p.evaluate(() => ({
          placeholder: document.getElementById("now-text").placeholder,
          submit: document.getElementById("now-submit").textContent,
          newChat: document.getElementById("chat-new").getAttribute("aria-disabled") !== "true",
          attach: !document.getElementById("now-attach").hidden,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const CHAT = { placeholder: "Message browsertodo…", submit: "Send", newChat: true, attach: false, stop: false };
      const NEW = { placeholder: "Do this now, e.g. “Post ‘good morning’ on X”", submit: "Run", newChat: false, attach: true, stop: false };
      const expectComposer = async (want, what) => {
        const got = await composer();
        if (JSON.stringify(got) !== JSON.stringify(want)) fail(`composer ${what}: ${JSON.stringify(got)}`);
      };
      // The last conversation ended a minute ago: Chat shows it and the composer talks to it, also from TODO.
      await p.waitForFunction(() => document.getElementById("now-text").placeholder === "Message browsertodo…");
      const view = await p.evaluate(() => ({
        bubbles: [...document.querySelectorAll("#chat-log .ev-user")].map((b) => b.textContent),
        ends: document.querySelectorAll("#chat-log .ev-end").length,
        // Each end card says who picked its turn's elements; the picks status line itself is not shown on its own.
        picks: [...document.querySelectorAll("#chat-log .ev-end .ev-picks")].map((e) => e.textContent),
        loosePicks: [...document.querySelectorAll("#chat-log > .ev-status")].filter((e) => !e.hidden && /element pick/.test(e.textContent)).length,
        head: document.querySelector("#chat-log .ev-head")?.textContent,
        note: document.getElementById("chat-conv").hidden ? null : document.getElementById("chat-conv").textContent,
        meta: document.getElementById("chat-meta").textContent,
        // The bubble opens the second turn: right after the first turn's end card.
        order: [...document.querySelectorAll("#chat-log > *")].map((e) => e.className).join(" ").includes("ev-end ev-user"),
      }));
      if (view.bubbles.length !== 1 || view.bubbles[0] !== "Now like the first reply to it" || view.ends !== 2 || !view.order) fail(`thread ${JSON.stringify(view)}`);
      if (view.head !== "Claude Code · claude-sonnet-5 · Jev on") fail(`session head "${view.head}"`);
      const wantPicks = ["Jev chose 2 of 2 element picks (clicks and typing)", "Jev chose 0 of 1 element pick (clicks and typing); Claude chose 1"];
      if (JSON.stringify(view.picks) !== JSON.stringify(wantPicks) || view.loosePicks !== 0) fail(`end card picks ${JSON.stringify(view)}`);
      if (view.note !== "Conversation open · Claude Code session kept 30 min") fail(`note "${view.note}"`);
      if (!/2 messages/.test(view.meta)) fail(`meta ${JSON.stringify(view)}`);
      // Ended Claude Code conversation: no agent tab any more, but its raw log is there.
      const bar = await expectBar(p, { "chat-new": true, "chat-show": false, "chat-rawlog": true }, "ended conversation");
      if (!/only has one while it is working/.test(bar["chat-show"].title)) fail(`Show Tab tooltip "${bar["chat-show"].title}"`);
      await expectComposer(CHAT, "not in conversation mode on Chat");
      await checkLayout(p, `conversation ${label}`);
      await shoot(p, "panel-conversation", size, scheme);
      await p.click("#chat-show", { force: true });
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "agent.show"))) fail("disabled Show Tab sent agent.show");

      await p.click("#tab-btn-todo");
      await p.waitForSelector(".task");
      await expectComposer(CHAT, "not in conversation mode on the TODO tab");
      await checkLayout(p, `conversation-todo ${label}`);
      await shoot(p, "panel-conversation-todo", size, scheme);
      await p.click("#tab-btn-chat");

      // Raw log asks the background for the helper's run log.
      const popup = p.context().waitForEvent("page", { timeout: 3000 }).catch(() => null);
      await p.click("#chat-rawlog");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "session.log" && r.sessionId === "s-conv"));
      await (await popup)?.close();

      // A message goes to the same conversation.
      await p.click("#now-text");
      await p.keyboard.insertText("And retweet it");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
      if (sent.sessionId !== "s-conv" || sent.text !== "And retweet it") fail(`message sent ${JSON.stringify(sent)}`);

      // The helper closed the session: the next message starts a fresh one with a summary.
      await p.evaluate((st) => window.__push({ type: "state", state: { ...st, openConversations: [] } }), scenario("conversation").state);
      await p.waitForFunction(() => document.getElementById("chat-conv").textContent.includes("session ended"));
      await checkLayout(p, `conversation-ended ${label}`);
      await shoot(p, "panel-conversation-ended", size, scheme);

      // New Chat: an empty thread, back to "Do this now"; the conversation's agent session is closed.
      await p.click("#chat-new");
      await expectComposer(NEW, "still in the conversation after New Chat");
      const closed = await p.evaluate(() => window.__requests.find((r) => r.type === "run.newChat"));
      if (closed?.sessionId !== "s-conv") fail(`newChat sent ${JSON.stringify(closed)}`);
      if (!(await p.locator("#chat-conv").isHidden())) fail("conversation note still shown after New Chat");
      if (!(await p.locator(".chat-empty").isVisible())) fail("thread not emptied by New Chat");
      await expectBar(p, { "chat-new": false, "chat-show": false, "chat-rawlog": false }, "after New Chat");
      await checkLayout(p, `conversation-newchat ${label}`);
      await shoot(p, "panel-conversation-newchat", size, scheme);
      // The next text starts a new conversation.
      await p.click("#now-text");
      await p.keyboard.insertText("Post gm");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc" && r.instructions === "Post gm"));
      reportErrors(p, `conversation ${label}`);
      await p.close();
    }

    // Two tasks at once, each in its own tab: the status line counts them; Chat shows this tab's and a chip for the other tab's.
    if (wantAny(["panel-parallel", "panel-parallel-newchat"], size, scheme)) {
      const p = await openPanel(ctx, "parallel", "#chat-switch:not([hidden]) .act-chip");
      if ((await p.locator("#status-meta").textContent()) !== "· 2 running") fail(`status meta "${await p.locator("#status-meta").textContent()}"`);
      const chips = () => p.evaluate(() => [...document.querySelectorAll(".act-chip")].map((c) => c.dataset.id));
      if ((await chips()).join() !== "s-par2") fail(`switcher in tab 1 ${JSON.stringify(await chips())}`);
      if (!(await p.locator("#chat-title").textContent()).startsWith("Post the launch")) fail("tab 1 does not show its run");
      const below = await p.evaluate(() => document.querySelector(".chat-bar").getBoundingClientRect().bottom <= document.getElementById("chat-switch").getBoundingClientRect().top);
      if (!below) fail("switcher is not below the action bar");
      await checkLayout(p, `parallel ${label}`);
      await shoot(p, "panel-parallel", size, scheme);
      // The chip switches to the other run's tab, and the chat follows the tab.
      await p.click('.act-chip[data-id="s-par2"]');
      const focus = await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus"));
      if (focus?.tabId !== 2) fail(`chip sent ${JSON.stringify(focus)}`);
      await p.waitForFunction(() => document.getElementById("chat-log").textContent.includes("Opening the doc"));
      if (!(await p.locator("#chat-title").textContent()).startsWith("Post the photo")) fail("switching tabs did not change the chat");
      if ((await chips()).join() !== "s-live") fail(`switcher in tab 2 ${JSON.stringify(await chips())}`);
      // Show Tab and the composer act on this tab's run; Stop stops only it.
      await p.click("#chat-show");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "agent.show"));
      const shown = await p.evaluate(() => window.__requests.find((r) => r.type === "agent.show"));
      if (shown.sessionId !== "s-par2") fail(`Show Tab sent ${JSON.stringify(shown)}`);
      await p.click("#now-stop");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.stop"));
      const stop = await p.evaluate(() => window.__requests.find((r) => r.type === "run.stop"));
      if (stop.sessionId !== "s-par2") fail(`Stop sent ${JSON.stringify(stop)}`);
      // New Chat in this tab: an empty chat, both runs offered as chips.
      await p.click("#chat-new");
      if (!(await p.locator(".chat-empty").isVisible())) fail("New Chat did not empty this tab's chat");
      if ((await chips()).join() !== "s-live,s-par2") fail(`switcher after New Chat ${JSON.stringify(await chips())}`);
      const left = await p.evaluate(() => window.__requests.find((r) => r.type === "run.newChat"));
      if (left?.sessionId !== "s-par2" || left?.tabId !== 2) fail(`New Chat sent ${JSON.stringify(left)}`);
      await checkLayout(p, `parallel-newchat ${label}`);
      await shoot(p, "panel-parallel-newchat", size, scheme);
      await p.click('.act-chip[data-id="s-live"]');
      await p.waitForFunction(() => document.getElementById("chat-title").textContent.startsWith("Post the launch"));
      reportErrors(p, `parallel ${label}`);
      await p.close();
    }

    // A chat per tab: tab 1 has a running chat, tab 2 has none; switching tabs switches the chat.
    if (wantAny(["panel-tabs-a", "panel-tabs-b", "panel-tabs-b-started"], size, scheme)) {
      const p = await openPanel(ctx, "tabs", "#chat-log .ev-tool");
      const view = () =>
        p.evaluate(() => ({
          title: document.getElementById("chat-titles").hidden ? null : document.getElementById("chat-title").textContent,
          empty: !!document.querySelector("#chat-log .chat-empty"),
          chips: [...document.querySelectorAll("#chat-switch:not([hidden]) .act-chip")].map((c) => c.dataset.id),
          placeholder: document.getElementById("now-text").placeholder,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const a = await view();
      if (!a.title?.startsWith("Summarize this pull request") || a.empty || a.chips.length || !a.stop) fail(`tab A ${JSON.stringify(a)}`);
      await expectBar(p, { "chat-new": true, "chat-show": true, "chat-rawlog": false }, "tab A");
      await checkLayout(p, `tabs-a ${label}`);
      await shoot(p, "panel-tabs-a", size, scheme);
      // The user switches to tab 2: a new chat there, with a chip for tab 1's running chat.
      await p.evaluate(() => window.__activateTab(2));
      await p.waitForSelector("#chat-log .chat-empty");
      const b = await view();
      if (b.title !== null || b.chips.join() !== "s-live" || b.stop || !b.placeholder.startsWith("Do this now")) fail(`tab B ${JSON.stringify(b)}`);
      await expectBar(p, { "chat-new": false, "chat-show": false, "chat-rawlog": false }, "tab B");
      await checkLayout(p, `tabs-b ${label}`);
      await shoot(p, "panel-tabs-b", size, scheme);
      // A task typed in tab 2 starts there, and its chat shows in tab 2.
      await p.click("#now-text");
      await p.keyboard.insertText("Translate this page's intro to French");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
      const started = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc"));
      if (started.tabId !== 2) fail(`run.adhoc from tab 2 sent ${JSON.stringify(started)}`);
      await p.waitForFunction(() => !document.querySelector("#chat-log .chat-empty"));
      await checkLayout(p, `tabs-b-started ${label}`);
      await shoot(p, "panel-tabs-b-started", size, scheme);
      // Back to tab 1: its chat is still there.
      await p.evaluate(() => window.__activateTab(1));
      await p.waitForFunction(() => document.getElementById("chat-title").textContent.startsWith("Summarize this pull request"));
      reportErrors(p, `tabs ${label}`);
      await p.close();
    }

    // Signed out: the TODO tab is one big centered Log In button (and one line), no list, no composer.
    if (wantAny(["panel-todo-login", "panel-todo-login-noclient"], size, scheme)) {
      for (const kind of ["loggedout", "loggedout-noclient"]) {
        const name = kind === "loggedout" ? "panel-todo-login" : "panel-todo-login-noclient";
        if (!want(name, size, scheme)) continue;
        const p = await openPanel(ctx, kind, ".chat-empty");
        await p.click("#tab-btn-todo");
        await p.waitForSelector('#tab-todo[data-auth="out"] #login-btn');
        const cta = await p.evaluate(() => {
          const btn = document.getElementById("login-btn");
          const b = btn.getBoundingClientRect();
          const tab = document.getElementById("tab-todo").getBoundingClientRect();
          const shown = [...document.querySelectorAll("#tab-todo > *")].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.id || e.className);
          return {
            w: b.width, h: b.height, font: parseFloat(getComputedStyle(btn).fontSize),
            dx: Math.abs((b.left + b.right) / 2 - (tab.left + tab.right) / 2),
            dy: Math.abs((b.top + b.bottom) / 2 - (tab.top + tab.bottom) / 2),
            tabH: tab.height, shown, text: btn.textContent,
            composer: document.getElementById("composer").hidden,
            acct: document.getElementById("acct").hidden,
          };
        });
        if (cta.text !== "Log In") fail(`login button says "${cta.text}"`);
        if (cta.w < 200 || cta.h < 46 || cta.font < 16) fail(`Log In is not big: ${JSON.stringify(cta)}`);
        if (cta.dx > 2 || cta.dy > cta.tabH * 0.12) fail(`Log In is not centered: ${JSON.stringify(cta)}`);
        if (cta.shown.join() !== "todo-login") fail(`signed-out TODO shows more than Log In: ${cta.shown.join(", ")}`);
        if (!cta.composer) fail("composer shown under Log In");
        if (!cta.acct) fail("account avatar shown while signed out");
        await checkLayout(p, `${kind} ${label}`);
        if (kind === "loggedout-noclient") {
          await p.click("#login-btn");
          await p.waitForFunction(() => document.getElementById("login-msg").textContent.includes("Sign-in isn't set up yet"));
          if (await p.evaluate(() => window.__requests.some((r) => r.type === "account.signIn"))) fail("sign-in requested without a client ID");
          await shoot(p, name, size, scheme);
        } else {
          await shoot(p, name, size, scheme);
          await p.click("#login-btn");
          await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signIn"));
          await p.waitForSelector('#tab-todo[data-auth="in"] .task');
          if (!(await p.locator("#composer").isVisible())) fail("composer not back after sign-in");
          if (!(await p.locator("#acct").isVisible())) fail("avatar not shown after sign-in");
        }
        // Chat still works signed out.
        await p.click("#tab-btn-chat");
        if (!(await p.locator("#composer").isVisible())) fail("composer hidden on Chat while signed out");
        reportErrors(p, `${kind} ${label}`);
        await p.close();
      }
    }

    // Signed in: the account's list, the offer to move this browser's tasks, the avatar menu, browsertodo AI in the chip.
    if (wantAny(["panel-todo-account", "panel-account-menu", "panel-model-menu-hosted"], size, scheme)) {
      const p = await openPanel(ctx, "account", ".chat-empty");
      await p.click("#tab-btn-todo");
      await p.waitForSelector('#tab-todo[data-auth="in"] .task');
      if (!(await p.locator("#migrate").isVisible())) fail("no offer to move local tasks");
      if ((await p.locator("#migrate-go").textContent()) !== "Move 3 tasks to your account") fail(`migrate button "${await p.locator("#migrate-go").textContent()}"`);
      // Account tasks: Retry/Cancel/Delete; paused ones also offer Continue (re-queues them now,
      // e.g. after a top-up); never the local-only "Run again".
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll("#task-list .task")].map((t) => ({
          status: t.querySelector(".chip")?.textContent ?? "",
          items: [...t.querySelectorAll(".menu-pop button")].map((b) => b.textContent).join("/"),
        })),
      );
      if (rows.some((r) => r.items.includes("Run again"))) fail(`account task menus ${JSON.stringify(rows)}`);
      if (rows.some((r) => r.items.includes("Continue") && !/needs you|paused/i.test(r.status))) fail(`Continue on a non-paused account task ${JSON.stringify(rows)}`);
      if ((await p.locator("#status-text").textContent()) !== "browsertodo AI + Jev") fail(`status "${await p.locator("#status-text").textContent()}"`);
      await checkLayout(p, `account todo ${label}`);
      await shoot(p, "panel-todo-account", size, scheme);
      await p.click("#migrate-go");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.migrate"));
      await p.waitForSelector("#migrate", { state: "hidden" });
      if (want("panel-account-menu", size, scheme)) {
        await p.click("#acct-btn");
        await p.waitForSelector("#acct[open] .acct-pop");
        const pop = await p.evaluate(() => {
          const r = document.querySelector("#acct .acct-pop").getBoundingClientRect();
          return { left: r.left, right: r.right, email: document.getElementById("acct-email").textContent, plan: document.getElementById("acct-plan").textContent };
        });
        if (pop.left < 0 || pop.right > size.w) fail(`account menu off screen ${JSON.stringify(pop)}`);
        if (pop.email !== "ada.lovelace@example.com" || pop.plan !== "Plus plan · $14.21 AI credit") fail(`account menu ${JSON.stringify(pop)}`);
        await shoot(p, "panel-account-menu", size, scheme);
        await p.click("#acct-signout");
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signOut"));
        await p.waitForSelector('#tab-todo[data-auth="out"] #login-btn');
      }
      if (want("panel-model-menu-hosted", size, scheme)) {
        const q = await openPanel(ctx, "account", ".chat-empty");
        await q.click("#now-model");
        await q.waitForSelector("#model-menu:not([hidden])");
        const menu = await q.evaluate(() => ({
          head: document.querySelector(".mm-head").textContent,
          credit: document.querySelector(".mm-credit")?.textContent,
          models: [...document.querySelectorAll(".mm-item[role=menuitemradio]")].length,
          jev: document.querySelector(".mm-jev").disabled,
        }));
        if (menu.head !== "browsertodo AI model" || menu.credit !== "$14.21 AI credit left" || menu.models !== 4 || menu.jev) fail(`hosted model menu ${JSON.stringify(menu)}`);
        await checkLayout(q, `model-menu-hosted ${label}`);
        await shoot(q, "panel-model-menu-hosted", size, scheme);
        reportErrors(q, `model-menu-hosted ${label}`);
        await q.close();
      }
      reportErrors(p, `account ${label}`);
      await p.close();
    }

    // Out of AI credit: the status line says so with Top up; the paused run's card links to the top-up page.
    if (want("panel-out-of-credit", size, scheme)) {
      const p = await openPanel(ctx, "hosted-out", "#chat-log .ev-end");
      const st = await p.evaluate(() => ({ text: document.getElementById("status-text").textContent, action: document.getElementById("status-action").textContent, chip: document.getElementById("now-model-label").textContent }));
      if (st.text !== "Out of AI credit" || st.action !== "Top up" || st.chip !== "Out of AI credit") fail(`out of credit status ${JSON.stringify(st)}`);
      const link = await p.evaluate(() => document.querySelector("#chat-log .ev-topup")?.getAttribute("href"));
      if (link !== "https://browsertodo-api.jaeyun.workers.dev/billing") fail(`Top up link ${link}`);
      await checkLayout(p, `out-of-credit ${label}`);
      await shoot(p, "panel-out-of-credit", size, scheme);
      await p.click("#status-action");
      const opened = await p.evaluate(() => window.__opened);
      if (opened[0] !== "https://browsertodo-api.jaeyun.workers.dev/billing") fail(`status Top up opened ${JSON.stringify(opened)}`);
      reportErrors(p, `out-of-credit ${label}`);
      await p.close();
    }

    // Warning states.
    if (wantAny(["panel-nobrain-todo", "panel-model-menu-nojev"], size, scheme)) {
      const p = await openPanel(ctx, "nobrain", ".chat-empty");
      await p.click("#tab-btn-todo");
      await p.waitForSelector(".task");
      await checkLayout(p, `nobrain ${label}`);
      await shoot(p, "panel-nobrain-todo", size, scheme);
      if (want("panel-model-menu-nojev", size, scheme)) {
        // No Jev key anywhere: the Jev row is disabled with a hint.
        await p.click("#now-model");
        await p.waitForSelector("#model-menu:not([hidden])");
        if (!(await p.locator(".mm-jev").isDisabled())) fail("Jev row enabled without a key");
        await checkLayout(p, `model-menu-nojev ${label}`);
        await shoot(p, "panel-model-menu-nojev", size, scheme);
        await p.keyboard.press("Escape");
      }
      reportErrors(p, `nobrain ${label}`);
      await p.close();
    }
    if (want("panel-paused-activity-log", size, scheme)) {
      const p = await openPanel(ctx, "paused", ".chat-empty");
      await p.click("#tab-btn-history");
      await p.waitForSelector(".sessions li");
      await checkLayout(p, `paused ${label}`);
      await shoot(p, "panel-paused-activity-log", size, scheme);
      reportErrors(p, `paused ${label}`);
      await p.close();
    }

    // Stopped by the user after typing the post: the next message continues that conversation.
    if (wantAny(["panel-continue", "panel-continue-note", "panel-continue-newtask", "panel-continue-task-menu", "panel-continue-past"], size, scheme)) {
      const p = await openPanel(ctx, "stopped", "#chat-log .ev-tool");
      const data = scenario("stopped");
      const ended = data.sessions[0];
      await p.evaluate((s) => {
        window.__push({ type: "event", event: { type: "task_end", outcome: "paused", reason: "stopped by user", ts: s.endedAt, sessionId: s.sessionId } });
        window.__push({ type: "session", session: s });
      }, ended);
      await p.evaluate((st) => window.__push({ type: "state", state: st }), { ...data.state, running: null });
      await p.waitForSelector(".ev-continue");
      const mode = () =>
        p.evaluate(() => ({
          placeholder: document.getElementById("now-text").placeholder,
          submit: document.getElementById("now-submit").textContent,
          newChat: document.getElementById("chat-new").getAttribute("aria-disabled") !== "true",
          attach: !document.getElementById("now-attach").hidden,
        }));
      const expectMode = async (want, what) => {
        const got = await mode();
        if (got.placeholder !== want.placeholder || got.submit !== want.submit || got.newChat !== want.newChat || got.attach !== want.attach) fail(`composer ${what}: ${JSON.stringify(got)}`);
      };
      const CHAT = { placeholder: "Message browsertodo…", submit: "Send", newChat: true, attach: false };
      const NEW = { placeholder: "Do this now, e.g. “Post ‘good morning’ on X”", submit: "Run", newChat: false, attach: true };
      const lastMessage = () => p.evaluate(() => window.__requests.filter((r) => r.type === "run.message").at(-1) ?? null);
      await expectMode(CHAT, "not talking to the stopped conversation");
      await checkLayout(p, `continue ${label}`);
      await shoot(p, "panel-continue", size, scheme);

      // The card's Continue goes on right away (the box is empty, so no note is sent along).
      await p.click(".ev-continue");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.continue"));
      const cardCont = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.continue").at(-1));
      if (cardCont?.sessionId !== "s-stop" || "text" in cardCont || (await lastMessage())) fail(`card Continue sent ${JSON.stringify(cardCont)}`);
      await p.click("#now-text");

      // A note, sent with Enter: the next turn of the same conversation.
      await p.keyboard.insertText("It's already typed, just press Post");
      await checkLayout(p, `continue-note ${label}`);
      await shoot(p, "panel-continue-note", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const req = await lastMessage();
      if (req?.sessionId !== "s-stop" || req?.text !== "It's already typed, just press Post") fail(`composer sent ${JSON.stringify(req)}`);

      // New Chat goes back to "Do this now".
      await p.click("#chat-new");
      await expectMode(NEW, "still in the conversation after New Chat");
      await checkLayout(p, `continue-newtask ${label}`);
      await shoot(p, "panel-continue-newtask", size, scheme);

      // A past stopped run from the Activity Log: read-only there; Open in Chat hands it to the composer.
      if (want("panel-continue-past", size, scheme)) {
        await p.click("#tab-btn-history");
        await p.waitForSelector(".sessions li");
        await p.locator(".sessions li button", { hasText: "cheapest flight" }).click();
        await p.waitForSelector("#hist-log .ev-continue");
        await checkLayout(p, `continue-past ${label}`);
        await shoot(p, "panel-continue-past", size, scheme);
        await p.click("#hist-open");
        await p.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-continue");
        if (!(await p.locator("#chat-title").textContent()).includes("cheapest flight")) fail("Open in Chat did not show the run in Chat");
        await expectMode(CHAT, "not talking to a past stopped run after Open in Chat");
        if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text") fail("Open in Chat did not focus the box");
        await checkLayout(p, `continue-past-chat ${label}`);
        await shoot(p, "panel-continue-past-chat", size, scheme);
      }

      // TODO tab: the paused task's menu continues its latest run.
      await p.click("#tab-btn-todo");
      const menu = p.locator("#task-list li", { hasText: "September invoice" }).locator(".menu");
      await menu.locator("summary").click();
      await shoot(p, "panel-continue-task-menu", size, scheme);
      await menu.locator("button", { hasText: "Continue" }).click();
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.continue"));
      const cont = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.continue").at(-1));
      if (cont?.sessionId !== "s-5") fail(`task menu Continue sent ${JSON.stringify(cont)}`);
      if (!(await p.locator("#tab-chat").isVisible())) fail("task menu Continue did not switch to Chat");
      reportErrors(p, `continue ${label}`);
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
    await page.locator("details.advanced").evaluateAll((els) => els.forEach((d) => (d.open = true)));
    await page.check("#f-cloudEnabled");
    await page.waitForTimeout(250); // let the switch transition finish
    await page.screenshot({ path: join(shots, `options-${size.w}-${scheme}.png`), fullPage: true });
    taken.push(join(shots, `options-${size.w}-${scheme}.png`));
    await ctx.close();
  }
}

// Options: the Account and API keys sections (free, paid, out of credit, billing not set up, signed out).
for (const scheme of SCHEMES) {
  for (const [kind, name] of [
    ["opt-free", "options-account-free"],
    ["opt-paid", "options-account-paid"],
    ["opt-out", "options-account-outofcredit"],
    ["opt-nobilling", "options-account-nobilling"],
    ["opt-signedout", "options-account-signedout"],
  ]) {
    const size = { w: 480, h: 1000 };
    if (!want(name, size, scheme)) continue;
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(installChromeStub, scenario(kind));
    await page.goto(`${base}/options.html`);
    await page.waitForSelector("#helper-headline:not(:empty)");
    const failOpt = (what) => {
      console.error(`${name} ${scheme}: ${what}`);
      failures++;
    };
    const info = () =>
      page.evaluate(() => {
        const vis = (id) => {
          const el = document.getElementById(id);
          return !!el && el.getClientRects().length > 0;
        };
        return {
          signedIn: vis("acct-in"),
          plan: document.getElementById("acct-plan").textContent,
          credit: document.getElementById("acct-credit").textContent,
          note: vis("acct-note") ? document.getElementById("acct-note").textContent : "",
          plans: vis("acct-plans") ? document.querySelectorAll("#acct-plans .plan").length : 0,
          topups: vis("acct-topup") ? document.querySelectorAll("#acct-topup button").length : 0,
          portal: vis("acct-portal"),
          keysCard: vis("keys-card"),
          keysLocked: vis("keys-locked"),
          keys: document.querySelectorAll("#keys-list li:not(.empty)").length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
    await page.waitForTimeout(100);
    const got = await info();
    if (got.overflow) failOpt("horizontal scroll");
    if (kind === "opt-signedout") {
      if (got.signedIn || got.keysCard) failOpt(`signed out shows the account ${JSON.stringify(got)}`);
    } else if (!got.signedIn) failOpt("not signed in");
    if (kind === "opt-free" && (got.plans !== 3 || got.topups !== 3 || got.portal || !got.keysLocked || got.plan !== "Free" || got.credit !== "$0.00")) failOpt(JSON.stringify(got));
    if (kind === "opt-paid" && (got.plans !== 0 || !got.portal || got.keysLocked || got.keys !== 2 || got.plan !== "Plus" || got.credit !== "$25.40")) failOpt(JSON.stringify(got));
    if (kind === "opt-out" && (got.credit !== "Out of AI credit" || !/paused until you top up/.test(got.note))) failOpt(JSON.stringify(got));
    if (kind === "opt-nobilling" && (got.plans || got.topups || got.portal || !/Billing isn't set up on this server yet/.test(got.note))) failOpt(JSON.stringify(got));
    if (kind === "opt-free") {
      // Subscribe asks the background for a Stripe page with this page as returnUrl, and opens it.
      await page.locator("#acct-plans .plan").nth(1).click();
      await page.waitForFunction(() => window.__opened.length > 0);
      const req = await page.evaluate(() => window.__requests.find((r) => r.type === "account.billing"));
      if (req.action !== "checkout" || req.plan !== "plus" || req.returnUrl !== "https://browsertodo-api.jaeyun.workers.dev/billing") failOpt(`checkout request ${JSON.stringify(req)}`);
      await page.locator("#acct-topup button", { hasText: "$25.00" }).click();
      await page.waitForFunction(() => window.__requests.some((r) => r.type === "account.billing" && r.action === "topup" && r.amountCents === 2500));
    }
    if (kind === "opt-paid") {
      await page.fill("#key-name", "ci pipeline");
      await page.click("#key-create");
      await page.waitForSelector("#key-new:not([hidden])");
      if ((await page.locator("#key-value").textContent()) !== "bt_EXAMPLE_not_a_real_key_0000000000000000") failOpt("new key not shown");
      await page.waitForFunction(() => document.querySelectorAll("#keys-list li:not(.empty)").length === 3);
    }
    await page.waitForTimeout(150);
    const file = join(shots, `${name}-${size.w}-${scheme}.png`);
    await page.locator("#account-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: file, fullPage: false });
    taken.push(file);
    if (kind === "opt-paid") {
      const kf = join(shots, `options-apikeys-${size.w}-${scheme}.png`);
      await page.locator("#keys-card").screenshot({ path: kf });
      taken.push(kf);
    }
    if (errors.length) failOpt(`page errors ${errors.join("; ")}`);
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
  await page.locator("#cloud-card").evaluate((d) => (d.open = true));
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
