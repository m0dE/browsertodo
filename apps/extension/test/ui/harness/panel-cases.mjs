// The side panel cases of the UI harness: each { names (its screenshots), run(t) } runs when --only
// matches one of its names (or `when(t)` says so) at every panel size and colour scheme. `t` has the
// size's browser context and label, the checks (checks.mjs) and the panel helpers below.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installChromeStub, installVoiceFakes } from "./chrome-stub.mjs";
import { EMAIL_ANSWER, scenario, SHORTCUT_LABEL, SUGGESTION, thumbnail, VOICE_SHORTCUT_LABEL } from "./scenarios.mjs";
import { RAW_SECRET } from "./raw-scenario.mjs";

export const SIZES = [
  { w: 360, h: 800 },
  { w: 480, h: 900 },
];

/** A follow-up suggestion near the longest allowed (MAX_SUGGESTION_CHARS). */
const LONG_SUGGESTION = "Reply to Jordan and Sam that I'll sign the lease on Thursday and call on Friday";

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

/** Checks shared by the panel cases, for the size and scheme `label`; problems go to `problem`. */
export function panelHelpers(label, problem) {
  const fail = (what) => problem(`${what} (${label})`);
  /** The Chat action bar: each button's label, whether it can be used, and its tooltip. */
  const chatBar = (p) =>
    p.evaluate(() =>
      Object.fromEntries(
        ["chat-new", "chat-show", "chat-raw-btn"].map((id) => {
          const b = document.getElementById(id);
          return [id, { text: b.textContent, on: b.getAttribute("aria-disabled") !== "true", title: b.title }];
        }),
      ),
    );
  const expectBar = async (p, want, what) => {
    const bar = await chatBar(p);
    const order = await p.evaluate(() => [...document.querySelectorAll(".chat-bar .bar-btn")].map((b) => b.textContent).join(" | "));
    if (order !== "New chat | Show tab | Raw") fail(`chat bar order "${order}"`);
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
  /**
   * The chat's first message (the prompt or task that opened it, the first thing in the log): its text, its origin
   * label, its files line, the time under it, the brain chip right after it; null when the chat has none.
   */
  const firstMessage = (p) =>
    p.evaluate(() => {
      const wrap = document.querySelector("#chat-log > .ev-opening");
      const b = wrap?.querySelector(".ev-first");
      if (!b) return null;
      return {
        first: wrap === document.getElementById("chat-log").firstElementChild,
        text: b.querySelector(".ev-user-text, :scope.screen > span")?.textContent ?? null,
        screen: b.classList.contains("screen"),
        origin: b.querySelector(".ev-origin")?.textContent ?? null,
        files: b.querySelector(".ev-files")?.textContent ?? null,
        when: wrap.querySelector(".ev-when")?.textContent ?? null,
        role: b.getAttribute("role"),
        tabIndex: b.tabIndex,
        head: wrap.nextElementSibling?.classList.contains("ev-head") ? wrap.nextElementSibling.textContent : null,
        // The old header block is gone, and each brain's start line is left to the chip.
        header: !!document.querySelector("#chat-title, #chat-meta, #chat-conv"),
        startLines: [...document.querySelectorAll("#chat-log .ev-status")].filter((e) => /^(Claude Code started|Claude API \(|BrowserTODO AI \()/i.test(e.textContent)).length,
      };
    });
  /** Waits until the chat's first message starts with `text`. */
  const waitFirst = (p, text) => p.waitForFunction((t) => document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent.startsWith(t), text);
  return { fail, chatBar, expectBar, expectChipHints, tabsText, firstMessage, waitFirst };
}

export const PANEL_CASES = [
  // Idle: nothing running. Chat is the default tab and shows an empty new chat; the composer starts a one-off task.
  {
    names: ["panel-chat-idle", "panel-composer-long", "panel-model-menu", "panel-composer-files"],
    async run({ ctx, size, scheme, label, fail, expectBar, tabsText, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle", ".chat-empty");
      if ((await tabsText(p)) !== "Chat | TODO | History") fail(`tabs "${await tabsText(p)}"`);
      const bar = await expectBar(p, { "chat-new": false, "chat-show": false }, "idle chat");
      if (!/already a new chat/.test(bar["chat-new"].title)) fail(`New Chat tooltip "${bar["chat-new"].title}"`);
      // Disabled bar buttons do nothing.
      await p.click("#chat-show", { force: true });
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "agent.show"))) fail("disabled bar button sent a request");
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
        // Each model says how fast and how costly it is, from the shared catalog (modelHint).
        const hints = await p.evaluate(() => [...document.querySelectorAll(".mm-item[role=menuitemradio]")].map((b) => [b.querySelector(".mm-label")?.textContent, b.querySelector(".mm-hint")?.textContent]));
        const wanted = [
          ["Sonnet 5", "Faster · default price"],
          ["Opus 5.5", "Thinks first, slower · 2× price"],
          ["Fable 5.1", "Thinks first, slower · 5× price"],
          ["Haiku 4.5", "Faster · ½ price"],
        ];
        if (JSON.stringify(hints) !== JSON.stringify(wanted)) fail(`model menu hints ${JSON.stringify(hints)}`);
        // Each hint stays inside the menu and clear of the check mark.
        const spill = await p.evaluate(() => {
          const menu = document.getElementById("model-menu").getBoundingClientRect();
          return [...document.querySelectorAll(".mm-item[role=menuitemradio] .mm-hint")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const mark = el.closest(".mm-item").querySelector(".mm-check")?.getBoundingClientRect();
              return r.right > menu.right - 4 || el.scrollWidth > el.clientWidth || (mark && r.right > mark.left);
            })
            .map((el) => el.textContent);
        });
        if (spill.length) fail(`model menu hints spill over: ${JSON.stringify(spill)}`);
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
        // Thorough reasoning: a switch like Jev's, saved with the settings.
        await chip.click();
        await p.click("#model-menu .mm-reasoning");
        const thorough = await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.reasoning === "thorough"));
        if (!escaped || !saved || !outside || !thorough) fail(`model menu behaviour: escape=${escaped} saved=${saved} outside=${outside} thorough=${thorough}`);
      }
      if (want("panel-composer-files", size, scheme)) {
        await p.setInputFiles("#now-files", [
          { name: "week38-photo-of-the-week-final.jpg", mimeType: "image/jpeg", buffer: Buffer.from(thumbnail, "base64") },
          { name: "caption.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
        ]);
        await p.waitForFunction(() => document.querySelectorAll("#now-files-list .att-chip:not(.preparing)").length === 2);
        await p.click("#now-text");
        await p.keyboard.insertText("Post the photo of the week with this caption");
        await checkLayout(p, `composer-files ${label}`);
        await shoot(p, "panel-composer-files", size, scheme);
      }
      reportErrors(p, `idle ${label}`);
      await p.close();
    },
  },
  // An empty box in Chat: the placeholder says what Enter does; Send looks usable; the new chat shows the shortcut.
  // Enter starts "look at this page" in this tab; the chat shows it as a quiet user turn. Under TODO an empty
  // box does nothing but say so. The shortcut's push switches to Chat and focuses the box; Change opens Chrome's page.
  {
    names: ["panel-empty-send", "panel-empty-send-sent", "panel-restricted", "panel-empty-noshortcut"],
    async run({ ctx, size, scheme, label, fail, firstMessage, openPanel, shoot, checkLayout, reportErrors }) {
      const SCREEN = "Figure out what to do based on the current screen";
      const p = await openPanel(ctx, "idle", ".chat-empty .shortcut-hint");
      const look = await p.evaluate(() => {
        const t = document.getElementById("now-text");
        const b = document.getElementById("now-submit");
        return {
          placeholder: t.placeholder,
          focused: document.activeElement === t,
          opacity: getComputedStyle(b).opacity,
          title: b.title,
          hint: document.querySelector(".chat-empty .shortcut-hint")?.textContent,
          hello: window.__portSent.some((m) => m.type === "panel.hello" && m.windowId === 1),
        };
      });
      if (look.placeholder !== SCREEN) fail(`empty send: placeholder "${look.placeholder}"`);
      if (!look.focused) fail("empty send: the box is not focused when the panel opens");
      if (look.opacity !== "1") fail(`empty send: Send looks unavailable (opacity ${look.opacity})`);
      if (!/look at this page/.test(look.title)) fail(`empty send: Send tooltip "${look.title}"`);
      // Both keys, briefly: open, and talk.
      if (look.hint !== `${SHORTCUT_LABEL} to open · ${VOICE_SHORTCUT_LABEL} to talk`) fail(`empty send: shortcut hint "${look.hint}"`);
      if (!look.hello) fail("empty send: the panel did not tell the background its window");
      // The placeholder is one line at this width (measured with the box's font).
      const oneLine = await p.evaluate((text) => {
        const t = document.getElementById("now-text");
        const cs = getComputedStyle(t);
        const c = document.createElement("canvas").getContext("2d");
        c.font = `${cs.fontSize} ${cs.fontFamily}`;
        return c.measureText(text).width <= t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      }, SCREEN);
      if (!oneLine) fail("empty send: the placeholder wraps");
      await checkLayout(p, `empty send ${label}`);
      await shoot(p, "panel-empty-send", size, scheme);


      await p.click("#now-text");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc" && r.screen === true));
      const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc" && r.screen));
      if (req.instructions !== "" || req.tabId !== 1) fail(`empty send: request ${JSON.stringify(req)}`);
      await p.waitForSelector("#chat-log .ev-user.screen");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-new" } }), e);
      await push({ type: "tool_call", id: "1", name: "screenshot", args: {} });
      await push({ type: "tool_result", id: "1", name: "screenshot", thumbnail });
      await push({ type: "tool_call", id: "2", name: "read_page", args: {} });
      await push({ type: "tool_result", id: "2", name: "read_page", text: "URL: http://127.0.0.1/signup/check-email" });
      await push({
        type: "assistant_text",
        text: "The page says a verification link was sent to **test@example.com**. I'll open that mailbox in a new tab, find the email and click the link.",
      });
      await push({ type: "tool_call", id: "3", name: "open_tabs", args: { urls: ["http://127.0.0.1/mail"] } });
      await p.waitForSelector("#chat-log .ev-text");
      // The empty send is the chat's first message, in its own quiet look (no header over it repeating it).
      const turn = await p.evaluate(() => ({ text: document.querySelector("#chat-log .ev-user.screen")?.textContent, users: document.querySelectorAll("#chat-log .ev-user").length }));
      const first = await firstMessage(p);
      if (turn.text !== SCREEN || turn.users !== 1 || !first?.first || !first.screen || first.text !== SCREEN || first.header || !first.when) fail(`empty send: user turn ${JSON.stringify({ turn, first })}`);
      await checkLayout(p, `empty send sent ${label}`);
      await shoot(p, "panel-empty-send-sent", size, scheme);

      // Chrome keeps extensions out of the user's page: one quiet line, the run goes on.
      await push({ type: "status", text: "Chrome doesn't let extensions see this page; BrowserTODO will work in other tabs" });
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("Chrome doesn't let extensions see this page"));
      const line = await p.evaluate(() => {
        const el = [...document.querySelectorAll("#chat-log *")].reverse().find((e) => e.children.length === 0 && e.textContent.includes("Chrome doesn't let extensions"));
        return { cls: el?.className, err: !!el?.closest(".ev-error") };
      });
      if (!line.cls || line.err) fail(`restricted: not a quiet line ${JSON.stringify(line)}`);
      await checkLayout(p, `restricted ${label}`);
      await shoot(p, "panel-restricted", size, scheme);

      // The keyboard shortcut's push: Chat, with the cursor in the box.
      await p.click("#tab-btn-todo");
      await p.evaluate(() => window.__push({ type: "panel.focus" }));
      const focused = await p.evaluate(() => ({ tab: document.querySelector(".tabs [aria-selected=true]").dataset.tab, box: document.activeElement?.id }));
      if (focused.tab !== "chat" || focused.box !== "now-text") fail(`shortcut focus ${JSON.stringify(focused)}`);
      // The page's focus is reported with the text in the box (the shortcut recreates the panel from there when it lacks the focus).
      if (!(await p.evaluate(() => window.__portSent.some((m) => m.type === "panel.document")))) fail("page focus not reported");
      reportErrors(p, `empty send ${label}`);
      await p.close();

      // Under TODO an empty box does nothing, and says so.
      const t = await openPanel(ctx, "idle", ".chat-empty");
      await t.click("#tab-btn-todo");
      await t.click("#now-text");
      await t.keyboard.press("Enter");
      await t.waitForFunction(() => document.querySelector("#now-notice:not([hidden]) .notice-text")?.textContent);
      const todo = await t.evaluate(() => ({
        sent: window.__requests.some((r) => r.type === "run.adhoc" || r.type === "run.message"),
        msg: document.querySelector("#now-notice:not([hidden]) .notice-text")?.textContent,
        placeholder: document.getElementById("now-text").placeholder,
        opacity: getComputedStyle(document.getElementById("now-submit")).opacity,
      }));
      if (todo.sent || todo.msg !== "Type a task to run it now" || !todo.placeholder.startsWith("Do this now") || todo.opacity === "1") fail(`TODO empty send ${JSON.stringify(todo)}`);
      reportErrors(t, `todo empty ${label}`);
      await t.close();

      // No key assigned (another extension has it): the new chat links to Chrome's shortcut settings instead.
      const n = await openPanel(ctx, "noshortcut", ".chat-empty .shortcut-hint");
      const hint = await n.evaluate(() => document.querySelector(".chat-empty .shortcut-hint").textContent);
      if (hint !== "Set a keyboard shortcut to open this chat at any time.") fail(`no shortcut: hint "${hint}"`);
      await n.click(".chat-empty .shortcut-link");
      if (!(await n.evaluate(() => window.__created.includes("chrome://extensions/shortcuts")))) fail("no shortcut: the link did not open chrome://extensions/shortcuts");
      await shoot(n, "panel-empty-noshortcut", size, scheme);
      reportErrors(n, `no shortcut ${label}`);
      await n.close();
    },
  },
  // Tab memory: values saved by older panels open the renamed tabs.
  {
    when: ({ size, scheme, only }) => size.w === 360 && scheme === "light" && !only,
    async run({ ctx, label, fail, openPanel, reportErrors }) {
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
    },
  },
  // Empty todo list: nothing due, so Run due is not shown; with cloud sync (its queue unknown here) it is.
  {
    names: ["panel-todo-empty"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "empty", ".chat-empty");
      await p.click("#tab-btn-todo");
      await p.waitForSelector("#tasks-empty:not([hidden])");
      const runDue = () => p.evaluate(() => ({ shown: !document.getElementById("run-now").hidden, text: document.getElementById("run-now").textContent, title: document.getElementById("run-now").title }));
      const idle = await runDue();
      if (idle.shown) fail(`Run due shown with nothing due ${JSON.stringify(idle)}`);
      await checkLayout(p, `empty ${label}`);
      await shoot(p, "panel-todo-empty", size, scheme);
      const st = scenario("empty").state;
      await p.evaluate((s) => window.__push({ type: "state", state: s }), { ...st, settings: { ...st.settings, cloudEnabled: true } });
      const cloud = await runDue();
      if (!cloud.shown || cloud.text !== "Run due" || !/check the cloud queue/.test(cloud.title)) fail(`Run due with cloud sync ${JSON.stringify(cloud)}`);
      reportErrors(p, `empty ${label}`);
      await p.close();
    },
  },
  // A running session: TODO, then Chat with its action bar, then the History tab.
  {
    names: ["panel-todo", "panel-model-running", "panel-finished-menu", "panel-chat-running", "panel-history", "panel-history-open"],
    async run({ ctx, size, scheme, label, fail, expectBar, expectChipHints, firstMessage, want, only, openPanel, shoot, checkLayout, reportErrors, wantAny, shots, taken }) {
      const page = await openPanel(ctx, "ok", ".ev-tool");
      await page.click("#tab-btn-todo");
      await page.waitForSelector(".task");
      const rn = await page.evaluate(() => ({ text: document.getElementById("run-now").textContent, shown: !document.getElementById("run-now").hidden, title: document.getElementById("run-now").title }));
      if (rn.text !== "Run due (1)" || !rn.shown || rn.title !== "Run the 1 task whose time has come now, instead of waiting for the next check (every 15 minutes)") fail(`Run due ${JSON.stringify(rn)}`);
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
      if (want("panel-finished-menu", size, scheme)) {
        await page.locator("#finished > summary").click();
        await expectChipHints(page, "finished");
        await page.locator("#finished-list .menu summary").first().click();
        await page.locator("#finished-list .menu[open] .menu-pop").scrollIntoViewIfNeeded();
        await shoot(page, "panel-finished-menu", size, scheme);
        await page.locator("#tab-todo .section-head h2").click();
      }
      if (wantAny(["panel-chat-running", "panel-history", "panel-history-open"], size, scheme)) {
        await page.click("#tab-btn-chat");
        await page.waitForSelector("#chat-log .ev-tool", { state: "attached" });
        // Running: New chat and Show Tab work.
        await expectBar(page, { "chat-new": true, "chat-show": true }, "running chat");
        // One steps group unfolded, with one long result open.
        await page.locator("details.ev-result").first().evaluate((d) => {
          d.open = true;
          d.closest("details.ev-steps").open = true;
        });
        await page.locator("#chat-log").evaluate((l) => (l.scrollTop = l.scrollHeight));
        await checkLayout(page, `chat ${label}`);
        await shoot(page, "panel-chat-running", size, scheme);
        await page.click("#chat-show");
        const shown = await page.evaluate(() => window.__requests.find((r) => r.type === "agent.show"));
        if (shown?.sessionId !== "s-live") fail(`Show Tab sent ${JSON.stringify(shown)}`);

        // History: the list of runs, no composer. Picking a finished run (by keyboard) opens it in Chat, bound to this tab.
        await page.click("#tab-btn-history");
        await page.waitForSelector(".sessions li");
        await expectChipHints(page, "history");
        await checkLayout(page, `history ${label}`);
        await shoot(page, "panel-history", size, scheme);
        if (await page.evaluate(() => !!document.querySelector("#hist-past, #hist-log, #hist-open, #hist-rawlog"))) fail("the read-only run view is still in the page");
        const pastRow = page.locator(".sessions li button").nth(1);
        const pastId = await pastRow.getAttribute("data-id");
        await pastRow.focus();
        await page.keyboard.press("Enter");
        await page.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-text");
        const opened = await page.evaluate(() => ({
          tab: document.querySelector(".tabs [aria-selected=true]")?.id,
          title: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent,
          bind: window.__requests.filter((r) => r.type === "chat.bind").at(-1),
          composer: !document.getElementById("composer").hidden,
          focus: document.activeElement?.id,
        }));
        if (opened.tab !== "tab-btn-chat" || opened.title !== "Post 'good morning' on X" || opened.bind?.sessionId !== pastId || opened.bind?.tabId !== 1 || !opened.composer || opened.focus !== "now-text") {
          fail(`History row did not open the run in Chat: ${JSON.stringify(opened)}`);
        }
        await checkLayout(page, `history open ${label}`);
        await shoot(page, "panel-history-open", size, scheme);
        // A running one opens in Chat too.
        await page.click("#tab-btn-history");
        await page.waitForSelector(".sessions li");
        await page.locator(".sessions li button").first().click();
        await page.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-tool", { state: "attached" });
      }
      reportErrors(page, `running ${label}`);
      await page.close();
    },
  },
  // Task details: the chat's first message (a task run's instructions, or a past chat's prompt), and a TODO title,
  // open a sheet with everything known.
  {
    names: ["panel-first-task", "panel-details-chat", "panel-details-focus", "panel-details-todo", "panel-first-long", "panel-details-message"],
    async run({ ctx, size, scheme, label, fail, want, firstMessage, waitFirst, openPanel, shoot, checkLayout, reportErrors, base, shots, taken }) {
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

      // Chat: the task run opens with its instructions as the first message, labelled with where they came from.
      const first = await firstMessage(p);
      if (!first?.first || first.origin !== "From your TODO list" || first.text !== known.state.running.title || !first.when || first.header || first.head !== "Claude API · claude-sonnet-5 · Jev on") fail(`task run's first message ${JSON.stringify(first)}`);
      await checkLayout(p, `details-task-run ${label}`);
      await shoot(p, "panel-first-task", size, scheme);
      // It is reachable by keyboard (Tab from the action bar) and shows a focus ring.
      await p.focus("#chat-raw-btn");
      await p.keyboard.press("Tab");
      const ring = await p.evaluate(() => {
        const t = document.activeElement;
        return { first: t.classList.contains("ev-first"), role: t.getAttribute("role"), visible: t.matches(":focus-visible"), outline: getComputedStyle(t).outlineStyle };
      });
      if (!ring.first || ring.role !== "button" || !ring.visible || ring.outline === "none") fail(`first message focus ${JSON.stringify(ring)}`);
      await shoot(p, "panel-details-focus", size, scheme);
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
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Esc did not return focus to the first message");
      // Open in TODO: the TODO tab, focused on the task (a click on the first message opens the sheet too).
      await p.click("#chat-log .ev-first");
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
      for (const [k, v] of [["Status", "scheduled"], ["Repeats", "Daily at 9:00 AM and 6:00 PM"], ["Attempts", "0"], ["Task id", "t1"]]) {
        if (todo.fields[k] !== v) fail(`todo details ${k}: ${todo.fields[k]}`);
      }
      if (!todo.fields["Next run"]) fail("todo details: no Next run");
      if (todo.files.join() !== "thank-you.gif") fail(`todo details files ${todo.files}`);
      if (todo.buttons.includes("Open in TODO")) fail("todo details offers Open in TODO from the TODO tab");
      await shoot(p, "panel-details-todo", size, scheme);
      await p.mouse.click(size.w / 2, 8);
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if ((await p.evaluate(() => document.activeElement?.dataset?.taskId)) !== "t1") fail("backdrop click did not return focus to the task");

      // History: a past one-off chat opens in Chat, with the whole message typed as its first bubble (a long,
      // multi-line prompt, wrapped); the bubble opens its details.
      await p.click("#tab-btn-history");
      await p.locator(".sessions li button", { hasText: "Lisbon" }).click();
      await p.waitForFunction(() => !document.getElementById("tab-chat").hidden);
      await waitFirst(p, "Find the cheapest flight");
      const lisbonFirst = await firstMessage(p);
      if (lisbonFirst.text !== known.sessions.find((x) => x.sessionId === "s-3").instructions || lisbonFirst.origin !== null) fail(`past chat's first message ${JSON.stringify(lisbonFirst)}`);
      const wraps = await p.evaluate(() => {
        const b = document.querySelector("#chat-log .ev-first").getBoundingClientRect();
        return { lines: Math.round(b.height / 20), inside: b.right <= document.getElementById("chat-log").getBoundingClientRect().right + 0.5 };
      });
      if (wraps.lines < 3 || !wraps.inside) fail(`long prompt not wrapped in the bubble ${JSON.stringify(wraps)}`);
      await checkLayout(p, `details-long-prompt ${label}`);
      await shoot(p, "panel-first-long", size, scheme);
      await p.focus("#chat-log .ev-first");
      await p.keyboard.press("Enter");
      await p.waitForSelector("dialog.sheet[open]");
      const msg = await sheet();
      checkSheet(msg, "details of a chat message");
      const lisbon = known.sessions.find((x) => x.sessionId === "s-3");
      if (msg.heading !== "Chat message" || msg.text !== lisbon.instructions || msg.fields.Source !== "Chat message" || msg.fields["Last pause reason"] !== "Needs you to pick dates") fail(`message details ${JSON.stringify(msg)}`);
      if (msg.buttons.includes("Open in TODO")) fail("chat message offers Open in TODO");
      await shoot(p, "panel-details-message", size, scheme);
      await p.locator("dialog.sheet button", { hasText: "Close" }).click();
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Close did not return focus to the first message");
      reportErrors(p, `details ${label}`);
      await p.close();
    },
  },
  // A new chat with a long, multi-line prompt and two files: the prompt as typed is the first message (wrapped, with
  // its files), then the brain chip; the brain's start line is not repeated; the bubble opens the message's details.
  {
    names: ["panel-first-files", "panel-first-files-details"],
    async run({ ctx, size, scheme, label, fail, firstMessage, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle", ".chat-empty");
      await p.setInputFiles("#now-files", [
        { name: "week38-photo-of-the-week-final.jpg", mimeType: "image/jpeg", buffer: Buffer.from(thumbnail, "base64") },
        { name: "caption.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
      ]);
      await p.waitForFunction(() => document.querySelectorAll("#now-files-list .att-chip:not(.preparing)").length === 2);
      await p.click("#now-text");
      await p.keyboard.insertText(LONG_TEXT);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
      await p.waitForSelector("#chat-log .ev-first");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-new" } }), e);
      await push({ type: "status", text: "Claude API (claude-sonnet-5) with Jev" });
      await push({ type: "assistant_text", text: "I'll open X, check the account, then write the thread with the photo." });
      await push({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://x.com/compose/post" } });
      await p.waitForSelector("#chat-log .ev-first .ev-attachments");
      const first = await firstMessage(p);
      const sentFiles = await p.evaluate(() => document.querySelectorAll("#chat-log .ev-first .att-sent").length);
      if (!first.first || first.text !== LONG_TEXT || sentFiles !== 2 || first.origin !== null || !first.when || first.header) fail(`first message with files ${JSON.stringify({ ...first, sentFiles })}`);
      if (first.head !== "Claude API · claude-sonnet-5 · Jev on" || first.startLines !== 0) fail(`brain shown more than once ${JSON.stringify(first)}`);
      const box = await p.evaluate(() => {
        const b = document.querySelector("#chat-log .ev-first").getBoundingClientRect();
        const log = document.getElementById("chat-log").getBoundingClientRect();
        return { tall: b.height > 200, inside: b.left >= log.left && b.right <= log.right + 0.5 };
      });
      if (!box.tall || !box.inside) fail(`long prompt bubble ${JSON.stringify(box)}`);
      await checkLayout(p, `first-files ${label}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-first-files", size, scheme);
      // A click on the bubble opens the message's details, with the whole message.
      await p.click("#chat-log .ev-first");
      await p.waitForSelector("dialog.sheet[open]");
      const sheet = await p.evaluate(() => ({ heading: document.querySelector("dialog.sheet h2").textContent, text: document.querySelector("dialog.sheet .sheet-text")?.textContent }));
      if (sheet.heading !== "Chat message" || sheet.text !== LONG_TEXT) fail(`first message details ${JSON.stringify(sheet)}`);
      await shoot(p, "panel-first-files-details", size, scheme);
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if (!(await p.evaluate(() => document.activeElement?.classList.contains("ev-first")))) fail("Esc did not return focus to the first message");
      // Selecting text in the bubble (to copy it) does not open the sheet.
      // (The text, below the files strip.)
      const b = await p.locator("#chat-log .ev-first .ev-user-text").boundingBox();
      const y = b.y + b.height / 2;
      await p.mouse.move(b.x + 14, y);
      await p.mouse.down();
      await p.mouse.move(b.x + b.width - 14, y, { steps: 5 });
      await p.mouse.up();
      const picked = await p.evaluate(() => ({ selected: String(getSelection()), sheet: !!document.querySelector("dialog.sheet") }));
      if (!picked.selected || picked.sheet) fail(`selecting the first message's text ${JSON.stringify(picked)}`);
      reportErrors(p, `first-files ${label}`);
      await p.close();
    },
  },
  // A conversation: two turns in one thread, each opened by the user's bubble (the first is the prompt, with its time
  // and the brain chip under it); the composer talks to it; New Chat empties the thread and goes back to "Do this now".
  {
    names: ["panel-conversation", "panel-conversation-newchat", "panel-conversation-todo"],
    async run({ ctx, size, scheme, label, fail, expectBar, firstMessage, want, only, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "conversation", "#chat-log .ev-user");
      const composer = () =>
        p.evaluate(() => ({
          placeholder: document.getElementById("now-text").placeholder,
          submit: document.getElementById("now-submit").textContent,
          newChat: document.getElementById("chat-new").getAttribute("aria-disabled") !== "true",
          attach: !document.getElementById("now-attach").hidden,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const CHAT = { placeholder: "Message BrowserTODO…", submit: "Send", newChat: true, attach: true, stop: false };
      const NEW = { placeholder: "Figure out what to do based on the current screen", submit: "Send", newChat: false, attach: true, stop: false };
      const expectComposer = async (want, what) => {
        const got = await composer();
        if (JSON.stringify(got) !== JSON.stringify(want)) fail(`composer ${what}: ${JSON.stringify(got)}`);
      };
      // The last conversation ended a minute ago: Chat shows it and the composer talks to it, also from TODO.
      await p.waitForFunction(() => document.getElementById("now-text").placeholder === "Message BrowserTODO…");
      const view = await p.evaluate(() => ({
        bubbles: [...document.querySelectorAll("#chat-log .ev-user")].map((b) => b.textContent),
        ends: document.querySelectorAll("#chat-log .ev-end").length,
        // Each end card says who picked its turn's elements; the picks status line itself is not shown on its own.
        picks: [...document.querySelectorAll("#chat-log .ev-end .ev-picks")].map((e) => e.textContent),
        loosePicks: [...document.querySelectorAll("#chat-log > .ev-status")].filter((e) => !e.hidden && /element pick/.test(e.textContent)).length,
        heads: document.querySelectorAll("#chat-log .ev-head").length,
        // The second bubble opens the second turn: right after the first turn's end card.
        order: [...document.querySelectorAll("#chat-log > *")].map((e) => e.className).join(" ").includes("ev-end ev-user"),
      }));
      const conv = scenario("conversation").sessions[0];
      if (JSON.stringify(view.bubbles) !== JSON.stringify([conv.title, "Now like the first reply to it"]) || view.ends !== 2 || !view.order) fail(`thread ${JSON.stringify(view)}`);
      const first = await firstMessage(p);
      if (!first?.first || first.text !== conv.title || first.origin !== null || first.role !== "button" || first.tabIndex !== 0 || first.header) fail(`first message ${JSON.stringify(first)}`);
      // The first turn's start: the time under the prompt (not the latest turn's).
      const started = new Date(conv.firstStartedAt);
      const hm = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
      if (!first.when?.endsWith(hm)) fail(`first message time "${first.when}", want ${hm}`);
      // The brain shows once: the chip under the prompt; the brain's own start line is not repeated.
      if (first.head !== "Claude Code · claude-sonnet-5 · Jev on" || view.heads !== 1 || first.startLines !== 0) fail(`brain shown more than once ${JSON.stringify({ first, heads: view.heads })}`);
      const wantPicks = ["Jev chose 2 of 2 element picks (clicks and typing)", "Jev chose 0 of 1 element pick (clicks and typing); Claude chose 1"];
      if (JSON.stringify(view.picks) !== JSON.stringify(wantPicks) || view.loosePicks !== 0) fail(`end card picks ${JSON.stringify(view)}`);
      // Ended Claude Code conversation: no agent tab any more.
      const bar = await expectBar(p, { "chat-new": true, "chat-show": false }, "ended conversation");
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

      // A message goes to the same conversation.
      await p.click("#now-text");
      await p.keyboard.insertText("And retweet it");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
      if (sent.sessionId !== "s-conv" || sent.text !== "And retweet it") fail(`message sent ${JSON.stringify(sent)}`);

      // New Chat: an empty thread, back to "Do this now"; the conversation's agent session is closed.
      await p.click("#chat-new");
      await expectComposer(NEW, "still in the conversation after New Chat");
      const closed = await p.evaluate(() => window.__requests.find((r) => r.type === "run.newChat"));
      if (closed?.sessionId !== "s-conv") fail(`newChat sent ${JSON.stringify(closed)}`);
      if (!(await p.locator(".chat-empty").isVisible())) fail("thread not emptied by New Chat");
      await expectBar(p, { "chat-new": false, "chat-show": false }, "after New Chat");
      await checkLayout(p, `conversation-newchat ${label}`);
      await shoot(p, "panel-conversation-newchat", size, scheme);
      // The next text starts a new conversation.
      await p.click("#now-text");
      await p.keyboard.insertText("Post gm");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc" && r.instructions === "Post gm"));
      reportErrors(p, `conversation ${label}`);
      await p.close();
    },
  },
  // Scheduling from the chat (schedule_task): the card (one line, View in TODO, Undo), the TODO row it points at,
  // the card once undone, and on Free the refusal's card with Choose a plan.
  {
    names: ["panel-scheduled", "panel-scheduled-todo", "panel-scheduled-undone", "panel-scheduled-free"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const card = (p) =>
        p.evaluate(() => {
          const c = document.querySelector("#chat-log .ev-scheduled");
          if (!c) return null;
          const line = c.querySelector(".sched-line");
          const r = line.getBoundingClientRect();
          return {
            line: line.textContent,
            lines: Math.round(r.height / parseFloat(getComputedStyle(line).lineHeight)),
            taskW: line.querySelector(".sched-task").getBoundingClientRect().width,
            inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
            buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
            undone: c.classList.contains("undone"),
            title: line.title,
          };
        });
      if (want("panel-scheduled", size, scheme) || want("panel-scheduled-todo", size, scheme) || want("panel-scheduled-undone", size, scheme)) {
        const p = await openPanel(ctx, "scheduled", "#chat-log .ev-scheduled");
        const c = await card(p);
        // Three hours from now, in the browser's words ("today at 6:45 PM", or "tomorrow at ..." late at night).
        const TASK = "Open https://shop.example.com/orders/48213 and tell me whether order #48213 has shipped yet; if it has, give me the carrier and tracking number.";
        // The first line is clipped at 120 characters (the tooltip holds it all); CSS ellipsizes what does not fit.
        if (!c?.line.startsWith(`Scheduled:${TASK.slice(0, 119)}…· Once, `) || !/Once, (today|tomorrow) at \d/.test(c.line)) fail(`card line "${c?.line}"`);
        // One line where it fits (480); at 360 the schedule may take a second line so the task stays readable.
        if (!c || c.lines > (size.w >= 480 ? 1 : 2) || c.taskW < 100 || !c.inside) fail(`card layout ${JSON.stringify(c)}`);
        if (c?.buttons.join(" | ") !== "View in TODO | Undo") fail(`card buttons ${c?.buttons.join(" | ")}`);
        if (!c?.title.includes("tracking number")) fail("card tooltip does not hold the whole task");
        // The card sits in the thread after the user's request, before the agent's reply.
        const order = await p.evaluate(() => [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "));
        if (!/ev-user .*ev-scheduled .*ev-text/.test(order)) fail(`card out of order: ${order}`);
        await checkLayout(p, `scheduled ${label}`);
        await shoot(p, "panel-scheduled", size, scheme);

        // View in TODO: the TODO tab, with the task's row in view and focused.
        await p.click("#chat-log .sched-view");
        await p.waitForFunction(() => document.querySelector('#tab-btn-todo[aria-selected="true"]') && document.activeElement?.dataset?.taskId === "t-sched");
        const row = await p.evaluate(() => {
          const li = document.querySelector('#tab-todo [data-task-id="t-sched"]').closest("li");
          const r = li.getBoundingClientRect();
          const list = document.getElementById("tab-todo").getBoundingClientRect();
          return { found: li.classList.contains("found"), visible: r.top >= list.top - 1 && r.bottom <= list.bottom + 1 };
        });
        if (!row.found || !row.visible) fail(`View in TODO did not show the row ${JSON.stringify(row)}`);
        await checkLayout(p, `scheduled-todo ${label}`);
        await shoot(p, "panel-scheduled-todo", size, scheme);

        // Undo: the task is deleted, and the card says so (no buttons left).
        await p.click("#tab-btn-chat");
        await p.click("#chat-log .sched-undo");
        await p.waitForSelector("#chat-log .ev-scheduled.undone");
        const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.undoScheduled"));
        if (sent?.sessionId !== "s-sched" || sent.taskId !== "t-sched") fail(`undo sent ${JSON.stringify(sent)}`);
        const u = await card(p);
        if (!u.undone || u.buttons.length || !u.line.startsWith("Undone:")) fail(`undone card ${JSON.stringify(u)}`);
        await checkLayout(p, `scheduled-undone ${label}`);
        await shoot(p, "panel-scheduled-undone", size, scheme);
        reportErrors(p, `scheduled ${label}`);
        await p.close();
      }
      if (want("panel-scheduled-free", size, scheme)) {
        const p = await openPanel(ctx, "scheduled-free", "#chat-log .ev-error");
        const got = await p.evaluate(() => ({
          msg: [...document.querySelectorAll("#chat-log .ev-error .err-msg")].map((e) => e.textContent),
          fixes: [...document.querySelectorAll("#chat-log .ev-error .err-fix")].map((b) => b.textContent),
          cards: document.querySelectorAll("#chat-log .ev-scheduled").length,
        }));
        if (JSON.stringify(got) !== JSON.stringify({ msg: ["Scheduling needs a paid plan."], fixes: ["Choose a plan"], cards: 0 })) fail(`Free refusal ${JSON.stringify(got)}`);
        await checkLayout(p, `scheduled-free ${label}`);
        await shoot(p, "panel-scheduled-free", size, scheme);
        await p.click("#chat-log [data-fix=plans]");
        await p.waitForFunction(() => window.__created.includes("https://app.browsertodo.com/billing") || window.__opened.includes("https://app.browsertodo.com/billing"));
        reportErrors(p, `scheduled-free ${label}`);
        await p.close();
      }
    },
  },
  // The TODO tools from a calendar: a Changed card (a task this chat scheduled, moved without asking) and a Cancelled
  // card (a task the user made, after its approval), each with View in TODO and Undo; Undo on the Cancelled card sends
  // its change id and the card says the task is back.
  {
    names: ["panel-todo-changed", "panel-todo-changed-undone"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      if (!want("panel-todo-changed", size, scheme) && !want("panel-todo-changed-undone", size, scheme)) return;
      const cards = (p) =>
        p.evaluate(() =>
          [...document.querySelectorAll("#chat-log .ev-scheduled")].map((c) => {
            const line = c.querySelector(".sched-line");
            return {
              change: c.dataset.change ?? "scheduled",
              label: c.querySelector(".sched-label").textContent,
              task: c.querySelector(".sched-task").textContent,
              lines: Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)),
              inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
              buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
              note: c.querySelector(".sched-note:not([hidden])")?.textContent ?? "",
            };
          }),
        );
      const p = await openPanel(ctx, "todo-changes", "#chat-log .ev-scheduled[data-change=cancelled]");
      const got = await cards(p);
      const want3 = [
        ["scheduled", "Scheduled:"],
        ["updated", "Changed:"],
        ["cancelled", "Cancelled:"],
      ];
      if (JSON.stringify(got.map((c) => [c.change, c.label])) !== JSON.stringify(want3)) fail(`cards ${JSON.stringify(got)}`);
      for (const c of got) {
        if (c.buttons.join(" | ") !== "View in TODO | Undo") fail(`${c.change} buttons ${c.buttons.join(" | ")}`);
        if (c.lines > (size.w >= 480 ? 1 : 2) || !c.inside) fail(`${c.change} layout ${JSON.stringify(c)}`);
      }
      if (!got[2]?.task.startsWith("Dentist appointment")) fail(`cancelled card task "${got[2]?.task}"`);
      // The approval the cancel waited for sits before its card, answered.
      const order = await p.evaluate(() => [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "));
      if (!/ev-approval .*ev-scheduled .*ev-text/.test(order)) fail(`approval and card out of order: ${order}`);
      await checkLayout(p, `todo-changed ${label}`);
      await shoot(p, "panel-todo-changed", size, scheme);

      // Undo on the Cancelled card: its change id goes to the background, and the card says the task is back.
      await p.click("#chat-log .ev-scheduled[data-change=cancelled] .sched-undo");
      await p.waitForSelector("#chat-log .ev-scheduled[data-change=cancelled].undone");
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.undoTaskChange"));
      if (sent?.sessionId !== "s-todo" || sent.changeId !== "c-cancel") fail(`undo sent ${JSON.stringify(sent)}`);
      const after = (await cards(p))[2];
      if (after?.label !== "Undone:" || after.buttons.length || after.note !== "Back in your TODO list.") fail(`undone card ${JSON.stringify(after)}`);
      // The other cards keep their buttons.
      if ((await cards(p)).slice(0, 2).some((c) => c.buttons.length !== 2)) fail("undo changed another card");
      await checkLayout(p, `todo-changed-undone ${label}`);
      await shoot(p, "panel-todo-changed-undone", size, scheme);
      reportErrors(p, `todo-changed ${label}`);
      await p.close();
    },
  },
  // An action waiting for the user's OK (automation level "Ask before posting, sending or paying"): the approval card
  // with what, where, why and the exact text, answered by a click (Allow once) or a key (Alt+N denies); an earlier
  // allowed one keeps one quiet line.
  {
    names: ["panel-approval", "panel-approval-allowed", "panel-approval-denied", "panel-autonomy-full"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const card = (p) =>
        p.evaluate((wide) => {
          const cards = [...document.querySelectorAll("#chat-log .ev-approval")];
          const log = document.getElementById("chat-log").getBoundingClientRect();
          return cards.map((c) => ({
            state: c.dataset.state,
            head: c.querySelector(".appr-head").textContent,
            action: c.querySelector(".appr-action").textContent,
            text: c.querySelector(".appr-text")?.textContent ?? null,
            buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
            inside: c.scrollWidth <= c.clientWidth + 1 && c.getBoundingClientRect().right <= log.right + 1,
            buttonsOneRow: new Set([...c.querySelectorAll(".appr-actions button")].map((b) => Math.round(b.getBoundingClientRect().top))).size <= (wide ? 1 : 2),
          }));
        }, size.w >= 480);
      const sent = (p) => p.evaluate(() => window.__requests.filter((r) => r.type === "approval.answer"));
      if (want("panel-approval", size, scheme) || want("panel-approval-allowed", size, scheme)) {
        const p = await openPanel(ctx, "approval", "#chat-log .ev-approval[data-state=pending]");
        const [earlier, now] = await card(p);
        if (earlier?.state !== "allowed" || earlier.head !== "Allowed once" || earlier.buttons.length) fail(`earlier card ${JSON.stringify(earlier)}`);
        if (now?.state !== "pending" || now.head !== "Waiting for your OK" || now.action !== 'Click "Post" on x.com · publishes') fail(`card ${JSON.stringify(now)}`);
        if (!now?.text?.startsWith("We just shipped browsertodo 0.3") || !now.text.includes("\n\nhttps://")) fail(`card text ${JSON.stringify(now?.text)}`);
        if (now?.buttons.join(" | ") !== "Allow once | Allow for this task | Deny") fail(`buttons ${now?.buttons.join(" | ")}`);
        if (!now?.inside || !now.buttonsOneRow) fail(`card layout ${JSON.stringify(now)}`);
        const titles = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-approval[data-state=pending] button")].map((b) => b.title));
        if (titles.join(" | ") !== "Allow once (Alt+Y) | Allow for this task (Alt+T) | Deny (Alt+N)") fail(`shortcut titles ${titles.join(" | ")}`);
        if (await p.isVisible("#autonomy-warning")) fail("the Full autonomy warning shows at the default level");
        await checkLayout(p, `approval ${label}`);
        await shoot(p, "panel-approval", size, scheme);
        await p.click("#chat-log .ev-approval[data-state=pending] button[data-answer=allow_once]");
        await p.waitForSelector("#chat-log .ev-approval:last-of-type[data-state=allowed]");
        const got = await sent(p);
        if (got.length !== 1 || got[0].sessionId !== "s-appr" || got[0].id !== "ap-2" || got[0].answer !== "allow_once") fail(`answer sent ${JSON.stringify(got)}`);
        const after = (await card(p))[1];
        if (after?.head !== "Allowed once" || after.buttons.length) fail(`allowed card ${JSON.stringify(after)}`);
        await checkLayout(p, `approval-allowed ${label}`);
        await shoot(p, "panel-approval-allowed", size, scheme);
        reportErrors(p, `approval ${label}`);
        await p.close();
      }
      if (want("panel-approval-denied", size, scheme)) {
        const p = await openPanel(ctx, "approval", "#chat-log .ev-approval[data-state=pending]");
        // The key works while the message box has the focus.
        await p.focus("#now-text");
        await p.keyboard.press("Alt+KeyN");
        await p.waitForSelector("#chat-log .ev-approval:last-of-type[data-state=refused]");
        const got = await sent(p);
        if (got.length !== 1 || got[0].answer !== "deny") fail(`Alt+N sent ${JSON.stringify(got)}`);
        const typed = await p.inputValue("#now-text");
        if (typed) fail(`Alt+N typed into the message box: ${JSON.stringify(typed)}`);
        const after = (await card(p))[1];
        if (after?.head !== "Denied" || after.buttons.length) fail(`denied card ${JSON.stringify(after)}`);
        await checkLayout(p, `approval-denied ${label}`);
        await shoot(p, "panel-approval-denied", size, scheme);
        reportErrors(p, `approval-denied ${label}`);
        await p.close();
      }
      // Full autonomy: one short red line under the status, as long as it is on, with what it means as its tooltip;
      // Change opens Settings > Permission.
      if (want("panel-autonomy-full", size, scheme)) {
        const p = await openPanel(ctx, "idle", ".chat-empty", { edit: (d) => (d.state.settings.automationLevel = "full") });
        const w = await p.evaluate(() => {
          const el = document.getElementById("autonomy-warning");
          const r = el.getBoundingClientRect();
          return { shown: !el.hidden && r.height > 0, text: el.textContent.replace(/\s+/g, " ").trim(), title: el.title, oneLine: r.height < 40, inside: r.right <= innerWidth + 0.5 };
        });
        if (!w.shown || w.text !== "Permission: Full autonomy Change" || !/^Never asks\. The agent can post, send, pay and delete/.test(w.title) || !w.oneLine || !w.inside) fail(`autonomy warning ${JSON.stringify(w)}`);
        await checkLayout(p, `autonomy ${label}`);
        await shoot(p, "panel-autonomy-full", size, scheme);
        await p.click("#autonomy-warning-change");
        await p.waitForFunction(() => [...(window.__created ?? []), ...(window.__opened ?? [])].some((u) => u.endsWith("options.html#permission")));
        // Back to asking: the warning goes with the next state.
        await p.evaluate(() => { const st = window.__data.state; window.__push({ type: "state", state: { ...st, rev: (st.rev ?? 0) + 1, settings: { ...st.settings, automationLevel: "ask_consequential" } } }); });
        await p.waitForSelector("#autonomy-warning", { state: "hidden" });
        reportErrors(p, `autonomy ${label}`);
        await p.close();
      }
    },
  },
  // A question answered in the chat, with Markdown: the latest turn at the bottom, the older one scrolled to the top.
  {
    names: ["panel-chat-answer", "panel-chat-answer-top"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "answer", "#chat-log .ev-user");
      await checkLayout(p, `answer ${label}`);
      await p.waitForTimeout(200);
      const pos = await p.evaluate(() => {
        const l = document.getElementById("chat-log");
        return { top: l.scrollTop, h: l.scrollHeight, c: l.clientHeight, last: l.lastElementChild?.className };
      });
      if (pos.top + pos.c < pos.h - 2) fail(`answer: chat not scrolled to the bottom ${JSON.stringify(pos)}`);
      await shoot(p, "panel-chat-answer", size, scheme);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-chat-answer-top", size, scheme);
      reportErrors(p, `answer ${label}`);
      await p.close();
    },
  },
  // Streaming: the answer arrives as text deltas and grows in place (no raw ** while a bold is half written);
  // its final text replaces it without a second copy; the turn then ends with a one-line summary.
  {
    names: ["panel-chat-streaming", "panel-chat-streamed"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "streaming", "#chat-log .ev-user");
      const push = (e) => p.evaluate((ev) => window.__push({ type: "event", event: { ...ev, ts: new Date().toISOString(), sessionId: "s-ans" } }), e);
      const id = "msg_live01:1";
      const cut = EMAIL_ANSWER.indexOf("Jordan Lee") + "Jordan Le".length;
      const pieces = (from, to, n) => Array.from({ length: n }, (_, k) => EMAIL_ANSWER.slice(from + Math.floor(((to - from) * k) / n), from + Math.floor(((to - from) * (k + 1)) / n)));
      for (const t of pieces(0, cut, 8)) {
        await push({ type: "assistant_text_delta", id, text: t });
        await p.waitForTimeout(30);
      }
      await p.waitForFunction(() => document.querySelector("#chat-log .ev-text.streaming")?.textContent.includes("Jordan Le"));
      const mid = await p.evaluate(() => {
        const el = document.querySelector("#chat-log .ev-text.streaming");
        return { raw: el.textContent.includes("**"), strong: [...el.querySelectorAll("strong")].map((s) => s.textContent), heading: el.querySelector("h3")?.textContent };
      });
      if (mid.raw || !mid.strong.includes("Jordan Le") || mid.heading !== "Needs a reply") fail(`streaming: half-written Markdown ${JSON.stringify(mid)}`);
      await checkLayout(p, `streaming ${label}`);
      await shoot(p, "panel-chat-streaming", size, scheme);
      for (const t of pieces(cut, EMAIL_ANSWER.length, 6)) await push({ type: "assistant_text_delta", id, text: t });
      await p.waitForFunction(() => document.querySelector("#chat-log .ev-text.streaming")?.textContent.includes("Jordan and Sam?"));
      await push({ type: "assistant_text", text: EMAIL_ANSWER, id });
      await push({ type: "tool_call", id: "7", name: "task_complete", args: { summary: "Summarized 4 unread emails" } });
      await push({ type: "tool_result", id: "7", name: "task_complete", text: "Task marked complete." });
      await push({ type: "task_end", outcome: "done", summary: "Summarized 4 unread emails" });
      await p.waitForSelector("#chat-log .ev-end:last-child");
      const end = await p.evaluate((sid) => ({
        copies: [...document.querySelectorAll("#chat-log .ev-text")].filter((e) => e.textContent.includes("4 unread emails")).length,
        live: document.querySelectorAll("#chat-log .streaming").length,
        same: document.querySelector(`#chat-log .ev-text[data-stream="${sid}"]`)?.textContent.includes("Want me to draft replies"),
        outcome: document.querySelector("#chat-log > .ev-end:last-child .ev-outcome")?.textContent,
      }), id);
      if (end.copies !== 1 || end.live !== 0 || !end.same || end.outcome !== "doneSummarized 4 unread emails") fail(`streaming: after the final text ${JSON.stringify(end)}`);
      await checkLayout(p, `streamed ${label}`);
      await shoot(p, "panel-chat-streamed", size, scheme);
      reportErrors(p, `streaming ${label}`);
      await p.close();
    },
  },
  // The agent's follow-up suggestion: faded in the empty box exactly where typing starts, with a Tab hint; typing its
  // start keeps the rest showing; Tab takes it into the box (not sent); anything else hides it and Tab moves the focus;
  // Esc dismisses it; an empty Enter still looks at the page; sending clears it; voice hides it; TODO never shows it.
  {
    names: ["panel-suggest", "panel-suggest-typed", "panel-suggest-accepted", "panel-suggest-long"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const box = (p) =>
        p.evaluate(() => {
          const t = document.getElementById("now-text");
          const g = document.getElementById("now-ghost");
          const desc = t.getAttribute("aria-describedby");
          return {
            value: t.value,
            placeholder: t.placeholder,
            ghost: g.hidden ? null : g.querySelector(".now-ghost-rest").textContent,
            key: g.hidden ? null : g.querySelector(".now-ghost-key").textContent,
            described: desc ? document.getElementById(desc).textContent : null,
            focused: document.activeElement === t,
            caretAtEnd: t.selectionStart === t.value.length && t.selectionEnd === t.value.length,
          };
        });
      const expectBox = async (p, want, what) => {
        const got = await box(p);
        const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
        if (bad.length) fail(`suggestion ${what}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join("; ")}`);
      };
      const sent = (p) => p.evaluate(() => window.__requests.filter((r) => r.type === "run.message" || r.type === "run.adhoc"));
      const focusBox = (p) => p.evaluate(() => document.getElementById("now-text").focus());
      const voiceIs = (p, states) => p.waitForFunction((s) => s.includes(document.querySelector(".voice-mic").dataset.state), states);

      /**
       * The box drawn two ways must match pixel for pixel (caret hidden): `a` and `b` are each the text in the box
       * and CSS for that drawing. A one-pixel shift of `b` must show up, or the check would prove nothing.
       */
      const sameDrawing = async (p, what, a, b) => {
        const caret = await p.addStyleTag({ content: "#now-text { caret-color: transparent !important; }" });
        const rect = () => p.evaluate(() => JSON.parse(JSON.stringify(document.getElementById("now-text").getBoundingClientRect())));
        const draw = async ({ value, css }, dx = [0]) => {
          await p.evaluate((val) => {
            const t = document.getElementById("now-text");
            t.value = val;
            t.dispatchEvent(new Event("input"));
          }, value);
          const style = await p.addStyleTag({ content: css });
          const r = await rect();
          const shots = [];
          for (const x of dx) shots.push(await p.screenshot({ clip: { x: Math.round(r.x) + x, y: Math.round(r.y), width: Math.floor(r.width) - 2, height: Math.floor(r.height) }, animations: "disabled" }));
          await style.evaluate((n) => n.remove());
          return shots;
        };
        const [first] = await draw(a);
        const [second, shifted] = await draw(b, [0, 1]);
        await caret.evaluate((n) => n.remove());
        await p.evaluate(() => {
          const t = document.getElementById("now-text");
          t.value = "";
          t.dispatchEvent(new Event("input"));
        });
        const diff = await p.evaluate(
          async (shots) => {
            const load = (b64) =>
              new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = `data:image/png;base64,${b64}`;
              });
            const pixels = (img) => {
              const cv = document.createElement("canvas");
              cv.width = img.width;
              cv.height = img.height;
              const x = cv.getContext("2d");
              x.drawImage(img, 0, 0);
              return x.getImageData(0, 0, img.width, img.height).data;
            };
            const [u0, v0, w0] = (await Promise.all(shots.map(load))).map(pixels);
            const differ = (u, v) => {
              if (u.length !== v.length) return Infinity;
              let n = 0;
              for (let i = 0; i < u.length; i += 4) if (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) + Math.abs(u[i + 2] - v[i + 2]) > 24) n++;
              return n;
            };
            return { same: differ(u0, v0), shifted: differ(u0, w0) };
          },
          [first, second, shifted].map((x) => x.toString("base64")),
        );
        if (diff.same !== 0) fail(`suggestion ${what}: ${diff.same} pixels differ`);
        if (diff.shifted < 20) fail(`suggestion ${what}: the check cannot see a 1 px shift (${diff.shifted} pixels)`);
      };
      /** The box alone, as the user types into it. */
      const BOX_ONLY = ".now-ghost { visibility: hidden !important; }";
      /** Only the suggestion's faded rest drawn in the text colour (Tab hint hidden). */
      const REST_AS_TEXT = ".now-ghost-rest { color: var(--text) !important; } .now-ghost-key { visibility: hidden !important; }";
      /** The faded rest continues the typed text exactly where typing would: typed + rest look like the whole typed out. */
      const expectAligned = (p, full, typed, what) => sameDrawing(p, `${what}: the faded text is not where typed text goes`, { value: full, css: BOX_ONLY }, { value: typed, css: REST_AS_TEXT });
      /**
       * The overlay lays out the typed part exactly as the box does (so the rest starts right after the cursor), also
       * when a half-typed word ends a line: the box's own text vs the overlay's typed part drawn in its place.
       */
      const expectTypedAligned = (p, typed, what) =>
        sameDrawing(
          p,
          `${what}: the overlay does not lay out the typed text like the box`,
          { value: typed, css: BOX_ONLY },
          { value: typed, css: "#now-text { color: transparent !important; } .now-ghost-typed { color: var(--text) !important; } .now-ghost-rest, .now-ghost-key { visibility: hidden !important; }" },
        );

      const p = await openPanel(ctx, "suggest", "#chat-log .ev-end", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
      await p.waitForSelector("#now-ghost:not([hidden])");
      const described = `Suggestion: “${SUGGESTION}”. Press Tab to use it.`;
      await expectBox(p, { value: "", ghost: SUGGESTION, key: "Tab", placeholder: "", described }, "in the empty box");
      await expectAligned(p, SUGGESTION, "", "empty box");
      await expectAligned(p, SUGGESTION, "Reply to Jor", "typed start");
      await expectTypedAligned(p, "Reply to Jor", "typed start");
      await focusBox(p);
      await checkLayout(p, `suggest ${label}`);
      await shoot(p, "panel-suggest", size, scheme);

      // Typing its start (any case) keeps the rest showing after the typed text.
      await p.keyboard.type("reply to");
      await expectBox(p, { value: "reply to", ghost: SUGGESTION.slice("reply to".length), key: "Tab", described }, "after typing its start");
      await checkLayout(p, `suggest-typed ${label}`);
      await shoot(p, "panel-suggest-typed", size, scheme);

      // Tab completes it in the box, cursor at the end, nothing sent.
      await p.keyboard.press("Tab");
      await expectBox(p, { value: `reply to${SUGGESTION.slice(8)}`, ghost: null, focused: true, caretAtEnd: true, described: null }, "after Tab");
      if ((await sent(p)).length) fail(`suggestion: Tab sent ${JSON.stringify(await sent(p))}`);
      await checkLayout(p, `suggest-accepted ${label}`);
      await shoot(p, "panel-suggest-accepted", size, scheme);

      // Anything else hides it, and Tab then moves the focus as usual; an emptied box shows it again.
      await p.fill("#now-text", "Forward it");
      await expectBox(p, { ghost: null, placeholder: "Message BrowserTODO…", described: null }, "after other text");
      await p.keyboard.press("Tab");
      if ((await box(p)).focused) fail("suggestion: with other text typed, Tab did not move the focus");
      await p.fill("#now-text", "");
      await expectBox(p, { ghost: SUGGESTION }, "after emptying the box");

      // Hands-free voice (the mic, on Standard) hides it while it writes into the box; ending it before anything was
      // sent restores the empty box, and the suggestion.
      await p.click("#now-actions .voice-mic");
      await voiceIs(p, ["handsfree"]);
      await expectBox(p, { ghost: null }, "while voice starts");
      await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
      await expectBox(p, { ghost: null }, "with the words in the box");
      await p.click("#now-actions .voice-mic");
      await voiceIs(p, ["idle"]);
      await expectBox(p, { value: "", ghost: SUGGESTION }, "after voice ended");

      // Under TODO the box never offers it.
      await p.click("#tab-btn-todo");
      await expectBox(p, { ghost: null, described: null }, "under TODO");
      await p.click("#tab-btn-chat");
      await expectBox(p, { ghost: SUGGESTION }, "back in Chat");

      // Esc dismisses it for this turn: the placeholder is back, Tab moves the focus, an empty Enter looks at the page.
      await focusBox(p);
      await p.keyboard.press("Escape");
      await expectBox(p, { value: "", ghost: null, placeholder: "Message BrowserTODO…", described: null }, "after Esc");
      await p.keyboard.press("Tab");
      if ((await box(p)).focused) fail("suggestion: after Esc, Tab did not move the focus");
      await focusBox(p);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const afterEsc = (await sent(p)).at(-1);
      if (afterEsc?.sessionId !== "s-ans" || afterEsc?.text !== "" || afterEsc?.screen !== true) fail(`suggestion: empty Enter after Esc sent ${JSON.stringify(afterEsc)}`);
      reportErrors(p, `suggest ${label}`);
      await p.close();

      // With it showing, an empty Enter still looks at the page (the suggestion is never sent by itself); sending clears it.
      const q = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await q.waitForSelector("#now-ghost:not([hidden])");
      await focusBox(q);
      await q.keyboard.press("Enter");
      await q.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"));
      const screen = (await sent(q)).at(-1);
      if (screen?.sessionId !== "s-ans" || screen?.text !== "" || screen?.screen !== true) fail(`suggestion: empty Enter with it shown sent ${JSON.stringify(screen)}`);
      await expectBox(q, { value: "", ghost: null }, "after an empty send");
      reportErrors(q, `suggest-empty-send ${label}`);
      await q.close();

      // Tab, then Enter: the suggestion goes out as the typed message.
      const r = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await r.waitForSelector("#now-ghost:not([hidden])");
      await focusBox(r);
      await r.keyboard.press("Tab");
      await r.keyboard.press("Enter");
      await r.waitForFunction(() => window.__requests.some((m) => m.type === "run.message"));
      const took = (await sent(r)).at(-1);
      if (took?.sessionId !== "s-ans" || took?.text !== SUGGESTION || took?.screen) fail(`suggestion: Tab, Enter sent ${JSON.stringify(took)}`);
      await expectBox(r, { value: "", ghost: null }, "after sending it");
      reportErrors(r, `suggest-send ${label}`);
      await r.close();

      // The longest suggestion (MAX_SUGGESTION_CHARS) wraps like typed text would, also with a typed start across the wrap.
      const l = await openPanel(ctx, "suggest", "#chat-log .ev-end");
      await l.evaluate((text) => {
        const s = window.__data.sessions.find((x) => x.sessionId === "s-ans");
        window.__push({ type: "session", session: { ...s, endedAt: new Date(Date.now() + 1000).toISOString(), suggestion: text } });
      }, LONG_SUGGESTION);
      await l.waitForFunction((t) => document.querySelector("#now-ghost .now-ghost-rest")?.textContent === t, LONG_SUGGESTION);
      const lines = await l.evaluate(() => Math.round((document.getElementById("now-ghost").getBoundingClientRect().height - 8) / 20));
      if (lines < 2) fail(`suggestion: the longest one did not wrap (${lines} line)`);
      await expectAligned(l, LONG_SUGGESTION, "", "longest, empty box");
      await expectAligned(l, LONG_SUGGESTION, LONG_SUGGESTION.slice(0, 20), "longest, typed start");
      // A half-typed word at the end of a line stays there (as in the box); the rest goes on after it.
      for (const n of [52, 55, 58]) await expectTypedAligned(l, LONG_SUGGESTION.slice(0, n), `longest, ${n} typed`);
      await focusBox(l);
      await checkLayout(l, `suggest-long ${label}`);
      await shoot(l, "panel-suggest-long", size, scheme);
      reportErrors(l, `suggest-long ${label}`);
      await l.close();
    },
  },
  // Two tasks at once, each in its own tab: the status line counts them; Chat shows this tab's and a chip for the other tab's.
  {
    names: ["panel-parallel", "panel-parallel-newchat"],
    async run({ ctx, size, scheme, label, fail, only, firstMessage, waitFirst, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "parallel", "#chat-switch:not([hidden]) .act-chip");
      if ((await p.locator("#status-meta").textContent()) !== "· 2 running") fail(`status meta "${await p.locator("#status-meta").textContent()}"`);
      const chips = () => p.evaluate(() => [...document.querySelectorAll(".act-chip")].map((c) => c.dataset.id));
      if ((await chips()).join() !== "s-par2") fail(`switcher in tab 1 ${JSON.stringify(await chips())}`);
      if (!(await p.locator("#chat-log .ev-first .ev-user-text").textContent()).startsWith("Post the launch")) fail("tab 1 does not show its run");
      const below = await p.evaluate(() => document.querySelector(".chat-bar").getBoundingClientRect().bottom <= document.getElementById("chat-switch").getBoundingClientRect().top);
      if (!below) fail("switcher is not below the action bar");
      await checkLayout(p, `parallel ${label}`);
      await shoot(p, "panel-parallel", size, scheme);
      // The chip switches to the other run's tab, and the chat follows the tab.
      await p.click('.act-chip[data-id="s-par2"]');
      const focus = await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus"));
      if (focus?.tabId !== 2) fail(`chip sent ${JSON.stringify(focus)}`);
      await p.waitForFunction(() => document.getElementById("chat-log").textContent.includes("Opening the doc"));
      // The other run's chat: its task as the first message; its brain's start line is left to the chip.
      const other = await firstMessage(p);
      if (other?.origin !== "From your TODO list" || other.startLines !== 0 || other.head !== "Claude API · claude-sonnet-5 · Jev on") fail(`tab 2's first message ${JSON.stringify(other)}`);
      if (!(await p.locator("#chat-log .ev-first .ev-user-text").textContent()).startsWith("Post the photo")) fail("switching tabs did not change the chat");
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
      await waitFirst(p, "Post the launch");
      reportErrors(p, `parallel ${label}`);
      await p.close();
    },
  },
  // A chat per tab: tab 1 has a running chat, tab 2 has none; switching tabs switches the chat.
  {
    names: ["panel-tabs-a", "panel-tabs-b", "panel-tabs-b-started"],
    async run({ ctx, size, scheme, label, fail, expectBar, firstMessage, waitFirst, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "tabs", "#chat-log .ev-tool");
      const view = () =>
        p.evaluate(() => ({
          title: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent ?? null,
          empty: !!document.querySelector("#chat-log .chat-empty"),
          chips: [...document.querySelectorAll("#chat-switch:not([hidden]) .act-chip")].map((c) => c.dataset.id),
          placeholder: document.getElementById("now-text").placeholder,
          stop: !document.getElementById("now-stop").hidden,
        }));
      const a = await view();
      if (!a.title?.startsWith("Summarize this pull request") || a.empty || a.chips.length || !a.stop) fail(`tab A ${JSON.stringify(a)}`);
      await expectBar(p, { "chat-new": true, "chat-show": true }, "tab A");
      await checkLayout(p, `tabs-a ${label}`);
      await shoot(p, "panel-tabs-a", size, scheme);
      // The user switches to tab 2: a new chat there, with a chip for tab 1's running chat.
      await p.evaluate(() => window.__activateTab(2));
      await p.waitForSelector("#chat-log .chat-empty");
      const b = await view();
      if (b.title !== null || b.chips.join() !== "s-live" || b.stop || b.placeholder !== "Figure out what to do based on the current screen") fail(`tab B ${JSON.stringify(b)}`);
      await expectBar(p, { "chat-new": false, "chat-show": false }, "tab B");
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
      // A fresh chat: the prompt as typed is its first message, with the time under it.
      await waitFirst(p, "Translate");
      const fresh = await firstMessage(p);
      if (!fresh.first || fresh.text !== "Translate this page's intro to French" || fresh.origin !== null || !/^\d\d:\d\d$/.test(fresh.when ?? "") || fresh.header) fail(`fresh chat's first message ${JSON.stringify(fresh)}`);
      await checkLayout(p, `tabs-b-started ${label}`);
      await shoot(p, "panel-tabs-b-started", size, scheme);
      // Back to tab 1: its chat is still there.
      await p.evaluate(() => window.__activateTab(1));
      await waitFirst(p, "Summarize this pull request");
      reportErrors(p, `tabs ${label}`);
      await p.close();
    },
  },
  // Signed out: the TODO tab is one big centered Log In button (and one line), no list, no composer.
  {
    names: ["panel-todo-login", "panel-todo-login-noclient"],
    async run({ ctx, size, scheme, label, fail, want, only, openPanel, shoot, checkLayout, reportErrors }) {
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
            acct: (() => { const d = document.getElementById("acct"); const shown = (sel) => getComputedStyle(d.querySelector(sel)).display !== "none"; return !d.hidden && !d.hasAttribute("data-signed-in") && shown(".acct-anon") && shown("#acct-login") && shown("#acct-open-settings") && !shown("#acct-signout") && !shown(".acct-who"); })(),
          };
        });
        if (cta.text !== "Log in") fail(`login button says "${cta.text}"`);
        if (cta.w < 200 || cta.h < 46 || cta.font < 16) fail(`Log In is not big: ${JSON.stringify(cta)}`);
        if (cta.dx > 2 || cta.dy > cta.tabH * 0.12) fail(`Log In is not centered: ${JSON.stringify(cta)}`);
        if (cta.shown.join() !== "todo-login") fail(`signed-out TODO shows more than Log In: ${cta.shown.join(", ")}`);
        if (!cta.composer) fail("composer shown under Log In");
        if (!cta.acct) fail("signed-out account menu should show the person icon with Log in and Settings only");
        await checkLayout(p, `${kind} ${label}`);
        if (kind === "loggedout-noclient") {
          await p.click("#login-btn");
          await p.waitForFunction(() => document.getElementById("login-msg").textContent.includes("Google sign-in isn't available"));
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
    },
  },
  // Signed in: the account's list, the offer to move this browser's tasks, the avatar menu, BrowserTODO AI in the chip.
  {
    names: ["panel-todo-account", "panel-account-menu", "panel-model-menu-hosted"],
    async run({ ctx, size, scheme, label, fail, want, only, openPanel, shoot, checkLayout, reportErrors }) {
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
      if ((await p.locator("#status-text").textContent()) !== "BrowserTODO AI + Jev") fail(`status "${await p.locator("#status-text").textContent()}"`);
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
          return { left: r.left, right: r.right, email: document.querySelector("#acct .acct-email").textContent, plan: document.querySelector("#acct .acct-plan").textContent };
        });
        if (pop.left < 0 || pop.right > size.w) fail(`account menu off screen ${JSON.stringify(pop)}`);
        if (pop.email !== "ada.lovelace@example.com" || pop.plan !== "Plus plan · $14.21 usage credit") fail(`account menu ${JSON.stringify(pop)}`);
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
          reasoning: document.querySelector(".mm-reasoning")?.getAttribute("aria-checked"),
          reasoningHint: document.querySelector(".mm-reasoning .mm-hint")?.textContent,
        }));
        if (menu.head !== "BrowserTODO AI model" || menu.credit !== "$14.21 usage credit left" || menu.models !== 4 || menu.jev || menu.reasoning !== "false" || menu.reasoningHint !== "Off: thinks only when stuck")
          fail(`hosted model menu ${JSON.stringify(menu)}`);
        await checkLayout(q, `model-menu-hosted ${label}`);
        await shoot(q, "panel-model-menu-hosted", size, scheme);
        reportErrors(q, `model-menu-hosted ${label}`);
        await q.close();
      }
      reportErrors(p, `account ${label}`);
      await p.close();
    },
  },
  // Signed in on Free: the TODO list is a paid feature. One calm, centred Get a plan (and how many saved
  // tasks wait in the account), no list, no composer; Chat still works; subscribing brings the list back.
  {
    names: ["panel-todo-locked", "panel-todo-locked-empty"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      for (const name of ["panel-todo-locked", "panel-todo-locked-empty"]) {
        if (!want(name, size, scheme)) continue;
        const kind = name.replace("panel-", "");
        const p = await openPanel(ctx, kind, ".chat-empty");
        await p.click("#tab-btn-todo");
        await p.waitForSelector('#tab-todo[data-auth="locked"] #todo-plan-btn');
        const cta = await p.evaluate(() => {
          const btn = document.getElementById("todo-plan-btn");
          const b = btn.getBoundingClientRect();
          const tab = document.getElementById("tab-todo").getBoundingClientRect();
          const box = document.getElementById("todo-locked");
          return {
            w: b.width, h: b.height, font: parseFloat(getComputedStyle(btn).fontSize),
            dx: Math.abs((b.left + b.right) / 2 - (tab.left + tab.right) / 2),
            tabH: tab.height, boxDy: Math.abs((box.getBoundingClientRect().top + box.getBoundingClientRect().bottom) / 2 - (tab.top + tab.bottom) / 2),
            shown: [...document.querySelectorAll("#tab-todo > *")].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.id || e.className),
            text: [...box.querySelectorAll("p, button")].filter((e) => !e.hidden).map((e) => e.textContent),
            composer: document.getElementById("composer").hidden,
          };
        });
        const kept = name === "panel-todo-locked" ? ["You have 7 saved tasks; they come back when you subscribe."] : [];
        const want_ = ["TODO needs a paid plan", "Tasks are stored in your account and run on schedule.", "Get a plan", ...kept];
        if (JSON.stringify(cta.text) !== JSON.stringify(want_)) fail(`locked TODO says ${JSON.stringify(cta.text)}`);
        if (cta.w < 200 || cta.h < 46 || cta.font < 16) fail(`Get a plan is not big: ${JSON.stringify(cta)}`);
        if (cta.dx > 2 || cta.boxDy > cta.tabH * 0.12) fail(`the locked state is not centred: ${JSON.stringify(cta)}`);
        if (cta.shown.join() !== "todo-locked") fail(`locked TODO shows more than Get a plan: ${cta.shown.join(", ")}`);
        if (!cta.composer) fail("composer shown under Get a plan");
        await checkLayout(p, `${kind} ${label}`);
        await shoot(p, name, size, scheme);
        // The account menu says what Free lacks.
        const plan = await p.evaluate(() => document.querySelector("#acct .acct-plan").textContent);
        if (plan !== "Free plan, no TODO list · $0.00 usage credit") fail(`account menu plan "${plan}"`);
        // Get a plan: the dashboard's Billing page, in a new tab; back in the panel, the account is refreshed.
        await p.click("#todo-plan-btn");
        await p.waitForFunction(() => window.__created.includes("https://app.browsertodo.com/billing"));
        const forced = () => p.evaluate(() => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length);
        const before = await forced();
        await p.evaluate(() => {
          dispatchEvent(new Event("blur"));
          dispatchEvent(new Event("focus"));
        });
        await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length === n + 1, before);
        // One-off chats stay free: Chat keeps its composer.
        await p.click("#tab-btn-chat");
        if (!(await p.locator("#composer").isVisible())) fail("composer hidden on Chat on Free");
        if (name === "panel-todo-locked") {
          // Subscribing (the plan arrives with the next state): the same tasks come back, unlocked.
          await p.click("#tab-btn-todo");
          await p.evaluate(() => {
            window.__data.tasksLocked = false;
            const s = window.__data.state;
            window.__push({ type: "state", state: { ...s, account: { ...s.account, plan: { id: "plus", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false } } } });
          });
          await p.waitForSelector('#tab-todo[data-auth="in"] .task');
          if (!(await p.locator("#composer").isVisible())) fail("composer not back after subscribing");
        }
        reportErrors(p, `${kind} ${label}`);
        await p.close();
      }
    },
  },
  // Out of usage credit: the status line says so with Top up; the paused run's card has Top up too. Every one opens the dashboard's Billing page.
  {
    names: ["panel-out-of-credit"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "hosted-out", "#chat-log .ev-end");
      const st = await p.evaluate(() => ({ text: document.getElementById("status-text").textContent, action: document.getElementById("status-action").textContent, chip: document.getElementById("now-model-label").textContent }));
      if (st.text !== "You're out of usage credit" || st.action !== "Top up" || st.chip !== "Out of usage credit") fail(`out of credit status ${JSON.stringify(st)}`);
      if ((await p.locator("#chat-log [data-fix=topup]").textContent()) !== "Top up") fail("no Top up in the paused run's error card");
      // Shown once: the end card keeps its outcome and Continue, not a second copy of the reason.
      const once = await p.evaluate(() => ({ cards: document.querySelectorAll("#chat-log .ev-error").length, summary: document.querySelector("#chat-log .ev-end .ev-summary")?.textContent ?? null }));
      if (once.cards !== 1 || once.summary !== null) fail(`out of credit shown more than once ${JSON.stringify(once)}`);
      await checkLayout(p, `out-of-credit ${label}`);
      await shoot(p, "panel-out-of-credit", size, scheme);
      await p.click("#chat-log [data-fix=topup]");
      await p.click("#status-action");
      // Plan & billing in the account menu.
      await p.click("#acct-btn");
      await p.click("#acct-billing");
      // The model menu's Top up...
      await p.click("#now-model");
      await p.locator("#model-menu .mm-item", { hasText: "Top up" }).click();
      const opened = await p.evaluate(() => ({ created: window.__created, opened: window.__opened }));
      const billing = "https://app.browsertodo.com/billing";
      if (JSON.stringify(opened.created) !== JSON.stringify([billing, billing, billing, billing]) || opened.opened.length) fail(`Top up / Plan & billing opened ${JSON.stringify(opened)}`);
      reportErrors(p, `out-of-credit ${label}`);
      await p.close();
    },
  },
  // Failed turns: one error card each (plain line, a second line, the fix, Details), never repeated by the end card.
  {
    names: ["panel-error-hosted", "panel-error-helper", "panel-error-ratelimit", "panel-error-unknown"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const expected = {
        "err-hosted": { msg: "BrowserTODO AI is unavailable right now.", fixes: ["Use your own Claude"], retry: "Retry" },
        "err-helper": { msg: "Local Claude Code isn't connected.", fixes: ["Set up Claude Code", "Use BrowserTODO AI"], retry: "Retry" },
        "err-ratelimit": { msg: "Too many requests right now.", fixes: [], retry: "Retry" },
        "err-unknown": { msg: "Something went wrong.", fixes: [], retry: "Retry" },
      };
      for (const [kind, want1] of Object.entries(expected)) {
        const name = `panel-error-${kind.slice(4)}`;
        if (!want(name, size, scheme)) continue;
        const p = await openPanel(ctx, kind, "#chat-log .ev-end");
        const got = await p.evaluate(() => {
          const log = document.getElementById("chat-log");
          const cards = [...log.querySelectorAll(".ev-error")];
          return {
            cards: cards.length,
            msg: cards[0]?.querySelector(".err-msg")?.textContent,
            fixes: [...log.querySelectorAll(".err-fix")].map((b) => b.textContent),
            retry: log.querySelector(".ev-continue")?.textContent,
            summary: log.querySelector(".ev-end .ev-summary")?.textContent ?? null,
            text: log.textContent,
          };
        });
        if (got.cards !== 1) fail(`${kind}: ${got.cards} error cards`);
        if (got.msg !== want1.msg) fail(`${kind}: message "${got.msg}"`);
        if (got.fixes.join(" | ") !== want1.fixes.join(" | ")) fail(`${kind}: fixes ${got.fixes.join(" | ")}`);
        if (got.retry !== want1.retry) fail(`${kind}: continue button "${got.retry}"`);
        if (got.summary !== null) fail(`${kind}: the end card repeats the error: "${got.summary}"`);
        if (/HTTP \d|invalid_request_error|rate_limit_error/.test(got.text.replace(/Details[\s\S]*$/, ""))) fail(`${kind}: technical text outside Details`);
        if (kind === "err-unknown") {
          // Details opens on demand, with the technical text to copy.
          await p.click("#chat-log .err-details > summary");
          const tech = await p.textContent("#chat-log .err-tech pre");
          if (!/prompt is too long/.test(tech)) fail(`${kind}: details "${tech}"`);
        }
        if (kind === "err-hosted") {
          await p.click("#chat-log [data-fix=own-claude]");
          const opened = await p.evaluate(() => window.__created.at(-1) ?? window.__opened.at(-1) ?? null);
          if (!/options\.html#ai$/.test(String(opened))) fail(`${kind}: Use your own Claude opened ${opened}`);
        }
        await checkLayout(p, `${kind} ${label}`);
        await shoot(p, name, size, scheme);
        reportErrors(p, `${kind} ${label}`);
        await p.close();
      }
    },
  },
  // The composer: Auto will not move a Claude Code chat to paid BrowserTODO AI; the refusal says so with both ways out.
  {
    names: ["panel-error-auto-switch"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "err-helper", "#chat-log .ev-end");
      await p.evaluate(() => (window.__refuse = { "run.message": "Local Claude Code is not available, and Auto does not move this chat to BrowserTODO AI on its own" }));
      await p.fill("#now-text", "and reply to the first comment");
      await p.click("#now-submit");
      await p.waitForSelector("#now-notice .ev-error");
      const got = await p.evaluate(() => ({
        msg: document.querySelector("#now-notice .err-msg")?.textContent,
        hint: document.querySelector("#now-notice .err-hint")?.textContent,
        fixes: [...document.querySelectorAll("#now-notice .err-fix")].map((b) => b.textContent),
        box: document.getElementById("now-text").value,
      }));
      if (got.msg !== "Local Claude Code isn't connected." || got.fixes.join(" | ") !== "Set up Claude Code | Use BrowserTODO AI") fail(`auto switch refusal ${JSON.stringify(got)}`);
      if (got.box !== "and reply to the first comment") fail("the refused message did not go back into the box");
      await checkLayout(p, `auto-switch ${label}`);
      await shoot(p, "panel-error-auto-switch", size, scheme);
      await p.click("#now-notice [data-fix=use-hosted]");
      const saved = await p.evaluate(() => window.__requests.find((r) => r.type === "settings.save")?.settings);
      if (saved?.brain !== "browsertodo") fail(`Use BrowserTODO AI saved ${JSON.stringify(saved)}`);
      reportErrors(p, `auto-switch ${label}`);
      await p.close();
    },
  },
  // Warning states.
  {
    names: ["panel-nobrain-todo", "panel-model-menu-nojev"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
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
    },
  },
  {
    names: ["panel-paused-history"],
    async run({ ctx, size, scheme, label, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "paused", ".chat-empty");
      await p.click("#tab-btn-history");
      await p.waitForSelector(".sessions li");
      await checkLayout(p, `paused ${label}`);
      await shoot(p, "panel-paused-history", size, scheme);
      reportErrors(p, `paused ${label}`);
      await p.close();
    },
  },
  // Stopped by the user after typing the post: the next message continues that conversation.
  {
    names: ["panel-continue", "panel-continue-note", "panel-continue-newtask", "panel-continue-task-menu", "panel-continue-past-chat"],
    async run({ ctx, size, scheme, label, fail, want, only, openPanel, shoot, checkLayout, reportErrors }) {
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
      const CHAT = { placeholder: "Message BrowserTODO…", submit: "Send", newChat: true, attach: true };
      const NEW = { placeholder: "Figure out what to do based on the current screen", submit: "Send", newChat: false, attach: true };
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

      // A past stopped run from History opens straight in Chat, with Continue, and the composer talks to it.
      if (want("panel-continue-past-chat", size, scheme)) {
        await p.click("#tab-btn-history");
        await p.waitForSelector(".sessions li");
        await p.locator(".sessions li button", { hasText: "cheapest flight" }).click();
        await p.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-continue");
        if (!(await p.locator("#chat-log .ev-first .ev-user-text").textContent()).includes("cheapest flight")) fail("the History tab row did not show the run in Chat");
        await expectMode(CHAT, "not talking to a past stopped run opened from History");
        if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text") fail("opening from History did not focus the box");
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
    },
  },
  // Voice: the mic left of Send (locked on Free) starts hands-free voice on the engine picked in Settings, as the
  // voice shortcut does, and ends it; the microphone permission asked in a tab.
  {
    names: ["panel-voice-locked", "panel-voice-idle", "panel-voice-mic-standard", "panel-voice-mic-realtime", "panel-voice-permission"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors, base }) {
      // The microphone is allowed (a grant for the origin replaces earlier ones, e.g. the clipboard's above).
      await ctx.grantPermissions(["microphone"], { origin: base });
      const mic = "#now-actions .voice-mic";
      const voiceState = (p) => p.getAttribute(mic, "data-state");
      /** Waits for the mic's state; on timeout says what the panel shows instead. */
      const waitVoice = (p, state) =>
        p.waitForFunction((st) => document.querySelector(".voice-mic").dataset.state === st, state).catch(async (err) => {
          const seen = await p.evaluate(() => ({ state: document.querySelector(".voice-mic").dataset.state, tip: document.querySelector("#now-notice").textContent }));
          throw new Error(`waiting for voice "${state}": ${JSON.stringify(seen)} (${err.message.split("\n")[0]})`);
        });
      const waitPill = (p, phase) =>
        p.waitForFunction((w) => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === w, phase, { timeout: 15_000 });
      const orbCheck = (p) =>
        p.evaluate(() => {
          const orb = document.querySelector(".voice-orb");
          const comp = document.getElementById("composer").getBoundingClientRect();
          const r = orb.querySelector(".voice-orb-stack").getBoundingClientRect();
          const box = document.getElementById("now-text").getBoundingClientRect();
          const out = [];
          if (orb.hidden) out.push("orb hidden");
          if (r.bottom > comp.top) out.push(`orb reaches the input (${Math.round(r.bottom)} > ${Math.round(comp.top)})`);
          if (Math.abs(r.left + r.width / 2 - window.innerWidth / 2) > 1) out.push("orb not centred");
          if (getComputedStyle(orb).pointerEvents !== "none") out.push("orb takes clicks");
          // The input stays above the veil.
          if (document.elementFromPoint(box.left + 10, box.top + box.height / 2)?.id !== "now-text") out.push("the veil covers the input");
          return out;
        });
      const listeningReported = (p) => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1)?.listening);

      // Free plan: a lock; the tooltip and a click explain, "Choose a plan" opens the dashboard's Billing page.
      {
        const p = await openPanel(ctx, "free", ".chat-empty");
        if ((await voiceState(p)) !== "locked") fail(`free plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== "Voice needs the Plus or Pro plan") fail(`locked tooltip "${await p.getAttribute(mic, "title")}"`);
        await p.click(mic);
        await p.waitForSelector("#now-notice:not([hidden])");
        const tipText = await p.textContent("#now-notice");
        if (!/Voice needs the Plus or Pro plan/.test(tipText) || !/Choose a plan/.test(tipText)) fail(`locked tip "${tipText}"`);
        if (await p.evaluate(() => !document.querySelector("#voice-bar").hidden)) fail("the locked mic started hands-free");
        await checkLayout(p, `voice-locked ${label}`);
        await shoot(p, "panel-voice-locked", size, scheme);
        await p.click("#now-notice .notice-action");
        await p.waitForFunction(() => window.__created.includes("https://app.browsertodo.com/billing"));
        // The voice shortcut while locked points at the mic and says why, with Choose a plan.
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        const locked = await p.evaluate(() => ({ nudge: document.querySelector(".voice-mic").classList.contains("nudge"), tip: document.querySelector("#now-notice:not([hidden])")?.textContent ?? "" }));
        if (!locked.nudge || !/Voice needs/.test(locked.tip) || !/Choose a plan/.test(locked.tip)) fail(`locked voice shortcut ${JSON.stringify(locked)}`);
        reportErrors(p, `voice-locked ${label}`);
        await p.close();
      }

      // Paid plan: the mic is ready, its tooltip names the voice shortcut (both do the same).
      if (want("panel-voice-idle", size, scheme)) {
        const p = await openPanel(ctx, "account", ".chat-empty");
        if ((await voiceState(p)) !== "idle") fail(`paid plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== `Voice · ${VOICE_SHORTCUT_LABEL}`) fail(`mic tooltip "${await p.getAttribute(mic, "title")}"`);
        await checkLayout(p, `voice-idle ${label}`);
        await shoot(p, "panel-voice-idle", size, scheme);
        reportErrors(p, `voice-idle ${label}`);
        await p.close();
      }

      // Standard picked in Settings: the mic starts hands-free on Standard (the orb, the words streaming into the box),
      // never the old one-shot dictation; pressed again it ends the session and the box is as it was.
      if (want("panel-voice-mic-standard", size, scheme)) {
        const p = await openPanel(ctx, "account", ".chat-empty", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        await p.click(mic);
        await waitPill(p, "listening");
        await waitVoice(p, "handsfree");
        if ((await p.getAttribute(mic, "title")) !== `End voice · ${VOICE_SHORTCUT_LABEL}`) fail(`mic tooltip while on "${await p.getAttribute(mic, "title")}"`);
        if ((await listeningReported(p)) !== true) fail("the mic's hands-free not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime"))) fail("Standard asked for the realtime relay");
        const problems = await orbCheck(p);
        if (problems.length) fail(`hands-free orb: ${problems.join("; ")}`);
        if ((await p.textContent(".voice-caption")) !== "Hands-free: say what to do · “stop” to end") fail(`orb caption "${await p.textContent(".voice-caption")}"`);
        await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
        if (!(await p.evaluate(() => document.activeElement === document.getElementById("now-text")))) fail("the box lost the cursor");
        await checkLayout(p, `voice-mic-standard ${label}`);
        await shoot(p, "panel-voice-mic-standard", size, scheme);
        await p.click(mic);
        await waitVoice(p, "idle");
        if (await p.evaluate(() => !document.querySelector("#voice-bar").hidden)) fail("the mic did not end hands-free");
        if (!(await p.evaluate(() => document.querySelector(".voice-orb").hidden))) fail("orb still shown after stopping");
        if ((await listeningReported(p)) !== false) fail("the end not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "run.message" || r.type === "run.adhoc"))) fail("ending hands-free sent the words");
        if ((await p.inputValue("#now-text")) !== "") fail(`the box kept "${await p.inputValue("#now-text")}"`);
        reportErrors(p, `voice-mic-standard ${label}`);
        await p.close();
      }

      // Realtime (the default): the mic opens the narrator's session through the relay; pressed again it closes it.
      if (want("panel-voice-mic-realtime", size, scheme)) {
        const p = await openPanel(ctx, "account", ".chat-empty", { init: [installVoiceFakes] });
        await p.click(mic);
        await waitPill(p, "listening");
        await waitVoice(p, "handsfree");
        const rt = await p.evaluate(() => ({ first: window.__rt?.sent[0]?.type, transcription: window.__rt?.sent[0]?.session?.audio?.input?.transcription }));
        if (rt.first !== "session.update" || rt.transcription?.model !== "gpt-transcribe") fail(`the mic's Realtime session ${JSON.stringify(rt)}`);
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime")))) fail("the mic did not ask for the realtime relay");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.transcribe"))) fail("Realtime used Standard's transcription");
        await checkLayout(p, `voice-mic-realtime ${label}`);
        await shoot(p, "panel-voice-mic-realtime", size, scheme);
        await p.click(mic);
        await waitVoice(p, "idle");
        await p.waitForFunction(() => window.__rt.closedWith === 1000);
        if ((await p.inputValue("#now-text")) !== "") fail(`Realtime wrote "${await p.inputValue("#now-text")}" into the box`);
        reportErrors(p, `voice-mic-realtime ${label}`);
        await p.close();
      }

      // No microphone permission yet: the mic opens the permission page and says so.
      if (want("panel-voice-permission", size, scheme)) {
        const p = await ctx.newPage();
        const errors = [];
        p.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
        await p.addInitScript(() => {
          const query = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (d) =>
            d.name === "microphone" ? Promise.resolve({ state: "prompt", addEventListener() {}, removeEventListener() {} }) : query(d);
        });
        await p.addInitScript(installChromeStub, scenario("account"));
        await p.goto(`${base}/sidepanel.html`);
        await p.waitForSelector(".chat-empty", { state: "attached" });
        p.errors = errors;
        await p.click(mic);
        await p.waitForSelector("#now-notice:not([hidden])");
        if (!(await p.evaluate(() => window.__created.some((u) => u.endsWith("/mic-permission.html"))))) fail("the permission page did not open");
        if (!/Allow the microphone/.test(await p.textContent("#now-notice"))) fail(`permission tip "${await p.textContent("#now-notice")}"`);
        await waitVoice(p, "idle");
        await checkLayout(p, `voice-permission ${label}`);
        await shoot(p, "panel-voice-permission", size, scheme);
        reportErrors(p, `voice-permission ${label}`);
        await p.close();
      }
    },
  },
  // The voice strip (voice-bar.ts) while the fake microphone hears a voice: one line, "Voice on" and "Hearing you", the
  // time on, a small meter, no buttons; the controls in the composer row (the mic, filled in the live colour, ends voice;
  // Mute next to it); the box glowing with "Listening… just talk"; the background told the tab (its toolbar badge) and,
  // when the mic ends it by keyboard, that it ended (the badge goes). With reduced motion nothing pulses.
  {
    names: ["panel-voicebar-hearing", "panel-voicebar-reduced"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base, want }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      for (const reduced of [false, true]) {
        const name = reduced ? "panel-voicebar-reduced" : "panel-voicebar-hearing";
        if (!want(name, size, scheme)) continue;
        const p = await openPanel(ctx, "account", ".chat-empty", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        if (reduced) await p.emulateMedia({ reducedMotion: "reduce" });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p
          .waitForFunction(() => document.getElementById("voice-bar").dataset.state === "hearing", null, { timeout: 15_000 })
          .catch(async () => fail(`${name}: never "hearing" (${await p.evaluate(() => document.getElementById("voice-bar").dataset.state)})`));
        const look = await p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const mic = document.querySelector("#now-actions .voice-mic");
          const mute = document.querySelector("#now-actions .voice-mute");
          const anim = (el, pseudo) => getComputedStyle(el, pseudo).animationName;
          return {
            label: bar.querySelector(".vb-label").textContent,
            status: bar.querySelector(".vb-status").textContent,
            time: bar.querySelector(".vb-time").textContent,
            hint: bar.title,
            live: bar.querySelector("[aria-live=polite]").textContent,
            region: [bar.getAttribute("role"), bar.getAttribute("aria-label")],
            buttons: [...bar.querySelectorAll("button")].filter((b) => b.offsetParent).length,
            height: bar.getBoundingClientRect().height,
            meter: !bar.querySelector(".vb-meter").hidden,
            placeholder: document.getElementById("now-text").placeholder,
            glow: document.body.classList.contains("voice-live") && getComputedStyle(document.querySelector(".now")).boxShadow !== "none",
            micTitle: mic.title,
            micPressed: mic.getAttribute("aria-pressed"),
            micFill: getComputedStyle(mic).backgroundColor,
            mute: mute && !mute.hidden ? [mute.getAttribute("aria-pressed"), mute.getAttribute("aria-label")] : null,
            anims: [anim(bar.querySelector(".vb-dot")), anim(mic, "::before"), anim(document.querySelector(".now"))],
            reported: window.__portSent.filter((m) => m.type === "panel.listening").at(-1),
          };
        });
        const want2 = (ok, what) => ok || fail(`${name} ${label}: ${what} ${JSON.stringify(look)}`);
        want2(look.label === "Voice on" && look.status === "Hearing you" && look.live === "Voice on: Listening", "state word / announcement");
        want2(/^0:0\d$/.test(look.time), "time on");
        want2(look.hint === "Standard voice · Just talk · say “stop” to end", "tooltip");
        want2(look.region[0] === "region" && look.region[1] === "Voice status", "strip region");
        want2(look.buttons === 0 && look.height <= 30, "a slim strip without buttons");
        want2(look.meter, "meter");
        want2(look.placeholder === "Listening… just talk" && look.glow, "listening box");
        want2(look.micTitle === `End voice · ${VOICE_SHORTCUT_LABEL}` && look.micPressed === "true", "mic ends voice");
        want2(look.micFill !== "rgba(0, 0, 0, 0)", "mic filled");
        want2(JSON.stringify(look.mute) === JSON.stringify(["false", "Mute the microphone · Alt+M"]), "Mute in the composer");
        want2(look.reported?.listening === true && look.reported?.tabId === 1, "listening reported with the tab (badge)");
        const still = look.anims.every((a) => a === "none");
        want2(reduced ? still : look.anims.join() === "vb-breathe,vb-mic-ring,vb-glow", reduced ? "something pulses with reduced motion" : "no pulse");
        await checkLayout(p, `${name} ${label}`);
        await shoot(p, name, size, scheme);
        // The mic by keyboard ends it: the background hears it (the badge goes), the box is as before.
        await p.focus("#now-actions .voice-mic");
        await p.keyboard.press("Enter");
        await p.waitForFunction(() => document.getElementById("voice-bar").hidden, null, { timeout: 5000 }).catch(() => fail(`${name} ${label}: Enter on the mic did not end it`));
        const after = await p.evaluate(() => ({
          reported: window.__portSent.filter((m) => m.type === "panel.listening").at(-1),
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
          mute: !document.querySelector("#now-actions .voice-mute").hidden,
          placeholder: document.getElementById("now-text").placeholder,
          glow: document.body.classList.contains("voice-live"),
        }));
        if (after.reported?.listening !== false || after.reported?.tabId !== undefined || after.mic !== "idle" || after.mute || after.placeholder === "Listening… just talk" || after.glow)
          fail(`${name} ${label}: after the mic ended it ${JSON.stringify(after)}`);
        reportErrors(p, `${name} ${label}`);
        await p.close();
      }
    },
  },
  // Hands-free voice (the voice shortcut): the orb and the status strip while listening, "Sending…" with the utterance
  // in the box (Standard), the strip while the agent works (the task's Stop and the voice controls apart in the
  // composer row), a spoken line with Interrupt in the composer; Realtime's one-time cost notice, the narrator
  // speaking, its send_to_agent starting a task with one acknowledgement, and one message per request: what the
  // narrator understood, with the user's words for it folded under it ("Word for word"); what was said but led to no
  // request is not shown; Realtime unavailable says so and offers Standard (it never switches by itself); a dropped
  // connection shows "Reconnecting…"; on another tab, the note goes with the message as its context.
  {
    names: [
      "panel-handsfree-listening",
      "panel-handsfree-sending",
      "panel-handsfree-speaking",
      "panel-handsfree-working",
      "panel-handsfree-cost",
      "panel-handsfree-narrator",
      "panel-handsfree-heard",
      "panel-handsfree-unavailable",
      "panel-handsfree-reconnecting",
      "panel-handsfree-elsewhere",
      "panel-handsfree-elsewhere-heard",
    ],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base, want }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const phase = (p) => p.evaluate(() => (document.querySelector("#voice-bar:not([hidden])") ? document.querySelector("#voice-bar").dataset.phase : "off"));
      /** Waits for the hands-free phase; on timeout says what the panel shows instead. */
      const waitPhase = (p, wanted, timeout = 20_000) =>
        p.waitForFunction((w) => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === w, wanted, { timeout }).catch(async (err) => {
          const seen = await p.evaluate(() => ({
            phase: document.querySelector("#voice-bar")?.dataset.phase,
            hidden: document.querySelector("#voice-bar")?.hidden,
            bar: document.querySelector("#voice-bar .vb-status")?.textContent,
            tip: document.querySelector("#now-notice:not([hidden])")?.textContent,
          }));
          throw new Error(`waiting for hands-free "${wanted}": ${JSON.stringify(seen)} (${err.message.split("\n")[0]})`);
        });
      const barTitle = (p) => p.textContent("#voice-bar .vb-status");
      /** The state word, allowing for the fake microphone's voice ("Hearing you" while listening or working). */
      const barSays = async (p, ...words) => words.includes(await barTitle(p));
      /**
       * The strip: full width right under the tabs, above the orb's veil, one slim line, its words not cut, no buttons
       * (on its own tab); a polite live line saying the state. The composer row: every voice control and the task's
       * Stop in view, none overlapping, none cut, each with a name.
       */
      const barCheck = (p) =>
        p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const r = bar.getBoundingClientRect();
          const top = document.querySelector("header.top").getBoundingClientRect();
          const out = [];
          if (bar.hidden) out.push("bar hidden");
          if (Math.abs(r.top - top.bottom) > 1) out.push(`bar not right under the tabs (${Math.round(r.top)} vs ${Math.round(top.bottom)})`);
          if (r.left !== 0 || Math.abs(r.width - window.innerWidth) > 1) out.push("bar not full width");
          if (r.height > 30) out.push(`bar not one slim line (${Math.round(r.height)})`);
          if ([...bar.querySelectorAll("button")].some((b) => b.offsetParent)) out.push("buttons in the strip");
          const text = bar.querySelector(".vb-text");
          if (text.scrollWidth > text.clientWidth + 1) out.push("the strip's words are cut");
          if (!bar.querySelector("[aria-live=polite]")?.textContent) out.push("no live line");
          const row = document.querySelector(".now-bar").getBoundingClientRect();
          const tools = [...document.querySelectorAll(".now-bar button, .now-bar [role=button]")].filter((b) => b.offsetParent);
          const boxes = tools.map((b) => [b, b.getBoundingClientRect()]);
          for (const [b, x] of boxes) {
            const name = b.id || b.className;
            if (x.left < row.left - 5 || x.right > row.right + 0.5) out.push(`${name} cut`);
            if (!(b.getAttribute("aria-label") || b.textContent.trim())) out.push(`${name} has no name`);
          }
          for (let i = 1; i < boxes.length; i++) if (boxes[i][1].left < boxes[i - 1][1].right - 0.5) out.push(`${boxes[i][0].className} overlaps ${boxes[i - 1][0].className}`);
          return out;
        });
      /** The background's state with `session` running in tab 1 (pushed as the runner would). */
      const pushRunning = (p, session) =>
        p.evaluate((s) => {
          const st = window.__data.state;
          window.__push({ type: "state", state: { ...st, running: s, runningSessions: [s], tabChats: { 1: s.sessionId }, runningTabs: { [s.sessionId]: [1] } } });
        }, session);
      const newSession = (title) => ({ sessionId: "s-new", source: "adhoc", title, instructions: title, brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: new Date().toISOString() });
      const spokenLast = (p) => p.evaluate(() => window.__spoken.at(-1));

      // Standard: listening -> sending -> the task starts -> a line is said -> working -> the result is said -> stopped.
      if (["listening", "sending", "speaking", "working"].some((n) => want(`panel-handsfree-${n}`, size, scheme))) {
        const p = await openPanel(ctx, "account", ".chat-empty", { edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        await p.evaluate(() => (window.__ttsHold = true));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        if (!(await barSays(p, "Listening", "Hearing you"))) fail(`listening bar "${await barTitle(p)}"`);
        if (!(await p.evaluate(() => !document.querySelector(".voice-orb").hidden))) fail("no orb while hands-free listens");
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "handsfree") fail("the mic does not show hands-free");
        if (!(await p.evaluate(() => window.__portSent.some((m) => m.type === "panel.listening" && m.listening === true)))) fail("hands-free not reported to the background");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.realtime"))) fail("Standard asked for the realtime relay");
        await checkLayout(p, `handsfree-listening ${label}`);
        const pl = await barCheck(p);
        if (pl.length) fail(`listening bar: ${pl.join("; ")}`);
        await shoot(p, "panel-handsfree-listening", size, scheme);

        // The fake microphone talks, then pauses: the utterance waits in "Sending…" with its words in the box.
        await waitPhase(p, "sending", 25_000);
        if ((await barTitle(p)) !== "Sending") fail(`sending bar "${await barTitle(p)}"`);
        if (!/^Open Gmail/.test(await p.inputValue("#now-text"))) fail(`sending: box "${await p.inputValue("#now-text")}"`);
        await shoot(p, "panel-handsfree-sending", size, scheme);
        // It goes to the chat of the tab the session started in (none yet: a new one there), marked as spoken.
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 5000 });
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        if (!/^Open Gmail/.test(req.text) || req.voice !== true || req.tabId !== 1 || req.sessionId !== undefined) fail(`hands-free sent ${JSON.stringify(req)}`);
        const sent = req.text;
        await p.waitForSelector("#chat-log .ev-first.voice .ev-voice", { state: "attached" });

        // The task runs: its short plan is said (playing in the chat), then the bar says it works.
        await pushRunning(p, newSession(sent));
        await p.evaluate(() =>
          window.__push({ type: "event", event: { type: "assistant_text", text: "I'll open Gmail and read your newest email. Starting now.", ts: new Date().toISOString(), sessionId: "s-new" } }),
        );
        await waitPhase(p, "speaking");
        if ((await spokenLast(p)) !== "I'll open Gmail and read your newest email.") fail(`said "${await spokenLast(p)}"`);
        const playing = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-spoken.playing .ev-spoken-text")].map((e) => e.textContent));
        if (playing.join(" | ") !== "I'll open Gmail and read your newest email.") fail(`playing in the chat: ${JSON.stringify(playing)}`);
        if (await p.evaluate(() => document.querySelector(".hf-caption, .voice-tip"))) fail("a floating caption or tip is still drawn");
        if ((await barTitle(p)) !== "Speaking") fail(`speaking bar "${await barTitle(p)}"`);
        if (await p.evaluate(() => document.querySelector("#now-actions .voice-interrupt").hidden)) fail("no Interrupt in the composer while speaking");
        const sl = await barCheck(p);
        if (sl.length) fail(`speaking: ${sl.join("; ")}`);
        if (!(await p.evaluate(() => document.querySelector(".voice-orb").hidden))) fail("the orb still covers the chat after sending");
        await checkLayout(p, `handsfree-speaking ${label}`);
        await shoot(p, "panel-handsfree-speaking", size, scheme);
        await p.evaluate(() => window.__ttsRelease());
        await waitPhase(p, "working");
        if (!(await barSays(p, "Agent working", "Hearing you"))) fail(`working bar "${await barTitle(p)}"`);
        // The task's Stop and the mic that ends voice: two different buttons, named apart.
        const stops = await p.evaluate(() => ({
          task: [!document.getElementById("now-stop").hidden, document.getElementById("now-stop").title, !!document.querySelector("#now-stop svg")],
          voice: document.querySelector("#now-actions .voice-mic").title,
          interrupt: !document.querySelector("#now-actions .voice-interrupt").hidden,
        }));
        if (JSON.stringify(stops.task) !== JSON.stringify([true, "Stop the task", true]) || !/^End voice/.test(stops.voice) || stops.interrupt) fail(`the two stops ${JSON.stringify(stops)}`);
        // Said: the line is kept in its chat (compact: the agent's text above starts with it), no longer playing.
        await p.waitForFunction(() => document.querySelector("#chat-log .ev-spoken:not(.live)"));
        const kept = await p.evaluate(() => ({
          asked: window.__requests.filter((r) => r.type === "voice.spoken").map((r) => [r.sessionId, r.text]),
          shown: [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.className, e.textContent]),
        }));
        if (JSON.stringify(kept.asked) !== JSON.stringify([["s-new", "I'll open Gmail and read your newest email."]]) || kept.shown.length !== 1 || !/echo/.test(kept.shown[0][0]) || /playing|live/.test(kept.shown[0][0]))
          fail(`kept spoken line ${JSON.stringify(kept)}`);
        await p.evaluate(() => {
          const ev = (e) => window.__push({ type: "event", event: { ...e, ts: new Date().toISOString(), sessionId: "s-new" } });
          ev({ type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/0/#inbox" } });
          ev({ type: "tool_result", id: "1", name: "navigate", text: "Opened https://mail.google.com/mail/u/0/#inbox (title: Inbox)" });
        });
        await waitPhase(p, "speaking");
        if ((await spokenLast(p)) !== "Opening mail.google.com") fail(`milestone "${await spokenLast(p)}"`);
        await p.evaluate(() => window.__ttsRelease());
        await waitPhase(p, "working");
        const wl = await barCheck(p);
        if (wl.length) fail(`working bar: ${wl.join("; ")}`);
        await checkLayout(p, `handsfree-working ${label}`);
        await shoot(p, "panel-handsfree-working", size, scheme);

        // The result is said in the agent's own spoken words, not the long answer.
        await p.evaluate(() => (window.__ttsHold = false));
        await p.evaluate(() => {
          const at = new Date().toISOString();
          window.__push({ type: "event", event: { type: "assistant_text", text: "You have **1 new email** from Sarah: dinner moved to 8.", ts: at, sessionId: "s-new" } });
          window.__push({ type: "event", event: { type: "task_end", outcome: "done", summary: "Read the newest email", spoken: "Sarah says dinner moved to eight.", ts: at, sessionId: "s-new" } });
        });
        await p.waitForFunction(() => window.__spoken.at(-1) === "Sarah says dinner moved to eight.");
        // The result is kept as a full spoken line; the milestone, which repeats a tool row, is not kept.
        await p.waitForFunction(() => [...document.querySelectorAll("#chat-log .ev-spoken:not(.live) .ev-spoken-text")].some((e) => e.textContent === "Sarah says dinner moved to eight."));
        const lines = await p.evaluate(() => [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.classList.contains("echo"), e.textContent]));
        if (JSON.stringify(lines) !== JSON.stringify([[true, "I'll open Gmail and read your newest email."], [false, "Sarah says dinner moved to eight."]])) fail(`spoken lines in the chat ${JSON.stringify(lines)}`);
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.spoken" && /^Opening/.test(r.text)))) fail("a milestone was kept in the chat");
        if (await p.evaluate(() => window.__spoken.some((l) => /\*\*/.test(l)))) fail("a Markdown answer was read out");

        // The shortcut again ends it: the strip goes, the background hears the mic is off.
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1)?.listening)) !== false) fail("hands-free end not reported to the background");
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("the mic still shows hands-free");
        reportErrors(p, `handsfree ${label}`);
        await p.close();
      }

      // Realtime: the cost notice the first time, the narrator talking (caption), and its send_to_agent starting a task.
      if (["cost", "narrator", "heard", "elsewhere-heard"].some((n) => want(`panel-handsfree-${n}`, size, scheme))) {
        const p = await openPanel(ctx, "account", ".chat-empty", { edit: (d) => (d.state.settings.realtimeCostNoticed = false), init: [installVoiceFakes] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        await p.waitForSelector("#now-notice:not([hidden])");
        const tip = await p.textContent("#now-notice:not([hidden])");
        if (!/^Realtime voice uses about 6¢ of usage credit a minute\. Standard costs much less\.Voice settings×$/.test(tip)) fail(`cost notice "${tip}"`);
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && r.settings.realtimeCostNoticed === true)))) fail("the cost notice is not remembered");
        const rt = await p.evaluate(() => ({ protocols: window.__rt.protocols, sent: window.__rt.sent.map((e) => e.type), first: window.__rt.sent[0] }));
        if (JSON.stringify(rt.protocols) !== JSON.stringify(["browsertodo", "bt.tok"])) fail(`subprotocols ${JSON.stringify(rt.protocols)}`);
        if (rt.first?.type !== "session.update" || rt.first.session.model !== undefined) fail(`first event ${JSON.stringify(rt.first)?.slice(0, 120)}; sent ${rt.sent.slice(0, 5)}`);
        if (!(await p.evaluate(() => !document.querySelector("#voice-bar").hidden))) fail("the cost notice took the bar's place");
        await checkLayout(p, `handsfree-cost ${label}`);
        await shoot(p, "panel-handsfree-cost", size, scheme);
        await p.click("#now-notice:not([hidden]) .notice-close");

        // The narrator says hello: its words under the orb while its audio plays.
        await p.evaluate(() => {
          const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 1.5)));
          window.__rt.emit({ type: "response.created", response: { id: "r1" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hi! What should I do?" });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a1", response_id: "r1", delta: pcm });
        });
        await waitPhase(p, "speaking");
        if ((await p.textContent(".voice-caption")) !== "Hi! What should I do?") fail(`narrator caption "${await p.textContent(".voice-caption")}"`);
        await shoot(p, "panel-handsfree-narrator", size, scheme);

        /**
         * A turn of the user's (input item `id`): its words, then the narrator's reply, which says `reply` aloud (it
         * answered) or nothing (the words are part of what comes next).
         */
        const turn = (id, words, reply) =>
          p.evaluate(
            ([id, words, reply]) => {
              window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: id });
              window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
              window.__rt.emit({ type: "input_audio_buffer.committed", item_id: id, previous_item_id: null });
              window.__rt.emit({ type: "response.created", response: { id: `r_${id}` } });
              window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: words });
              if (reply) {
                window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: `a_${id}`, delta: reply });
                window.__rt.emit({ type: "response.output_audio.delta", item_id: `a_${id}`, response_id: `r_${id}`, delta: btoa(String.fromCharCode(...new Uint8Array(4800))) });
              }
              window.__rt.emit({ type: "response.done", response: { id: `r_${id}`, status: "completed", output: [] } });
            },
            [id, words, reply ?? null],
          );
        // Thinking aloud before asking (input item in0, a silent reply): there is no chat yet, and nothing goes out.
        await p.evaluate(() => window.__rt.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } }));
        const early = "Hmm, one sec, let me think.";
        await turn("in0", early, null);
        await p.waitForTimeout(50);
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "voice.heard" || r.type === "run.message"))) fail("words went out before any request");

        // The user asks (input item in1): their words, then the narrator calls send_to_agent before saying anything, and
        // the request goes out at once as a new task with every part of their speech since (word for word): no sending
        // window, nothing written into the box.
        const heardText = "Could you check what Sarah wrote me?";
        await p.evaluate((t) => {
          window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: "in1" });
          window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in1" });
          window.__rt.emit({ type: "input_audio_buffer.committed", item_id: "in1", previous_item_id: null });
          window.__rt.emit({ type: "response.created", response: { id: "r2" } });
          window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "in1", content_index: 0, transcript: t });
          window.__rt.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: JSON.stringify({ text: "Open Gmail and read my newest email" }) });
        }, heardText);
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 500 }).catch(() => fail("send_to_agent was not sent at once"));
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        if (req.text !== "Open Gmail and read my newest email" || req.voice !== true || req.tabId !== 1 || JSON.stringify(req.heard) !== JSON.stringify([early, heardText]))
          fail(`send_to_agent sent ${JSON.stringify(req)}`);
        if ((await phase(p)) === "sending") fail("a Realtime request waited in a sending window");
        const sent = req.text;
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.item?.type === "function_call_output"));
        const output = await p.evaluate(() => window.__rt.sent.find((e) => e.item?.type === "function_call_output")?.item.output);
        if (output !== "Sent to the agent. Its updates will follow.") fail(`tool output "${output}"`);
        // One short acknowledgement once that reply is done (it said nothing), and no other reply.
        const replies = () => p.evaluate(() => window.__rt.sent.filter((e) => e.type === "response.create"));
        if ((await replies()).length) fail("a reply was asked for while the narrator's reply was still being made");
        await p.evaluate(() => window.__rt.emit({ type: "response.done", response: { id: "r2", status: "completed", output: [] } }));
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "response.create"));
        const ack = await replies();
        if (ack.length !== 1 || !/one very short acknowledgement/.test(ack[0].response?.instructions ?? "")) fail(`acknowledgement ${JSON.stringify(ack)}`);
        await p.evaluate(() => {
          const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 0.5)));
          window.__rt.emit({ type: "response.created", response: { id: "r3" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a3", delta: "On it." });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a3", response_id: "r3", delta: pcm });
          window.__rt.emit({ type: "response.done", response: { id: "r3", status: "completed", output: [] } });
        });
        if ((await p.inputValue("#now-text")) !== "") fail(`Realtime wrote "${await p.inputValue("#now-text")}" into the box`);

        // The chat: one message, the request as understood; the words folded under it ("Word for word"), both parts.
        await pushRunning(p, { ...newSession(sent), voice: true, heard: [early, heardText] });
        await p.waitForFunction((t) => document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent === t, sent, { timeout: 5000 }).catch(() => undefined);
        await p.click("#chat-log .ev-opening .ev-words > summary").catch(() => fail("no Word for word under the first message"));
        const bubble = await p.evaluate(() => ({
          first: document.querySelector("#chat-log .ev-first .ev-user-text")?.textContent,
          voice: !!document.querySelector("#chat-log .ev-first .ev-voice"),
          words: document.querySelector("#chat-log .ev-opening .ev-words-text")?.textContent,
          open: document.querySelector("#chat-log .ev-opening .ev-words")?.open,
          users: document.querySelectorAll("#chat-log .ev-user").length,
          heardLines: document.querySelectorAll("#chat-log .ev-heard").length,
        }));
        if (bubble.first !== sent || !bubble.voice || bubble.words !== `${early} · ${heardText}` || !bubble.open || bubble.users !== 1 || bubble.heardLines) fail(`the request in the chat ${JSON.stringify(bubble)}`);
        await checkLayout(p, `handsfree-heard ${label}`);
        await shoot(p, "panel-handsfree-heard", size, scheme);
        if ((await replies()).length !== 1) fail(`more than one reply for the turn: ${JSON.stringify(await replies())}`);

        // Small talk while the agent works, answered aloud (short, capped) and passed on to no one: kept for the record
        // (voice.heard), never shown in the chat, no message.
        await turn("in2", "Okay, thanks.", "Sure! I'm here whenever you need me, just tell me what else to do.");
        // While the agent works, that long reply is never heard: it is made again, capped, and that one is said.
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "response.create" && e.response?.max_output_tokens === 80), null, { timeout: 5000 }).catch(() => fail("small talk while working was not made short"));
        await p.evaluate(() => {
          window.__rt.emit({ type: "response.created", response: { id: "r_short" } });
          window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a_short", delta: "Sure." });
          window.__rt.emit({ type: "response.output_audio.delta", item_id: "a_short", response_id: "r_short", delta: btoa(String.fromCharCode(...new Uint8Array(4800))) });
          window.__rt.emit({ type: "response.done", response: { id: "r_short", status: "completed", output: [] } });
        });
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "voice.heard"), null, { timeout: 5000 }).catch(() => fail("words that led to no request were not kept"));
        const aside = await p.evaluate(() => ({
          kept: window.__requests.filter((r) => r.type === "voice.heard").map((r) => [r.sessionId, r.text]),
          users: document.querySelectorAll("#chat-log .ev-user").length,
          heardLines: document.querySelectorAll("#chat-log .ev-heard").length,
          sent: window.__requests.filter((r) => r.type === "run.message").length,
        }));
        if (JSON.stringify(aside.kept) !== JSON.stringify([["s-new", "Okay, thanks."]]) || aside.users !== 1 || aside.heardLines || aside.sent !== 1) fail(`small talk ${JSON.stringify(aside)}`);

        // The user looks at another tab and asks (the report on 81df820): the request goes out with the note naming
        // both tabs as its context; the chat shows their words once with the request under them, never the note, and
        // never the request as a bubble of its own.
        // (This panel is a page of its own: it shows the active tab, as the user switching to tab 2.)
        await p.evaluate(() => window.__activateTab(2));
        await p.waitForSelector("#voice-bar[data-state=elsewhere]", { timeout: 5000 }).catch(() => fail("the bar does not say the user looks at another tab"));
        const away = { words: "So, yeah, forget that for now, and look at the invoices from Acme instead.", request: "Forget that. Find the invoices from Acme." };
        await p.evaluate((a) => {
          window.__rt.emit({ type: "input_audio_buffer.speech_started", item_id: "in4" });
          window.__rt.emit({ type: "input_audio_buffer.speech_stopped", item_id: "in4" });
          window.__rt.emit({ type: "input_audio_buffer.committed", item_id: "in4", previous_item_id: null });
          window.__rt.emit({ type: "response.created", response: { id: "r_in4" } });
          window.__rt.emit({ type: "response.function_call_arguments.done", call_id: "c4", name: "send_to_agent", arguments: JSON.stringify({ text: a.request }) });
          window.__rt.emit({ type: "response.done", response: { id: "r_in4", status: "completed", output: [] } });
          // The words after the call (it waits for them).
          window.__rt.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "in4", content_index: 0, transcript: a.words });
        }, away);
        await p.waitForFunction(() => window.__requests.filter((r) => r.type === "run.message").length === 2, null, { timeout: 5000 }).catch(() => undefined);
        const awayReq = await p.evaluate(() => window.__requests.filter((r) => r.type === "run.message")[1]);
        if (awayReq?.text !== away.request || awayReq.sessionId !== "s-new" || JSON.stringify(awayReq.heard) !== JSON.stringify([away.words]) || !/^The user is looking at another tab: .+\. You work in .+\.$/.test(awayReq.context ?? ""))
          fail(`asked on another tab, sent ${JSON.stringify(awayReq)}`);
        // Back on the session's tab. The background keeps the message as it was sent (user_message) with its words: one
        // bubble, the request, its words folded under it; never the note, never two bubbles.
        await p.evaluate(() => window.__activateTab(1));
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "elsewhere" && !!document.querySelector("#chat-log .ev-first"), null, { timeout: 5000 }).catch(() => undefined);
        await p.evaluate((r) => window.__push({ type: "event", event: { type: "user_message", text: r.text, voice: true, heard: r.heard, ts: new Date().toISOString(), sessionId: "s-new" } }), awayReq);
        await p.waitForFunction((t) => [...document.querySelectorAll("#chat-log .ev-said .ev-user-text")].some((e) => e.textContent === t), away.request, { timeout: 5000 }).catch(() => undefined);
        const awayChat = await p.evaluate(() => ({
          bubbles: [...document.querySelectorAll("#chat-log .ev-user")].map((e) => e.textContent),
          words: [...document.querySelectorAll("#chat-log .ev-said .ev-words-text")].map((e) => e.textContent),
        }));
        const awayBubbles = awayChat.bubbles.filter((t) => t !== sent);
        if (JSON.stringify(awayBubbles) !== JSON.stringify([away.request]) || JSON.stringify(awayChat.words) !== JSON.stringify([away.words]) || awayChat.bubbles.some((t) => t.includes("looking at another tab")))
          fail(`asked on another tab, the chat shows ${JSON.stringify(awayChat)}`);
        const acks = (await replies()).filter((r) => /acknowledgement/.test(r.response?.instructions ?? ""));
        if (acks.length !== 2) fail(`not one acknowledgement for the request asked on another tab: ${JSON.stringify(acks)}`);
        await checkLayout(p, `handsfree-elsewhere-heard ${label}`);
        await shoot(p, "panel-handsfree-elsewhere-heard", size, scheme);

        // The chat's events reach the narrator as notes; the result asks it to reply.
        await p.evaluate(() =>
          window.__push({ type: "event", event: { type: "task_end", outcome: "done", summary: "Read the newest email", spoken: "Sarah says dinner moved to eight.", ts: new Date().toISOString(), sessionId: "s-new" } }),
        );
        await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "conversation.item.create" && /Sarah says dinner moved to eight/.test(e.item?.content?.[0]?.text ?? "")));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => window.__rt.closedWith === 1000);
        reportErrors(p, `handsfree-realtime ${label}`);
        await p.close();
      }

      // Tab 1's own side panel (as Chrome opens it: sidepanel.html?tab=1). The session belongs to tab 1; the background
      // says which tab the user looks at (voice.session): on another tab the bar says where it listens (Go to tab, Use
      // voice here), and what is said there goes to tab 1's chat with a note naming both tabs; closing its tab ends it.
      // Then another tab's session seen from this panel: the notice, nothing live; Use voice here waits for it to end.
      if (want("panel-handsfree-elsewhere", size, scheme)) {
        const p = await openPanel(ctx, "voice-chat", "#chat-log .ev-end", { search: "?tab=1", edit: (d) => (d.state.settings.voiceEngine = "standard"), init: [installVoiceFakes] });
        // As in Chrome, tab 1's panel is on screen only while the user looks at tab 1.
        await p.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window.__hidden ? "hidden" : "visible") }));
        const session = (s) =>
          p.evaluate(
            (v) => {
              window.__hidden = !!v && v.viewing !== 1;
              window.__push({ type: "voice.session", session: v });
              document.dispatchEvent(new Event("visibilitychange"));
            },
            s === null ? null : { tabId: 1, windowId: 1, host: 1, engine: "standard", viewing: 1, ...s },
          );
        const lastListening = () => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.listening").at(-1));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        const reported = await lastListening();
        if (reported.listening !== true || reported.tabId !== 1 || reported.engine !== "standard") fail(`session reported ${JSON.stringify(reported)}`);
        await session({ viewing: 1 });
        // A tab its chat lives in is the session's own: the plain bar there. Here the chat moved to the tab its
        // task works in (as a run started from an extension page does), and the user looks at that tab.
        const home = await p.evaluate(() => window.__data.state);
        await p.evaluate(() => {
          const st = window.__data.state;
          window.__push({ type: "state", state: { ...st, tabChats: { 3: "s-voice" }, runningTabs: { "s-voice": [3] } } });
        });
        await session({ viewing: 3 });
        await p.waitForTimeout(100);
        if (await p.evaluate(() => document.getElementById("voice-bar").dataset.state === "elsewhere")) fail("the tab the chat moved to counts as another tab");
        await p.evaluate((st) => window.__push({ type: "state", state: st }), home);
        // The user switches to tab 2 (this panel would be hidden there): it knows.
        await session({ viewing: 2 });
        await p.waitForFunction(() => document.querySelector("#voice-bar[data-state=elsewhere] .vb-label")?.textContent.startsWith("Voice is on in Inbox (1)"));
        const away = await p.evaluate(() => ({
          label: document.querySelector("#voice-bar .vb-label").textContent,
          off: !!document.querySelector("#voice-bar .vb-off").offsetParent,
          mute: !document.querySelector("#now-actions .voice-mute").hidden,
          go: !!document.querySelector("#voice-bar .vb-go").offsetParent,
          use: !!document.querySelector("#voice-bar .vb-use").offsetParent,
          orb: !document.querySelector(".voice-orb").hidden,
          live: document.body.classList.contains("voice-live"),
        }));
        if (away.label !== "Voice is on in Inbox (1) - ada.lovelace@ex…" || !away.go || !away.use || away.off || !away.mute || away.orb || away.live) fail(`bar on another tab ${JSON.stringify(away)}`);
        await checkLayout(p, `handsfree-elsewhere ${label}`);
        await shoot(p, "panel-handsfree-elsewhere", size, scheme);
        // Said while tab 2 is in front: it goes to tab 1's chat as said, with the note naming both tabs as its context
        // (the agent gets it; the chat shows the words alone).
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message"), null, { timeout: 30_000 });
        const req = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message"));
        const note = "The user is looking at another tab: Hacker News. You work in Inbox (1) - ada.lovelace@example.com - Gmail.";
        if (req.sessionId !== "s-voice" || req.tabId !== undefined || req.voice !== true || !/^Open Gmail/.test(req.text) || req.text.includes("looking at another tab") || req.context !== note)
          fail(`said on another tab, sent ${JSON.stringify(req)}`);
        if ((await p.inputValue("#now-text")) !== "") fail(`the box got "${await p.inputValue("#now-text")}" while the user looked at another tab`);
        // Go to tab asks for the session's tab; back there, the plain bar.
        await p.click("#voice-bar .vb-go");
        if (!(await p.evaluate(() => window.__requests.some((r) => r.type === "tab.focus" && r.tabId === 1)))) fail("Go to tab did not ask for tab 1");
        await session({ viewing: 1 });
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "elsewhere");
        // Use voice here (on another tab) moves the session there, and says so.
        await session({ viewing: 2 });
        await p.waitForSelector("#voice-bar[data-state=elsewhere]");
        await p.click("#voice-bar .vb-use");
        await p.waitForFunction(() => !document.querySelector("#voice-bar").hidden && document.getElementById("voice-bar").dataset.state !== "elsewhere");
        if ((await p.textContent("#now-notice .notice-text")) !== "Hands-free moved to this tab.") fail(`moved note "${await p.textContent("#now-notice")}"`);
        if ((await lastListening()).tabId !== 2) fail(`the move is not reported ${JSON.stringify(await lastListening())}`);
        await session({ tabId: 2, viewing: 2 });
        await checkLayout(p, `handsfree-moved ${label}`);
        // Closing another tab changes nothing; closing its tab ends it, with a note.
        await p.evaluate(() => window.__closeTab(1));
        if (await p.evaluate(() => document.querySelector("#voice-bar").hidden)) fail("closing another tab ended hands-free");
        await p.evaluate(() => window.__closeTab(2));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.textContent("#now-notice .notice-text")) !== "Hands-free stopped: its tab was closed.") fail(`tab closed note "${await p.textContent("#now-notice")}"`);
        if ((await lastListening()).listening !== false) fail("the end is not reported to the background");
        await session(null);
        // The voice key while the user looks at another tab ends it (it never moves it).
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        await session({ viewing: 4 });
        await p.waitForSelector("#voice-bar[data-state=elsewhere]");
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("the voice key on another tab did not end hands-free");
        await session(null);

        // Another tab's session (tab 5's panel runs it): this panel shows where, with nothing live.
        await session({ tabId: 5, host: 5, viewing: 1 });
        await p.waitForFunction(() => document.querySelector("#voice-bar[data-state=elsewhere] .vb-label")?.textContent === "Voice is on in Tab 5");
        const remote = await p.evaluate(() => ({
          detail: document.getElementById("voice-bar").title,
          meter: !!document.querySelector("#voice-bar .vb-meter").offsetParent,
          go: !!document.querySelector("#voice-bar .vb-go").offsetParent,
          use: !!document.querySelector("#voice-bar .vb-use").offsetParent,
          stop: !!document.querySelector("#voice-bar .vb-off").offsetParent,
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
          live: document.body.classList.contains("voice-live"),
          placeholder: document.getElementById("now-text").placeholder,
        }));
        if (remote.detail !== "Standard voice · Not listening in this tab" || remote.meter || !remote.go || !remote.use || !remote.stop || remote.mic !== "idle" || remote.live || /Listening/i.test(remote.placeholder))
          fail(`another tab's session ${JSON.stringify(remote)}`);
        await checkLayout(p, `handsfree-remote ${label}`);
        await shoot(p, "panel-handsfree-remote", size, scheme);
        const voiceStops = () => p.evaluate(() => window.__portSent.filter((m) => m.type === "panel.voiceStop").length);
        await p.click("#voice-bar .vb-off");
        if ((await voiceStops()) !== 1) fail("Turn off did not ask the background to end it");
        // Use voice here: ends it there, and starts here only once it ended.
        await p.click("#voice-bar .vb-use");
        if ((await voiceStops()) !== 2) fail("Use voice here did not ask the background to end it");
        await p.waitForTimeout(200);
        if ((await p.getAttribute("#now-actions .voice-mic", "data-state")) !== "idle") fail("Use voice here started before the other session ended");
        await session(null);
        await waitPhase(p, "listening");
        const moved = await lastListening();
        // In the tab this panel shows (not tab 5), on the engine it ran on there.
        if (moved.listening !== true || typeof moved.tabId !== "number" || moved.tabId === 5 || moved.engine !== "standard") fail(`Use voice here reported ${JSON.stringify(moved)}`);
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-elsewhere ${label}`);
        await p.close();
      }

      // Realtime unavailable on the server: nothing starts (never Standard by itself); the notice says why and offers
      // Standard for this once.
      if (want("panel-handsfree-unavailable", size, scheme)) {
        const p = await openPanel(ctx, "account", ".chat-empty", { init: [installVoiceFakes, () => (window.__rtMode = "unavailable")] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForSelector("#now-notice:not([hidden])");
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden, null, { timeout: 5000 }).catch(() => fail("voice went on without Realtime"));
        const note = await p.evaluate(() => ({
          text: document.querySelector("#now-notice .notice-text")?.textContent,
          level: document.getElementById("now-notice").dataset.level,
          actions: [...document.querySelectorAll("#now-notice .notice-action")].map((b) => b.textContent),
          transcribed: window.__requests.some((r) => r.type === "voice.transcribe"),
          saved: window.__requests.some((r) => r.type === "settings.save" && "voiceEngine" in r.settings),
        }));
        if (note.text !== "Realtime voice is unavailable on the server right now." || note.level !== "error" || JSON.stringify(note.actions) !== JSON.stringify(["Use Standard voice"]) || note.transcribed || note.saved)
          fail(`unavailable note ${JSON.stringify(note)}`);
        await checkLayout(p, `handsfree-unavailable ${label}`);
        await shoot(p, "panel-handsfree-unavailable", size, scheme);
        // The user's choice: Standard, this once (Settings unchanged).
        await p.click("#now-notice .notice-action");
        await waitPhase(p, "listening");
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "settings.save" && "voiceEngine" in r.settings))) fail("Use Standard voice changed Settings");
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-unavailable ${label}`);
        await p.close();
      }

      // The Realtime connection drops mid-session: the strip says "Reconnecting…" while a new one is made, taking the
      // place of the old one on the server (takeover); the chat and the session go on.
      if (want("panel-handsfree-reconnecting", size, scheme)) {
        const p = await openPanel(ctx, "account", ".chat-empty", { init: [installVoiceFakes] });
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitPhase(p, "listening");
        // The next connection opens but is not ready yet (so the strip can be seen), then the relay drops this one.
        await p.evaluate(() => {
          window.__rtMode = "hold";
          window.__rt.drop(1011);
        });
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "reconnecting", null, { timeout: 5000 }).catch(() => fail("no Reconnecting… in the strip"));
        const rc = await p.evaluate(() => ({
          status: document.querySelector("#voice-bar .vb-status").textContent,
          url: window.__rt.url,
          notice: document.querySelector("#now-notice:not([hidden])")?.textContent ?? null,
          mic: document.querySelector("#now-actions .voice-mic").dataset.state,
        }));
        if (rc.status !== "Reconnecting…" || !/[?&]takeover=1/.test(rc.url) || rc.notice || rc.mic !== "handsfree") fail(`reconnecting ${JSON.stringify(rc)}`);
        const rl = await barCheck(p);
        if (rl.length) fail(`reconnecting: ${rl.join("; ")}`);
        await checkLayout(p, `handsfree-reconnecting ${label}`);
        await shoot(p, "panel-handsfree-reconnecting", size, scheme);
        // Ready: the session goes on.
        await p.evaluate(() => window.__rt.emit({ type: "session.created", event_id: "ev2", session: { type: "realtime", model: "gpt-realtime-2.1" } }));
        await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state !== "reconnecting", null, { timeout: 5000 }).catch(() => fail("still reconnecting once ready"));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
        reportErrors(p, `handsfree-reconnecting ${label}`);
        await p.close();
      }
    },
  },
  // Hands-free muted (the composer's Mute, Alt+M): the strip in grey with "Muted", no meter; Mute pressed; the box
  // without the glow and "Listening…"; the mic still, in grey; the background told (the MUTE badge). Realtime stops
  // streaming the microphone (no input_audio_buffer.append: no input audio billed) and clears the server's buffer; the
  // narrator is told, and still speaks (Interrupt, Mute, the mic and Send in one row, narrow too). While the agent works
  // the hint says updates are still said. Alt+M unmutes: the stream starts again.
  {
    names: ["panel-handsfree-muted", "panel-handsfree-muted-speaking", "panel-handsfree-muted-working"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base }) {
      await ctx.grantPermissions(["microphone"], { origin: base });
      const p = await openPanel(ctx, "account", ".chat-empty", { init: [installVoiceFakes] });
      const appends = () => p.evaluate(() => window.__rt?.sent.filter((e) => e.type === "input_audio_buffer.append").length ?? 0);
      await p.evaluate(() => window.__push({ type: "panel.voice" }));
      await p.waitForFunction(() => document.querySelector("#voice-bar:not([hidden])")?.dataset.phase === "listening", null, { timeout: 20_000 });
      // The fake microphone streams to the narrator.
      await p.waitForFunction(() => window.__rt.sent.some((e) => e.type === "input_audio_buffer.append"), null, { timeout: 10_000 });
      await p.click("#now-actions .voice-mute");
      const look = () =>
        p.evaluate(() => {
          const bar = document.getElementById("voice-bar");
          const mute = document.querySelector("#now-actions .voice-mute");
          const mic = document.querySelector("#now-actions .voice-mic");
          const row = document.querySelector(".now-bar").getBoundingClientRect();
          const out = [];
          const shown = [...document.querySelectorAll(".now-bar button")].filter((b) => b.offsetParent).map((b) => [b.className, b.getBoundingClientRect()]);
          for (const [name, x] of shown) if (x.left < row.left - 5 || x.right > row.right + 0.5) out.push(`${name} cut`);
          for (let i = 1; i < shown.length; i++) if (shown[i][1].left < shown[i - 1][1].right - 0.5) out.push(`${shown[i][0]} overlaps ${shown[i - 1][0]}`);
          if (bar.getBoundingClientRect().height > 30) out.push(`strip not one line (${Math.round(bar.getBoundingClientRect().height)})`);
          return {
            state: bar.dataset.state,
            muted: bar.dataset.muted ?? null,
            title: bar.querySelector(".vb-status").textContent,
            detail: bar.title,
            meter: !bar.querySelector(".vb-meter").hidden,
            pressed: mute.getAttribute("aria-pressed"),
            label: mute.getAttribute("aria-label"),
            tooltip: mute.title,
            live: bar.querySelector("[aria-live=polite]").textContent,
            barBg: getComputedStyle(bar).backgroundColor,
            ring: getComputedStyle(bar.querySelector(".vb-dot")).animationName,
            placeholder: document.getElementById("now-text").placeholder,
            glow: document.body.classList.contains("voice-live"),
            micMuted: mic.dataset.muted ?? null,
            micRing: getComputedStyle(mic, "::before").animationName,
            orb: document.querySelector(".voice-orb").hidden ? null : { muted: document.querySelector(".voice-orb").dataset.muted ?? null, caption: document.querySelector(".voice-caption").textContent, halo: getComputedStyle(document.querySelector(".voice-orb-halo")).animationName },
            reported: window.__portSent.filter((x) => x.type === "panel.listening").at(-1),
            layout: out,
          };
        });
      const want = (ok, what, seen) => ok || fail(`muted ${label}: ${what} ${JSON.stringify(seen)}`);
      const muted = await look();
      want(muted.state === "muted" && muted.muted === "true" && muted.title === "Muted" && muted.live === "Voice on: Muted", "state", muted);
      want(muted.detail === "Realtime voice · Microphone off · Unmute to talk", "tooltip", muted);
      want(!muted.meter && muted.ring === "none", "meter or ring", muted);
      want(muted.pressed === "true" && muted.label === "Unmute the microphone · Alt+M" && muted.tooltip === muted.label, "Mute button", muted);
      want(!/200, 35, 63|196, 42, 68/.test(muted.barBg), "the bar is still red", muted);
      want(/muted/i.test(muted.placeholder) && !muted.glow, "box", muted);
      want(muted.micMuted === "true" && muted.micRing === "none", "mic button", muted);
      want(muted.orb?.muted === "true" && muted.orb.caption === "Microphone muted · Unmute to talk" && muted.orb.halo === "none", "orb", muted);
      want(muted.reported?.listening === true && muted.reported?.muted === true, "reported (badge)", muted);
      want(!muted.layout.length, "layout", muted);
      // Nothing more goes out, the server's buffer was cleared, and the narrator knows.
      const sentAtMute = await p.evaluate(() => window.__rt.sent.map((e) => e.type));
      const clearAt = sentAtMute.lastIndexOf("input_audio_buffer.clear");
      want(clearAt > sentAtMute.lastIndexOf("input_audio_buffer.append"), "buffer not cleared after the last audio", sentAtMute.slice(-5));
      const before = await appends();
      await p.waitForTimeout(1200);
      want((await appends()) === before, "audio streamed while muted", { before, after: await appends() });
      want(await p.evaluate(() => window.__rt.sent.some((e) => e.type === "conversation.item.create" && /muted their microphone/.test(e.item?.content?.[0]?.text ?? ""))), "narrator not told", null);
      await checkLayout(p, `handsfree-muted ${label}`);
      await shoot(p, "panel-handsfree-muted", size, scheme);

      // The narrator still speaks: Speaking, with Interrupt, Mute (still pressed), the mic and Send in one row.
      await p.evaluate(() => {
        // 3 s of audio, in two deltas (one big spread would overflow the call stack).
        const pcm = btoa(String.fromCharCode(...new Uint8Array(24_000 * 2 * 1.5)));
        window.__rt.emit({ type: "response.created", response: { id: "r1" } });
        window.__rt.emit({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Still here. Tell me when you're ready." });
        for (let i = 0; i < 2; i++) window.__rt.emit({ type: "response.output_audio.delta", item_id: "a1", response_id: "r1", delta: pcm });
      });
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "speaking", null, { timeout: 5000 });
      const speaking = await look();
      want(speaking.muted === "true" && speaking.pressed === "true" && /Esc or Interrupt stops it · microphone muted$/.test(speaking.detail), "speaking while muted", speaking);
      want(await p.evaluate(() => !document.querySelector("#now-actions .voice-interrupt").hidden), "no Interrupt in the composer", speaking);
      want(!speaking.layout.length, "speaking layout", speaking);
      await checkLayout(p, `handsfree-muted-speaking ${label}`);
      await shoot(p, "panel-handsfree-muted-speaking", size, scheme);
      await p.click("#now-actions .voice-interrupt");
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.state === "muted", null, { timeout: 5000 });

      // A task runs: the hint says its updates are still said.
      await p.evaluate(() => {
        const s = { sessionId: "s-new", source: "adhoc", title: "Read my email", instructions: "Read my email", brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: new Date().toISOString() };
        const st = window.__data.state;
        window.__push({ type: "state", state: { ...st, running: s, runningSessions: [s], tabChats: { 1: s.sessionId }, runningTabs: { [s.sessionId]: [1] } } });
      });
      await p.waitForFunction(() => document.getElementById("voice-bar").dataset.phase === "working", null, { timeout: 5000 });
      const working = await look();
      want(working.state === "muted" && /Agent working · updates are still said$/.test(working.detail), "working while muted", working);
      want(await p.evaluate(() => !document.getElementById("now-stop").hidden), "no task Stop while it works", working);
      await checkLayout(p, `handsfree-muted-working ${label}`);
      await shoot(p, "panel-handsfree-muted-working", size, scheme);

      // Alt+M unmutes: the strip is live again and the microphone streams.
      await p.keyboard.press("Alt+KeyM");
      const unmuted = await look();
      want(unmuted.muted === null && unmuted.pressed === "false" && unmuted.state !== "muted" && unmuted.reported?.muted === undefined, "Alt+M did not unmute", unmuted);
      const at = await appends();
      await p.waitForFunction((n) => window.__rt.sent.filter((e) => e.type === "input_audio_buffer.append").length > n, at, { timeout: 5000 }).catch(() => fail(`unmuted ${label}: no audio streamed`));
      await p.evaluate(() => window.__push({ type: "panel.voice" }));
      await p.waitForFunction(() => document.querySelector("#voice-bar").hidden);
      reportErrors(p, `handsfree-muted ${label}`);
      await p.close();
    },
  },
  // Voice in the chat: messages the user spoke carry a mic; what was said aloud is part of the thread, quieter than the
  // answer (the one that repeats the text above it compact), and stays when the chat is opened again.
  {
    names: ["panel-voice-chat"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "voice-chat", "#chat-log .ev-end");
      const got = await p.evaluate(() => ({
        first: document.querySelector("#chat-log .ev-first")?.classList.contains("voice") && !!document.querySelector("#chat-log .ev-first .ev-voice"),
        users: [...document.querySelectorAll("#chat-log .ev-user:not(.ev-first)")].map((e) => [e.classList.contains("voice"), e.textContent]),
        spoken: [...document.querySelectorAll("#chat-log .ev-spoken")].map((e) => [e.classList.contains("echo"), e.textContent]),
        order: [...document.querySelectorAll("#chat-log > *")].map((e) => e.className.split(" ")[0]).join(" "),
      }));
      if (!got.first) fail("voice chat: the first message has no mic");
      if (JSON.stringify(got.users) !== JSON.stringify([[true, "Tell her yes and archive it"], [false, "sign it Ada"]])) fail(`voice chat: user messages ${JSON.stringify(got.users)}`);
      const want = [
        [true, "I'll open Gmail and read your newest email."],
        [false, "Sarah says Friday's dinner moved to eight. She wants a yes by Thursday."],
        [false, "Done: I said yes and archived it. Anything else?"],
      ];
      if (JSON.stringify(got.spoken) !== JSON.stringify(want)) fail(`voice chat: spoken lines ${JSON.stringify(got.spoken)}`);
      if (!/^ev-opening ev-head ev-text ev-spoken ev-steps ev-text ev-end ev-spoken ev-user ev-user ev-steps ev-end ev-spoken$/.test(got.order)) fail(`voice chat: order ${got.order}`);
      // Quieter than the answer: smaller type than the agent's text, and the compact one on one line.
      const style = await p.evaluate(() => {
        const px = (el) => parseFloat(getComputedStyle(el).fontSize);
        const echo = document.querySelector("#chat-log .ev-spoken.echo");
        return { spoken: px(document.querySelector("#chat-log .ev-spoken:not(.echo)")), text: px(document.querySelector("#chat-log .ev-text")), echoH: echo.getBoundingClientRect().height, echoLine: parseFloat(getComputedStyle(echo).lineHeight) };
      });
      if (!(style.spoken < style.text) || style.echoH > style.echoLine + 8) fail(`voice chat: styles ${JSON.stringify(style)}`);
      await checkLayout(p, `voice-chat ${label}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await shoot(p, "panel-voice-chat", size, scheme);
      reportErrors(p, `voice-chat ${label}`);
      await p.close();
    },
  },
  // Raw: a three-turn voice conversation (Standard, then Realtime) with its timings, in place of the log.
  {
    names: ["panel-raw", "panel-raw-turn", "panel-raw-realtime"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, expectBar }) {
      const p = await openPanel(ctx, "raw", "#chat-log .ev-end");
      await expectBar(p, { "chat-new": true, "chat-show": false, "chat-raw-btn": true }, "raw: before");
      await p.click("#chat-raw-btn");
      await p.waitForSelector("#chat-raw .raw-turn");
      const got = await p.evaluate(() => {
        const raw = document.getElementById("chat-raw");
        const body = raw.querySelector(".raw-body");
        const b = body.getBoundingClientRect();
        return {
          logHidden: document.getElementById("chat-log").hidden,
          rawShown: !raw.hidden && raw.getBoundingClientRect().height > 200,
          pressed: document.getElementById("chat-raw-btn").getAttribute("aria-pressed"),
          tiles: [...raw.querySelectorAll(".raw-stat-label")].map((e) => e.textContent),
          tileTitles: [...raw.querySelectorAll(".raw-stat")].every((e) => e.title),
          slowest: raw.querySelectorAll(".raw-slowest li").length,
          turns: [...raw.querySelectorAll(".raw-turn-title")].map((e) => e.textContent),
          rels: [...raw.querySelectorAll(".raw-rel")].map((e) => e.textContent),
          slow: raw.querySelectorAll(".raw-row.slow").length,
          errors: raw.querySelectorAll(".raw-row.error").length,
          labels: [...raw.querySelectorAll(".raw-label")].map((e) => e.textContent),
          wide: [...raw.querySelectorAll(".raw-row, .raw-stat, .raw-summary")].filter((e) => e.getBoundingClientRect().right > b.right + 0.5).length,
          scrollsX: body.scrollWidth > body.clientWidth + 1,
          text: raw.textContent,
        };
      });
      if (!got.logHidden || !got.rawShown || got.pressed !== "true") fail(`raw: not shown in place of the log ${JSON.stringify({ logHidden: got.logHidden, rawShown: got.rawShown, pressed: got.pressed })}`);
      // The Realtime narrator's own tile follows speech to agent (trace-report.ts, "Narrator").
      const tiles = ["Total", "First response", "Speech → agent", "Narrator", "Model", "Tools", "Voice", "Other", "Tokens"];
      if (JSON.stringify(got.tiles) !== JSON.stringify(tiles)) fail(`raw: summary tiles ${JSON.stringify(got.tiles)}`);
      if (!got.tileTitles) fail("raw: a summary tile without its explanation");
      if (got.slowest !== 5) fail(`raw: ${got.slowest} slowest items`);
      if (got.turns.length !== 3 || !/^Turn 1 · .* · done · first response/.test(got.turns[0]) || !/paused/.test(got.turns[2])) fail(`raw: turns ${JSON.stringify(got.turns)}`);
      if (!got.rels.length || got.rels.some((r) => !/^[+-]\d+\.\d\d s$/.test(r))) fail(`raw: relative times ${got.rels.slice(0, 5)}`);
      if (got.slow < 3) fail(`raw: only ${got.slow} slow rows`);
      if (got.errors < 1) fail("raw: the failed screenshot is not marked");
      for (const want of [
        "Voice: end of speech → transcript",
        "Voice: sending window",
        "Voice: Realtime connected",
        "Voice: narrator reply (to speech)",
        "Voice: your words transcribed",
        "Claude Code process ready",
        "Model call",
        "act step 1 · Jev type 0.97",
        "Browser navigate",
        "Voice: barge-in (cut the line off)",
        "Voice: line said",
      ]) {
        if (!got.labels.includes(want)) fail(`raw: no "${want}" row`);
      }
      if (got.wide || got.scrollsX) fail(`raw: ${got.wide} items wider than the view, scrolls sideways: ${got.scrollsX}`);
      if (got.text.includes(RAW_SECRET)) fail("raw: a secret is shown");
      await checkLayout(p, `raw ${label}`);
      await shoot(p, "panel-raw", size, scheme);

      // Copy: the timeline as text (the page's clipboard, stubbed: the system clipboard is left alone in tests).
      await p.evaluate(() => {
        window.__copied = null;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => void (window.__copied = t) } });
      });
      await p.click(".raw-copy");
      const copied = await (await p.waitForFunction(() => window.__copied)).jsonValue();
      if (!/^BrowserTODO trace · /.test(copied) || !copied.includes("SUMMARY") || !copied.includes("TURN 3") || copied.includes(RAW_SECRET)) fail(`raw: copied text ${copied.slice(0, 200)}`);
      if (!(await p.textContent(".raw-copy")).includes("Copied")) fail("raw: Copy does not say it copied");

      // Download .json: a valid, redacted export with the environment.
      const [download] = await Promise.all([p.waitForEvent("download"), p.click(".raw-save")]);
      const name = download.suggestedFilename();
      if (!/^browsertodo-trace-s-raw-\d{8}-\d{4}\.json$/.test(name)) fail(`raw: download name ${name}`);
      const json = await readFile(await download.path(), "utf8");
      let doc = null;
      try {
        doc = JSON.parse(json);
      } catch (err) {
        fail(`raw: download is not JSON (${err})`);
      }
      if (doc) {
        if (doc.format !== "browsertodo.trace" || doc.turns?.length !== 3) fail(`raw: export ${doc.format} with ${doc.turns?.length} turns`);
        if (!doc.env?.extensionVersion || !doc.env?.helper?.version || !doc.env?.voice?.engine || !doc.env?.os) fail(`raw: export env ${JSON.stringify(doc.env)}`);
        if (json.includes(RAW_SECRET)) fail("raw: the export carries a secret");
        if (!doc.summary?.slowest?.length || !doc.summary?.tokens?.in) fail("raw: export summary incomplete");
      }

      // The turns below: each title stays on top while its rows scroll under it.
      await p.evaluate(() => document.querySelector('#chat-raw .raw-turn[data-turn="2"]').scrollIntoView());
      await shoot(p, "panel-raw-turn", size, scheme);
      await p.evaluate(() => document.querySelector('#chat-raw .raw-turn[data-turn="3"]').scrollIntoView());
      await shoot(p, "panel-raw-realtime", size, scheme);

      // Back to chat: the log again.
      await p.click(".raw-back");
      const back = await p.evaluate(() => ({ log: !document.getElementById("chat-log").hidden, raw: document.getElementById("chat-raw").hidden, pressed: document.getElementById("chat-raw-btn").getAttribute("aria-pressed") }));
      if (!back.log || !back.raw || back.pressed !== "false") fail(`raw: back to chat ${JSON.stringify(back)}`);
      await checkLayout(p, `raw back ${label}`);
      reportErrors(p, `raw ${label}`);
      await p.close();
    },
  },
  // The microphone permission page (opened in a tab): asking, allowed, blocked.
  {
    names: ["mic-page-asking", "mic-page-granted", "mic-page-denied"],
    async run({ ctx, size, scheme, fail, want, shoot, base }) {
      for (const [name, setup] of [
        ["mic-page-asking", () => (navigator.mediaDevices.getUserMedia = () => new Promise(() => {}))],
        ["mic-page-granted", () => {}],
        ["mic-page-denied", () => (navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")))],
      ]) {
        if (!want(name, size, scheme)) continue;
        const p = await ctx.newPage();
        const errors = [];
        p.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
        await p.addInitScript(setup);
        await p.addInitScript(() => {
          const query = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (d) => (d.name === "microphone" ? Promise.resolve({ state: "prompt" }) : query(d));
          window.chrome = { tabs: { getCurrent: async () => ({ id: 5 }), remove: async () => {} } };
        });
        await p.goto(`${base}/mic-permission.html`);
        const expected = name.replace("mic-page-", "");
        await p.waitForFunction((st) => document.body.dataset.state === st, expected);
        if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`${name}: horizontal scroll`);
        if (errors.length) fail(`${name}: ${errors.join("; ")}`);
        await shoot(p, name, size, scheme);
        await p.close();
      }
    },
  },
];
