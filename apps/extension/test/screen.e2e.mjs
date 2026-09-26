// The keyboard shortcut, an empty message in Chat ("look at this page and do what's needed"), and a chat whose
// tab is a page Chrome keeps extensions out of, in the built extension in Playwright's Chromium.
//
// Default: a scripted fake brain installed in the service worker (no helper, no API key) records what each run
// is told and looks at the page the way the agent would (screenshot of the background tab, read_page).
// --claude: real headless Claude Code through the helper (registered like test/e2e/run-e2e.mjs), on the
// verify-email fixture: the sign-up page says "We sent a verification link to test@example.com", the fake mailbox
// is served as https://mail.google.com. Measures whether the empty message makes the agent open the mail and
// click the link, and whether a chat on chrome://version still gets work done in other tabs. Then "check my email" in
// the mailbox's tab: the follow-up suggestion the agent proposes (if any) shows faded in the panel's box.
//
// Usage: pnpm build && node apps/extension/test/screen.e2e.mjs [--headed] [--claude] [--email=you@gmail.com]
// --email: the address the sign-up page names (default test@example.com, a reserved example domain).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, launchExtension, openPanelWithTabs, openSidePanel, registerHelperTemporarily, routerUi, sessionWhen, shortcutPresser } from "../../../test/e2e/lib/extension.mjs";
import { installFakeBrain } from "../../../test/e2e/lib/fake-brain.mjs";
import { createSuite, sleep, waitFor } from "../../../test/e2e/lib/suite.mjs";
import { selfSignedCert } from "../../../test/fixtures/tls.mjs";
import { createVerifyEmailSite, TOKEN } from "../../../test/fixtures/verify-email/server.mjs";

const claude = process.argv.includes("--claude");
const SCREEN = "Figure out what to do based on the current screen";
/** The shortcut the manifest suggests (Chrome assigns it when no other extension uses it). */
const SUGGESTED = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8")).commands["open-chat"].suggested_key.default;
const RESTRICTED_STATUS = "Chrome doesn't let extensions see this page; browsertodo will work in other tabs";
/** How long a key press gets to reach the extension's command handler before it counts as not delivered. */
const KEY_PRESS_GRACE_MS = 1500;
const RUN_TIMEOUT = claude ? 8 * 60_000 : 15_000;
/** The fake brain's follow-up suggestion after "check my email". */
const FAKE_SUGGESTION = "Reply to Example App";

const emailArg = process.argv.find((a) => a.startsWith("--email="))?.slice(8);
// The fake mailbox is https://mail.google.com (the browser ignores certificate errors).
const site = await createVerifyEmailSite(0, { tls: selfSignedCert(["mail.google.com"]), ...(emailArg ? { email: emailArg } : {}) });
const unregisterHelper = claude ? registerHelperTemporarily() : () => {};

const { step, finish } = createSuite("screen");
const ext = await launchExtension({
  name: "screen",
  ignoreHTTPSErrors: true,
  ...(claude ? { env: { ...process.env, BROWSERTODO_BRAIN: "claude", CLAUDECODE: "" } } : {}),
  args: [`--host-resolver-rules=MAP mail.google.com 127.0.0.1:${site.mailPort}`, "--ignore-certificate-errors"],
});
const { context, sw } = ext;

