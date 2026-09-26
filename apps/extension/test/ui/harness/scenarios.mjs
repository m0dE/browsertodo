// Canned data for the UI harness: what the background would answer in each situation (a running
// session, a conversation, signed in or out, out of credit, ...), by scenario kind.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMANDS = JSON.parse(readFileSync(join(root, "static", "manifest.json"), "utf8")).commands;
/** The panel's shortcuts as the manifest suggests them (what chrome.commands reports when Chrome assigned them). */
export const SHORTCUT = COMMANDS["open-chat"].suggested_key.default;
export const VOICE_SHORTCUT = COMMANDS.voice.suggested_key.default;
/** How the panel writes them ("Ctrl+Period" reads "Ctrl+.", "Ctrl+Comma" reads "Ctrl+,"). */
const label = (key) => key.split("+").map((k) => ({ Period: ".", Comma: "," })[k] ?? k).join("+");
export const SHORTCUT_LABEL = label(SHORTCUT);
export const VOICE_SHORTCUT_LABEL = label(VOICE_SHORTCUT);

/** A small JPEG "screenshot" for thumbnails (base64), rendered once by renderThumbnail(browser). */
export let thumbnail = "";
export async function renderThumbnail(browser) {
  const thumbPage = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await thumbPage.setContent(
    `<body style="margin:0;font:14px system-ui;background:#fff"><div style="background:#000;color:#fff;padding:10px">X</div>
     <div style="padding:12px">What's happening?<div style="margin-top:40px;float:right;background:#1d9bf0;color:#fff;border-radius:16px;padding:6px 14px">Post</div></div></body>`,
  );
  thumbnail = (await thumbPage.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
  await thumbPage.close();
}

/** A long Markdown answer (made-up sample text): headings, nested lists, bold labels, links, inline code, a code block, a quote. */
export const PUBLISH_ANSWER = [
  "Here's how to publish a Chrome extension to the **Chrome Web Store**:",
  "",
  "## 1. Prepare the package",
  "",
  "- Make sure `manifest.json` has a unique `name`, a `version` and `manifest_version: 3`.",
  "- Add icons in 16, 48 and 128 px.",
  "- Zip the extension folder (the manifest must be at the root of the zip):",
  "",
  "```sh",
  "cd my-extension",
  "zip -r ../my-extension-1.0.0.zip . -x '*.git*' 'node_modules/*' '*.map'",
  "```",
  "",
  "## 2. Register as a developer",
  "",
  "1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and sign in.",
  "2. Pay the one-time **$5 registration fee**.",
  "3. Verify your contact email.",
  "",
  "## 3. Upload and fill in the listing",
  "",
  "- **Store listing:** description, category, language and at least one screenshot (1280×800).",
  "- **Privacy:** declare what data you collect and justify each permission, for example:",
  "  - `tabs`: to read the active tab's URL",
  "  - `storage`: to save settings",
  "- **Distribution:** public, unlisted or private.",
  "",
  "> Review usually takes a few days; broad host permissions can make it longer.",
  "",
  "After approval the extension goes live, and updates go through the same review when you upload a new version.",
].join("\n");

export const EMAIL_ANSWER = [
  "You have **4 unread emails**. Here's what each one needs:",
  "",
  "### Needs a reply",
  "",
  "1. **Jordan Lee** (Example Corp), 9:12 AM: *Contract renewal*",
  "   - Asks whether you can sign the renewal by **Friday**.",
  "   - The draft is linked here: https://docs.example.com/d/renewal-draft-2026-final-version?usp=sharing&view=comments",
  "2. **Sam Ortiz**, yesterday: *Team offsite dates*",
  "   - Wants you to pick between Oct 14 and Oct 21.",
  "",
  "### For your information",
  "",
  "- **Billing** (no-reply@shop.example.com): order `#48213` shipped, arriving Monday.",
  "- **Newsletter**: this week's product updates; nothing to do.",
  "",
  "Want me to draft replies to Jordan and Sam?",
].join("\n");

/** The follow-up the agent suggests after the email answer (task_complete's suggestion). */
export const SUGGESTION = "Reply to Jordan and say I'll sign by Thursday";

export function scenario(kind) {
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
    paused: false, pauseRetryMinutes: 15, accountApiBase: "https://app.browsertodo.com",
    voiceEngine: "realtime", speechVoice: "", speechRate: 1, realtimeCostNoticed: true,
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
  // Signed in on a paid plan by default (the TODO tab shows the list); account scenarios below change it.
  const API = "https://app.browsertodo.com";
  const avatar =
    "data:image/svg+xml;utf8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#0f766e"/><text x="24" y="32" font-size="22" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">A</text></svg>');
  const FREE = { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false };
  const PLUS = { id: "plus", status: "active", currentPeriodEnd: iso(60 * 24 * 30), cancelAtPeriodEnd: false };
  const money = (sub, top, grant = 0) => ({ subscriptionCents: sub, topupCents: top, totalCents: sub + top, periodGrantCents: grant, periodEnd: grant ? iso(60 * 24 * 30) : null });
  state.account = {
    signedIn: true, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing`,
    user: { email: "ada.lovelace@example.com", name: "Ada Lovelace", pictureUrl: avatar },
    plan: PLUS, credit: money(0, 0), stripeConfigured: true, fetchedAt: iso(0),
  };
  let tasksSource;
  /** The account's list came back locked (a plan without the TODO list). */
  let tasksLocked = false;
  let keys = [];
  if (kind === "loggedout" || kind === "loggedout-noclient") {
    state.account = { signedIn: false, signInConfigured: kind === "loggedout", apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing` };
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
    state.account = { ...state.account, plan: FREE, credit: money(0, 0), localTasks: undefined, outOfCredit: true };
  }
  if (kind === "opt-free" || kind === "free") state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
  if (kind === "todo-locked" || kind === "todo-locked-empty") {
    // Signed in on Free: the account keeps the tasks of an earlier subscription, read-only.
    state.running = null;
    state.account = { ...state.account, plan: FREE, credit: money(0, 0) };
    tasksSource = "account";
    tasksLocked = true;
  }
  if (kind === "opt-paid") {
    state.account = { ...state.account, plan: PLUS, credit: money(1540, 1000, 2000) };
    keys = [
      { id: "k1", name: "laptop chrome", role: "runner", createdAt: iso(-60 * 24 * 12), revokedAt: null },
      { id: "k2", name: "weekly scheduler script", role: "creator", createdAt: iso(-60 * 24 * 3), revokedAt: null },
    ];
  }
  if (kind === "opt-out") state.account = { ...state.account, plan: FREE, credit: money(0, 0), outOfCredit: true };
  // A paid plan whose usage credit ran out (runs paused on a 402).
  if (kind === "opt-paid-out") state.account = { ...state.account, plan: PLUS, credit: money(0, 0, 2000), outOfCredit: true };
  if (kind === "opt-nobilling") state.account = { ...state.account, plan: FREE, credit: money(0, 0), stripeConfigured: false };
  if (kind === "opt-signedout") state.account = { signedIn: false, signInConfigured: true, apiBase: API, dashboardUrl: `${API}/`, billingUrl: `${API}/billing` };
  if (kind === "idle" || kind === "free" || kind === "empty" || kind === "noshortcut") state.running = null;
  if (kind === "nobrain") {
    state.brain = { effective: null, note: "No AI set up. Install the helper, add a Claude API key, or log in.", helper: null, helperError: "Helper not installed", hasApiKey: false, jevActive: false };
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
    ev(-2, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
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
  if (kind === "empty" || kind === "todo-locked-empty") tasks.splice(0, tasks.length);
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
  if (kind === "answer" || kind === "streaming" || kind === "suggest") {
    // A question answered in the chat. Turn 1: an older run that put the whole answer (Markdown) into
    // task_complete's summary. Turn 2: the answer as the agent's own text, then a one-line summary.
    // Made-up sample content only.
    const ans = {
      sessionId: "s-ans", source: "adhoc", title: "how do I publish a Chrome extension", brain: "claude-code", jev: false,
      model: "claude-sonnet-5", startedAt: iso(-2), endedAt: iso(-1), firstStartedAt: iso(-9), outcome: "done", turns: 2,
      summary: "Summarized 4 unread emails",
    };
    const aev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-ans" });
    eventsBySession["s-ans"] = [
      aev(-9, { type: "status", text: "Claude Code started (claude-sonnet-5)" }),
      aev(-8, { type: "tool_call", id: "1", name: "task_complete", args: { summary: PUBLISH_ANSWER } }),
      aev(-8, { type: "tool_result", id: "1", name: "task_complete", text: "Task marked complete." }),
      aev(-8, { type: "task_end", outcome: "done", summary: PUBLISH_ANSWER }),
      aev(-3, { type: "user_message", text: "Summarize my unread email" }),
      aev(-3, { type: "status", text: "Continuing the same Claude Code session" }),
      aev(-3, { type: "assistant_text", text: "I'll open your inbox and read the unread messages." }),
      aev(-3, { type: "tool_call", id: "2", name: "navigate", args: { url: "https://mail.example.com/inbox" } }),
      aev(-3, { type: "tool_result", id: "2", name: "navigate", text: "Opened https://mail.example.com/inbox (title: Inbox (4))" }),
      aev(-3, { type: "tool_call", id: "3", name: "read_page", args: {} }),
      aev(-3, { type: "tool_result", id: "3", name: "read_page", text: "URL: https://mail.example.com/inbox\n4 unread conversations" }),
      aev(-2, { type: "tool_call", id: "4", name: "open_tabs", args: { urls: ["https://mail.example.com/m/1", "https://mail.example.com/m/2", "https://mail.example.com/m/3", "https://mail.example.com/m/4"] } }),
      aev(-2, { type: "tool_result", id: "4", name: "open_tabs", text: "Opened t2, t3, t4, t5" }),
      aev(-2, { type: "tool_call", id: "5", name: "read_page", args: { tabs: ["t2", "t3", "t4", "t5"] } }),
      aev(-2, { type: "tool_result", id: "5", name: "read_page", text: "4 pages read" }),
      aev(-2, { type: "tool_call", id: "6", name: "close_tabs", args: { tabs: ["t2", "t3", "t4", "t5"] } }),
      aev(-2, { type: "tool_result", id: "6", name: "close_tabs", text: "Closed 4 tabs" }),
      aev(-1, { type: "assistant_text", text: EMAIL_ANSWER }),
      aev(-1, { type: "tool_call", id: "7", name: "task_complete", args: { summary: "Summarized 4 unread emails" } }),
      aev(-1, { type: "tool_result", id: "7", name: "task_complete", text: "Task marked complete." }),
      aev(-1, { type: "task_end", outcome: "done", summary: "Summarized 4 unread emails" }),
    ];
    state.running = null;
    state.runningTabs = {};
    state.tabChats = { "1": "s-ans" };
    state.brain = { ...state.brain, effective: "claude-code", jevActive: false };
    state.openConversations = ["s-ans"];
    sessions.unshift(ans);
    sessions.splice(1, 1);
    if (kind === "suggest") {
      // The turn ended with a follow-up suggestion: kept with the session, offered in the box.
      ans.suggestion = SUGGESTION;
      Object.assign(eventsBySession["s-ans"].at(-1), { suggestion: SUGGESTION });
    }
    if (kind === "streaming") {
      // The second turn is still being written: the harness pushes its text in pieces.
      const live = { ...ans, endedAt: undefined, outcome: undefined, summary: undefined };
      delete live.endedAt;
      delete live.outcome;
      delete live.summary;
      eventsBySession["s-ans"] = eventsBySession["s-ans"].slice(0, -4);
      sessions[0] = live;
      state.running = live;
      state.runningSessions = [live];
      state.runningTabs = { "s-ans": [1] };
    }
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
      sev(-3, { type: "status", text: "Claude Code started" }),
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
    // The last run hit the end of the usage credit: paused, with a Top up link.
    const out = {
      sessionId: "s-out", source: "adhoc", title: "Summarize the three newest issues on the tracker", brain: "browsertodo", jev: true,
      model: "claude-sonnet-5", startedAt: iso(-3), endedAt: iso(-2), outcome: "paused", reason: "Out of usage credit",
    };
    const oev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-out" });
    eventsBySession["s-out"] = [
      oev(-3, { type: "status", text: "BrowserTODO AI (claude-sonnet-5) with Jev" }),
      oev(-3, { type: "assistant_text", text: "Opening the tracker." }),
      oev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://tracker.example.com/issues" } }),
      oev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://tracker.example.com/issues" }),
      oev(-2, { type: "error", text: "Out of usage credit: No usage credit left" }),
      oev(-2, { type: "task_end", outcome: "paused", reason: "Out of usage credit" }),
    ];
    sessions.unshift(out);
    state.tabChats = { "1": "s-out" };
    tasks[0] = { ...tasks[0], status: "paused", pauseReason: "Out of usage credit", attempts: 1 };
  }
  if (kind.startsWith("err-")) {
    // A failed turn in the chat of tab 1: each shows its error once, in plain words, with the button that fixes it.
    const failures = {
      // The server's own AI key was refused (502 hosted_ai_unavailable): the error event, then the end with the same reason.
      "err-hosted": { brain: "browsertodo", model: "claude-opus-5-5", error: "BrowserTODO AI is unavailable right now", outcome: "failed", reason: "BrowserTODO AI is unavailable right now" },
      // Local Claude Code's helper went away mid-turn: no error event, only the end's reason.
      "err-helper": { brain: "claude-code", outcome: "retry", reason: "helper disconnected: Native host has exited." },
      "err-ratelimit": {
        brain: "claude-api", error: "Claude API rate limit (HTTP 429: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit)",
        outcome: "retry", reason: "Claude API rate limit (HTTP 429: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit); gave up after 4 attempts",
      },
      // An error the panel does not know: a generic line, Retry, and the text behind Details.
      "err-unknown": {
        brain: "claude-api", error: "Claude API error (HTTP 400: invalid_request_error: prompt is too long: 250312 tokens > 200000 maximum)",
        outcome: "failed", reason: "Claude API error (HTTP 400: invalid_request_error: prompt is too long: 250312 tokens > 200000 maximum)",
      },
    };
    const f = failures[kind];
    const s = {
      sessionId: "s-err", source: "adhoc", title: "Summarize the three newest issues on the tracker", brain: f.brain, jev: true,
      ...(f.model ? { model: f.model } : {}), startedAt: iso(-3), endedAt: iso(-2), outcome: f.outcome, reason: f.reason,
    };
    const eev = (minutes, e) => ({ ...e, ts: iso(minutes), sessionId: "s-err" });
    eventsBySession["s-err"] = [
      eev(-3, { type: "assistant_text", text: "Opening the tracker." }),
      eev(-3, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://tracker.example.com/issues" } }),
      eev(-3, { type: "tool_result", id: "1", name: "navigate", text: "Opened https://tracker.example.com/issues" }),
      ...(f.error ? [eev(-2, { type: "error", text: f.error })] : []),
      eev(-2, { type: "task_end", outcome: f.outcome, reason: f.reason }),
    ];
    sessions.unshift(s);
    state.running = null;
    state.tabChats = { "1": "s-err" };
    if (f.brain === "browsertodo") {
      state.brain = { effective: "browsertodo", helper, hasApiKey: false, jevActive: true };
      settings.anthropicApiKey = "";
    }
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
  // Other extensions took the keys: Chrome assigned none.
  const shortcut = kind === "noshortcut" ? "" : SHORTCUT;
  const voiceShortcut = kind === "noshortcut" ? "" : VOICE_SHORTCUT;
  // Log In in the stub signs in as a subscriber (the TODO tab then shows the list).
  return { state, tasks, tasksSource, tasksLocked, signInPlan: PLUS, keys, events, sessions, eventsBySession, shortcut, voiceShortcut, pastEvents: events.slice(0, 6).map((e) => ({ ...e, sessionId: "s-2" })) };
}