try {
  const bt = (fn, arg) => sw.evaluate(fn, arg);
  const ui = routerUi(sw);
  const eventsOf = async (id) => (await ui({ type: "sessions.events", sessionId: id })).events;
  const runEnded = (sessionId) => sessionWhen(sw, sessionId, "the run to end", { timeout: RUN_TIMEOUT });

  if (!claude) {
    // The fake brain: records the task it got, then looks like the agent is told to (screenshot, read_page).
    await installFakeBrain(sw, {
      arg: FAKE_SUGGESTION,
      makeAct: (suggestion) => {
        const runs = (globalThis.__runs = []);
        /** task: the AgentTask of a first turn (the prompt is built from it); text: a next turn's message. */
        return async (opts, name, kind) => {
          const run = { ...(kind === "start" ? { task: opts.task } : { text: opts.text }), shot: null, url: null, error: null };
          runs.push(run);
          try {
            const shot = await opts.browser.call("browser.screenshot", {});
            run.shot = shot.base64?.length ?? 0;
          } catch (e) {
            run.error = String(e?.message ?? e);
          }
          try {
            run.url = (await opts.browser.call("browser.readPage", {})).url;
          } catch (e) {
            run.error = String(e?.message ?? e);
          }
          opts.onEvent({ type: "assistant_text", text: `looked at ${run.url}` });
          return name === "check my email" ? { summary: "looked", suggestion } : "looked";
        };
      },
    });
  } else {
    await ui({ type: "settings.save", settings: { brain: "claude-code", jevEnabled: false, maxTaskMinutes: 8, maxConsecutiveFailures: 0 } });
    const st = await ui({ type: "helper.connect" });
    assert.equal(st.brain.effective, "claude-code", `brain: ${JSON.stringify(st.brain)}`);
  }
  const lastRun = async () => (await bt(() => globalThis.__runs)).at(-1);

  // The side panel page as a tab of the same window (it follows that window's active tab), and the sign-up page.
  const {
    panel,
    pages: [signup],
    ids: {
      tabs: [signupTab],
      windowId,
    },
  } = await openPanelWithTabs(ext, [site.url("/signup")]);
  await bt((t) => chrome.tabs.update(t, { active: true }), signupTab);

  await step(`the shortcut is declared and Chrome assigned the suggested key (${SUGGESTED})`, async () => {
    const cmds = await bt(() => chrome.commands.getAll());
    const cmd = cmds.find((c) => c.name === "open-chat");
    assert.ok(cmd, JSON.stringify(cmds));
    assert.equal(cmd.shortcut, SUGGESTED);
    return `${cmd.shortcut}: ${cmd.description}`;
  });

  await step("Playwright key presses do not reach Chrome's extension shortcuts (so the handler is tested directly)", async () => {
    await bt(() => {
      const pc = globalThis.__browsertodo.panelCommands;
      globalThis.__cmdCalls = [];
      const orig = pc.onCommand.bind(pc);
      pc.onCommand = (c, t) => (globalThis.__cmdCalls.push(c), orig(c, t));
    });
    await signup.bringToFront();
    await signup.keyboard.press(SUGGESTED.replace(/Ctrl/g, "Control"));
    // Nothing to wait for when the press is not delivered: give it a moment, then look.
    await sleep(KEY_PRESS_GRACE_MS);
    const calls = await bt(() => globalThis.__cmdCalls);
    return calls.length ? `onCommand fired: ${JSON.stringify(calls)}` : "onCommand did not fire (CDP key events go to the page, not Chrome's accelerators)";
  });

  await step("without a user gesture Chrome refuses sidePanel.open (why the handler calls it before any await)", async () => {
    const err = await bt(async (w) => chrome.sidePanel.open({ windowId: w }).then(() => "opened", (e) => e.message), windowId);
    assert.match(err, /user gesture/);
    return err;
  });

  await step("with a gesture the real side panel opens; with the focus in the page the shortcut puts it in the panel's box, and from there toggles voice", async () => {
    // A trusted click in an extension page is a user gesture, like the key press.
    await openSidePanel(sw, panel, windowId);
    await waitFor(() => bt((w) => globalThis.__browsertodo.panelCommands.isOpen(w), windowId), "the panel's hello");
    // The real side panel (not the panel page in a tab, which also shows in getViews).
    const sidePanel = () =>
      panel.evaluate(() => {
        const v = chrome.extension.getViews().find((x) => x !== window && x.location.pathname === "/sidepanel.html");
        return v ? { hasFocus: v.document.hasFocus(), active: v.document.activeElement?.id } : null;
      });
    // Playwright makes every page it drives look focused, so the panel page in its (background) tab would tell
    // the background it has the focus: from here it has the real focus state, like the side panel.
    await (await context.newCDPSession(panel)).send("Emulation.setFocusEmulationEnabled", { enabled: false });
    // The user is in the sign-up page.
    await signup.bringToFront();
    await signup.click("body");
    await waitFor(async () => (await sidePanel())?.hasFocus === false, "the page to have the focus");
    // The key press: the handler in a real user gesture of the service worker.
    const press = await shortcutPresser(ext);
    const first = await press(site.url("/signup"));
    assert.equal(first, "reopened");
    const inBox = await waitFor(
      async () => {
        const p = await sidePanel();
        return p?.hasFocus && p.active === "now-text" && (await bt((w) => globalThis.__browsertodo.panelCommands.inputFocused(w), windowId)) ? p : null;
      },
      "the real keyboard focus in the side panel's box",
      { timeout: 5000 },
    );
    assert.equal(await press(site.url("/signup")), "voice");
    assert.equal(await bt(async () => (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length), 1, "the panel stays open");
    await signup.bringToFront();
    await bt((t) => chrome.tabs.update(t, { active: true }), signupTab);
    return `${first}: ${JSON.stringify(inBox)}; the second press toggled voice in it (signed out: it points at the locked mic)`;
  });

  await step("an empty Enter in Chat starts 'look at this page' in this tab, which the agent looks at in the background", async () => {
    // The panel tab is in the background; the sign-up tab is active: the panel shows its (new) chat.
    await waitFor(() => panel.evaluate(() => !!document.querySelector("#chat-log .chat-empty")), "the new chat");
    await panel.evaluate(() => {
      const t = document.getElementById("now-text");
      t.value = "";
      t.focus();
    });
    await panel.keyboard.press("Enter");
    const sessionId = await waitFor(() => bt((t) => globalThis.__browsertodo.tabChats.get(t), signupTab), "the chat bound to the sign-up tab", { timeout: 15_000 });
    const s = await runEnded(sessionId);
    assert.equal(s.title, SCREEN);
    await waitFor(() => panel.evaluate((t) => document.querySelector("#chat-log .ev-user.screen")?.textContent === t, SCREEN), "the quiet user turn in the panel");
    const events = await eventsOf(sessionId);
    if (!claude) {
      const run = await lastRun();
      // Told which page it is (the tab the chat belongs to), where it works.
      const userTab = { url: site.url("/signup"), title: await signup.title(), access: "here" };
      assert.deepEqual(run.task, { id: sessionId, instructions: SCREEN, account: null, screenHelp: true, userTab });
      assert.equal(run.url, site.url("/signup"));
      assert.ok(run.shot > 100, `background screenshot ${JSON.stringify(run)}`);
      return `outcome ${s.outcome}; screenshot of the background tab ${run.shot} base64 chars; read ${run.url}`;
    }
    const state = site.state();
    const tools = events.filter((e) => e.type === "tool_call").map((e) => e.name.replace(/^mcp__browsertodo__/, ""));
    const first = events.find((e) => e.type === "assistant_text")?.text ?? "";
    const opened = state.visits.some((v) => v.startsWith("mail.google.com") && /\/mail\/1/.test(v));
    console.log(`     tools: ${tools.join(", ")}`);
    console.log(`     first message: ${first.slice(0, 300)}`);
    console.log(`     fixture visits: ${state.visits.join(" ")}`);
    console.log(`     outcome: ${s.outcome}${s.reason ? ` (${s.reason})` : ""}; summary: ${s.summary ?? ""}`);
    assert.ok(tools.slice(0, 3).includes("screenshot"), "took a screenshot first");
    assert.ok(opened, "opened the verification email");
    assert.ok(state.verified, `clicked the link (token ${TOKEN})`);
    return `verified=${state.verified}, opened the mail=${opened}, ${tools.length} tool calls, ${s.outcome}`;
  });

  await step("a chat on a page Chrome keeps extensions out of (chrome://version) still runs, in other tabs, with a quiet line", async () => {
    const restricted = await context.newPage();
    await restricted.goto("chrome://version");
    const tabId = await bt(async (w) => {
      const [t] = await chrome.tabs.query({ url: "chrome://version/" });
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
      await chrome.tabs.update(t.id, { active: true });
      return t.id;
    }, windowId);
    const task = claude
      ? `My email is ${site.email}. There is an unread email in my mailbox at https://mail.google.com asking me to verify my email address: open it and click its verification link.`
      : "check my mail";
    const beforeVerified = site.state().verified;
    const { sessionId } = await ui({ type: "run.message", text: task, tabId });
    const s = await runEnded(sessionId);
    const events = await eventsOf(sessionId);
    const lines = events.filter((e) => e.type === "status").map((e) => e.text);
    assert.ok(lines.includes(RESTRICTED_STATUS), `status lines: ${JSON.stringify(lines)}`);
    assert.ok(!events.some((e) => e.type === "error"), "no error lines");
    if (!claude) {
      const run = await lastRun();
      assert.equal(run.task.instructions, task);
      assert.deepEqual(run.task.userTab, { url: "chrome://version/", title: await restricted.title(), access: "restricted" });
      assert.equal(s.outcome, "done");
      return `${s.outcome}; the agent worked in ${run.url} and was told about chrome://version`;
    }
    const tools = events.filter((e) => e.type === "tool_call").map((e) => e.name.replace(/^mcp__browsertodo__/, ""));
    console.log(`     tools: ${tools.join(", ")}`);
    console.log(`     outcome: ${s.outcome}${s.reason ? ` (${s.reason})` : ""}; verified before=${beforeVerified}`);
    assert.notEqual(s.outcome, "failed", `failed: ${s.reason}`);
    return `${s.outcome}, ${tools.length} tool calls`;
  });
  await step("'check my email' in the mailbox's tab: the agent's follow-up suggestion shows faded in the box; Tab takes it without sending", async () => {
    const mail = await context.newPage();
    await mail.goto("https://mail.google.com/");
    const mailTab = await bt(async (w) => {
      const [t] = (await chrome.tabs.query({ url: "https://mail.google.com/*" })).sort((a, b) => b.id - a.id);
      if (t.windowId !== w) await chrome.tabs.move(t.id, { windowId: w, index: -1 });
      await chrome.tabs.update(t.id, { active: true });
      return t.id;
    }, windowId);
    await waitFor(() => panel.evaluate(() => !!document.querySelector("#chat-log .chat-empty")), "the mailbox tab's new chat");
    await panel.fill("#now-text", "check my email");
    await panel.focus("#now-text");
    await panel.keyboard.press("Enter");
    const sessionId = await waitFor(() => bt((t) => globalThis.__browsertodo.tabChats.get(t), mailTab), "the chat bound to the mailbox tab", { timeout: 15_000 });
    const s = await runEnded(sessionId);
    const answer = (await eventsOf(sessionId)).filter((e) => e.type === "assistant_text").at(-1)?.text ?? "";
    if (claude) {
      console.log(`     answer: ${answer.slice(0, 400).replace(/\n/g, " / ")}`);
      console.log(`     outcome: ${s.outcome}; summary: ${s.summary ?? ""}; suggestion: ${s.suggestion === undefined ? "(none)" : JSON.stringify(s.suggestion)}`);
    } else {
      assert.equal(s.suggestion, FAKE_SUGGESTION);
    }
    if (!s.suggestion) return `${s.outcome}; the agent proposed no follow-up`;
    // Faded in the empty box, told to screen readers; Tab puts it in the box and sends nothing.
    await waitFor(() => panel.evaluate((t) => document.querySelector("#now-ghost:not([hidden]) .now-ghost-rest")?.textContent === t, s.suggestion), "the suggestion in the box");
    const described = await panel.evaluate(() => document.getElementById(document.getElementById("now-text").getAttribute("aria-describedby"))?.textContent);
    assert.equal(described, `Suggestion: “${s.suggestion}”. Press Tab to use it.`);
    await panel.focus("#now-text");
    await panel.keyboard.press("Tab");
    assert.equal(await panel.inputValue("#now-text"), s.suggestion);
    assert.equal(await panel.evaluate(() => document.getElementById("now-ghost").hidden), true);
    await sleep(500);
    const after = await ui({ type: "sessions.events", sessionId });
    assert.equal(after.session.turns ?? 1, 1, "Tab sent nothing");
    assert.ok(after.session.endedAt, "no new turn started");
    // Emptied, the box offers it again; an empty Enter still looks at the page (the fake brain only: it is quick).
    await panel.fill("#now-text", "");
    await waitFor(() => panel.evaluate(() => !document.getElementById("now-ghost").hidden), "the suggestion back in the emptied box");
    if (claude) return `${s.outcome}; suggestion ${JSON.stringify(s.suggestion)} shown faded, Tab took it`;
    await panel.keyboard.press("Enter");
    const next = await sessionWhen(sw, sessionId, "the empty message's turn to end", { timeout: RUN_TIMEOUT, until: (x) => (x.turns ?? 1) === 2 && !!x.endedAt });
    const users = (await eventsOf(sessionId)).filter((e) => e.type === "user_message").map((e) => e.text);
    assert.equal(users.at(-1), SCREEN, `the empty Enter's message: ${JSON.stringify(users)}`);
    assert.equal(next.suggestion, undefined, "the new turn left no suggestion");
    await waitFor(() => panel.evaluate(() => document.getElementById("now-ghost").hidden), "the suggestion gone after sending");
    return `suggestion ${JSON.stringify(s.suggestion)} shown faded, Tab took it without sending; an empty Enter then looked at the page`;
  });
} finally {
  await ext.close();
  await site.close();
  unregisterHelper();
}

finish();
