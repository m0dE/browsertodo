// The side panel cases of the UI harness: each { names (its screenshots), run(t) } runs when --only
// matches one of its names (or `when(t)` says so) at every panel size and colour scheme. `t` has the
// size's browser context and label, the checks (checks.mjs) and the panel helpers below.
import { join } from "node:path";
import { installChromeStub } from "./chrome-stub.mjs";
import { EMAIL_ANSWER, scenario, SHORTCUT_LABEL, SUGGESTION, thumbnail } from "./scenarios.mjs";

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
        ["chat-new", "chat-show"].map((id) => {
          const b = document.getElementById(id);
          return [id, { text: b.textContent, on: b.getAttribute("aria-disabled") !== "true", title: b.title }];
        }),
      ),
    );
  const expectBar = async (p, want, what) => {
    const bar = await chatBar(p);
    const order = await p.evaluate(() => [...document.querySelectorAll(".chat-bar .bar-btn")].map((b) => b.textContent).join(" | "));
    if (order !== "New chat | Show tab") fail(`chat bar order "${order}"`);
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
  return { fail, chatBar, expectBar, expectChipHints, tabsText };
}

export const PANEL_CASES = [
  // Idle: nothing running. Chat is the default tab and shows an empty new chat; the composer starts a one-off task.
  {
    names: ["panel-chat-idle", "panel-composer-long", "panel-model-menu", "panel-composer-files"],
    async run({ ctx, size, scheme, label, fail, expectBar, tabsText, want, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "idle", ".chat-empty");
      if ((await tabsText(p)) !== "Chat | TODO | Activity log") fail(`tabs "${await tabsText(p)}"`);
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
    },
  },
  // An empty box in Chat: the placeholder says what Enter does; Send looks usable; the new chat shows the shortcut.
  // Enter starts "look at this page" in this tab; the chat shows it as a quiet user turn. Under TODO an empty
  // box does nothing but say so. The shortcut's push switches to Chat and focuses the box; Change opens Chrome's page.
  {
    names: ["panel-empty-send", "panel-empty-send-sent", "panel-restricted", "panel-empty-noshortcut"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
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
      if (look.hint !== `Press ${SHORTCUT_LABEL} to open this chat at any time.`) fail(`empty send: shortcut hint "${look.hint}"`);
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
      const turn = await p.evaluate(() => ({ text: document.querySelector("#chat-log .ev-user.screen")?.textContent, title: document.getElementById("chat-title").textContent }));
      if (turn.text !== SCREEN || turn.title !== SCREEN) fail(`empty send: user turn ${JSON.stringify(turn)}`);
      await checkLayout(p, `empty send sent ${label}`);
      await shoot(p, "panel-empty-send-sent", size, scheme);

      // Chrome keeps extensions out of the user's page: one quiet line, the run goes on.
      await push({ type: "status", text: "Chrome doesn't let extensions see this page; browsertodo will work in other tabs" });
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
      // The input's focus is reported (the shortcut then closes the panel from there).
      if (!(await p.evaluate(() => window.__portSent.some((m) => m.type === "panel.input" && m.focused === true)))) fail("input focus not reported");
      reportErrors(p, `empty send ${label}`);
      await p.close();

      // Under TODO an empty box does nothing, and says so.
      const t = await openPanel(ctx, "idle", ".chat-empty");
      await t.click("#tab-btn-todo");
      await t.click("#now-text");
      await t.keyboard.press("Enter");
      await t.waitForFunction(() => document.getElementById("now-msg").textContent);
      const todo = await t.evaluate(() => ({
        sent: window.__requests.some((r) => r.type === "run.adhoc" || r.type === "run.message"),
        msg: document.getElementById("now-msg").textContent,
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
  // Empty todo list: nothing due, so Run now is disabled and says why; with cloud sync it stays usable.
  {
    names: ["panel-todo-empty"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
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
    },
  },
  // A running session: TODO, then Chat with its action bar, then the Activity Log.
  {
    names: ["panel-todo", "panel-model-running", "panel-add-form", "panel-finished-menu", "panel-chat-running", "panel-activity-log", "panel-activity-log-open"],
    async run({ ctx, size, scheme, label, fail, expectBar, expectChipHints, want, only, openPanel, shoot, checkLayout, reportErrors, wantAny, shots, taken }) {
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
      if (wantAny(["panel-chat-running", "panel-activity-log", "panel-activity-log-open"], size, scheme)) {
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

        // Activity Log: the list of runs, no composer. Picking a finished run (by keyboard) opens it in Chat, bound to this tab.
        await page.click("#tab-btn-history");
        await page.waitForSelector(".sessions li");
        await expectChipHints(page, "activity log");
        await checkLayout(page, `activity log ${label}`);
        await shoot(page, "panel-activity-log", size, scheme);
        if (await page.evaluate(() => !!document.querySelector("#hist-past, #hist-log, #hist-open, #hist-rawlog"))) fail("the read-only run view is still in the page");
        const pastRow = page.locator(".sessions li button").nth(1);
        const pastId = await pastRow.getAttribute("data-id");
        await pastRow.focus();
        await page.keyboard.press("Enter");
        await page.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-text");
        const opened = await page.evaluate(() => ({
          tab: document.querySelector(".tabs [aria-selected=true]")?.id,
          title: document.getElementById("chat-title").textContent,
          bind: window.__requests.filter((r) => r.type === "chat.bind").at(-1),
          composer: !document.getElementById("composer").hidden,
          focus: document.activeElement?.id,
        }));
        if (opened.tab !== "tab-btn-chat" || opened.title !== "Post 'good morning' on X" || opened.bind?.sessionId !== pastId || opened.bind?.tabId !== 1 || !opened.composer || opened.focus !== "now-text") {
          fail(`Activity Log row did not open the run in Chat: ${JSON.stringify(opened)}`);
        }
        await checkLayout(page, `activity log open ${label}`);
        await shoot(page, "panel-activity-log-open", size, scheme);
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
  // Task details: the Chat title, a TODO title and a past chat message's title open a sheet with everything known.
  {
    names: ["panel-details-chat", "panel-details-focus", "panel-details-todo", "panel-details-message"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, reportErrors, base, shots, taken }) {
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

      // Activity Log: a past one-off chat opens in Chat; its title's details show the whole message typed.
      await p.click("#tab-btn-history");
      await p.locator(".sessions li button", { hasText: "Lisbon" }).click();
      await p.waitForFunction(() => !document.getElementById("tab-chat").hidden && document.getElementById("chat-title").textContent.includes("Lisbon"));
      await p.click("#chat-title");
      await p.waitForSelector("dialog.sheet[open]");
      const msg = await sheet();
      checkSheet(msg, "details of a chat message");
      const lisbon = known.sessions.find((x) => x.sessionId === "s-3");
      if (msg.heading !== "Chat message" || msg.text !== lisbon.instructions || msg.fields.Source !== "Chat message" || msg.fields["Last pause reason"] !== "Needs you to pick dates") fail(`message details ${JSON.stringify(msg)}`);
      if (msg.buttons.includes("Open in TODO")) fail("chat message offers Open in TODO");
      await shoot(p, "panel-details-message", size, scheme);
      await p.locator("dialog.sheet button", { hasText: "Close" }).click();
      await p.waitForFunction(() => !document.querySelector("dialog.sheet"));
      if ((await p.evaluate(() => document.activeElement?.id)) !== "chat-title") fail("Close did not return focus to the chat title");
      reportErrors(p, `details ${label}`);
      await p.close();
    },
  },
  // A conversation: two turns in one thread (the second opened by the user's bubble), the composer talks to it,
  // the header says whether its Claude Code session is still open; New Chat empties the thread and goes back to "Do this now".
  {
    names: ["panel-conversation", "panel-conversation-ended", "panel-conversation-newchat", "panel-conversation-todo"],
    async run({ ctx, size, scheme, label, fail, expectBar, want, only, openPanel, shoot, checkLayout, reportErrors }) {
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
      const NEW = { placeholder: "Figure out what to do based on the current screen", submit: "Send", newChat: false, attach: true, stop: false };
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

      const p = await openPanel(ctx, "suggest", "#chat-log .ev-end");
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
      await expectBox(p, { ghost: null, placeholder: "Message browsertodo…", described: null }, "after other text");
      await p.keyboard.press("Tab");
      if ((await box(p)).focused) fail("suggestion: with other text typed, Tab did not move the focus");
      await p.fill("#now-text", "");
      await expectBox(p, { ghost: SUGGESTION }, "after emptying the box");

      // Voice input hides it while it writes into the box; cancelling restores the empty box, and the suggestion.
      await p.click("#now-actions .voice-mic");
      await voiceIs(p, ["opening", "listening"]);
      await expectBox(p, { ghost: null }, "while voice starts");
      await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
      await expectBox(p, { ghost: null }, "with dictated text");
      await p.keyboard.press("Escape");
      await voiceIs(p, ["idle"]);
      await expectBox(p, { value: "", ghost: SUGGESTION }, "after voice was cancelled");

      // Under TODO the box never offers it.
      await p.click("#tab-btn-todo");
      await expectBox(p, { ghost: null, described: null }, "under TODO");
      await p.click("#tab-btn-chat");
      await expectBox(p, { ghost: SUGGESTION }, "back in Chat");

      // Esc dismisses it for this turn: the placeholder is back, Tab moves the focus, an empty Enter looks at the page.
      await focusBox(p);
      await p.keyboard.press("Escape");
      await expectBox(p, { value: "", ghost: null, placeholder: "Message browsertodo…", described: null }, "after Esc");
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
    async run({ ctx, size, scheme, label, fail, only, openPanel, shoot, checkLayout, reportErrors }) {
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
    },
  },
  // A chat per tab: tab 1 has a running chat, tab 2 has none; switching tabs switches the chat.
  {
    names: ["panel-tabs-a", "panel-tabs-b", "panel-tabs-b-started"],
    async run({ ctx, size, scheme, label, fail, expectBar, openPanel, shoot, checkLayout, reportErrors }) {
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
      await checkLayout(p, `tabs-b-started ${label}`);
      await shoot(p, "panel-tabs-b-started", size, scheme);
      // Back to tab 1: its chat is still there.
      await p.evaluate(() => window.__activateTab(1));
      await p.waitForFunction(() => document.getElementById("chat-title").textContent.startsWith("Summarize this pull request"));
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
            acct: (() => { const d = document.getElementById("acct"); const shown = (id) => getComputedStyle(document.getElementById(id)).display !== "none"; return !d.hidden && !d.hasAttribute("data-signed-in") && shown("acct-anon") && shown("acct-login") && shown("acct-open-settings") && !shown("acct-signout") && !shown("acct-who"); })(),
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
          return { left: r.left, right: r.right, email: document.getElementById("acct-email").textContent, plan: document.getElementById("acct-plan").textContent };
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
        }));
        if (menu.head !== "BrowserTODO AI model" || menu.credit !== "$14.21 usage credit left" || menu.models !== 4 || menu.jev) fail(`hosted model menu ${JSON.stringify(menu)}`);
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
        const plan = await p.evaluate(() => document.getElementById("acct-plan").textContent);
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
      await p.waitForSelector("#now-msg .ev-error");
      const got = await p.evaluate(() => ({
        msg: document.querySelector("#now-msg .err-msg")?.textContent,
        hint: document.querySelector("#now-msg .err-hint")?.textContent,
        fixes: [...document.querySelectorAll("#now-msg .err-fix")].map((b) => b.textContent),
        box: document.getElementById("now-text").value,
      }));
      if (got.msg !== "Local Claude Code isn't connected." || got.fixes.join(" | ") !== "Set up Claude Code | Use BrowserTODO AI") fail(`auto switch refusal ${JSON.stringify(got)}`);
      if (got.box !== "and reply to the first comment") fail("the refused message did not go back into the box");
      await checkLayout(p, `auto-switch ${label}`);
      await shoot(p, "panel-error-auto-switch", size, scheme);
      await p.click("#now-msg [data-fix=use-hosted]");
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
    names: ["panel-paused-activity-log"],
    async run({ ctx, size, scheme, label, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "paused", ".chat-empty");
      await p.click("#tab-btn-history");
      await p.waitForSelector(".sessions li");
      await checkLayout(p, `paused ${label}`);
      await shoot(p, "panel-paused-activity-log", size, scheme);
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
      const CHAT = { placeholder: "Message browsertodo…", submit: "Send", newChat: true, attach: false };
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

      // A past stopped run from the Activity Log opens straight in Chat, with Continue, and the composer talks to it.
      if (want("panel-continue-past-chat", size, scheme)) {
        await p.click("#tab-btn-history");
        await p.waitForSelector(".sessions li");
        await p.locator(".sessions li button", { hasText: "cheapest flight" }).click();
        await p.waitForSelector("#tab-chat:not([hidden]) #chat-log .ev-continue");
        if (!(await p.locator("#chat-title").textContent()).includes("cheapest flight")) fail("the Activity Log row did not show the run in Chat");
        await expectMode(CHAT, "not talking to a past stopped run opened from the Activity Log");
        if ((await p.evaluate(() => document.activeElement?.id)) !== "now-text") fail("opening from the Activity Log did not focus the box");
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
  // Voice input: the mic left of Send (locked on Free), listening with the orb and live text, finishing,
  // Enter sends, Esc cancels, and the microphone permission asked in a tab.
  {
    names: ["panel-voice-locked", "panel-voice-idle", "panel-voice-listening", "panel-voice-transcribing", "panel-voice-permission"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors, base }) {
      // The microphone is allowed (a grant for the origin replaces earlier ones, e.g. the clipboard's above).
      await ctx.grantPermissions(["microphone"], { origin: base });
      const mic = "#now-actions .voice-mic";
      const voiceState = (p) => p.getAttribute(mic, "data-state");
      /** Waits for the mic's state; on timeout says what the panel shows instead. */
      const waitVoice = (p, state) =>
        p.waitForFunction((st) => document.querySelector(".voice-mic").dataset.state === st, state).catch(async (err) => {
          const seen = await p.evaluate(() => ({ state: document.querySelector(".voice-mic").dataset.state, tip: document.querySelector(".voice-tip").textContent }));
          throw new Error(`waiting for voice "${state}": ${JSON.stringify(seen)} (${err.message.split("\n")[0]})`);
        });
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

      // Free plan: a lock; the tooltip and a click explain, "Get a plan" opens the dashboard's Billing page.
      {
        const p = await openPanel(ctx, "free", ".chat-empty");
        if ((await voiceState(p)) !== "locked") fail(`free plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== "Voice needs the Plus or Pro plan") fail(`locked tooltip "${await p.getAttribute(mic, "title")}"`);
        await p.click(mic);
        await p.waitForSelector(".voice-tip:not([hidden])");
        const tipText = await p.textContent(".voice-tip");
        if (!/Voice needs the Plus or Pro plan/.test(tipText) || !/Get a plan/.test(tipText)) fail(`locked tip "${tipText}"`);
        await checkLayout(p, `voice-locked ${label}`);
        await shoot(p, "panel-voice-locked", size, scheme);
        await p.click(".voice-tip button.link");
        await p.waitForFunction(() => window.__created.includes("https://app.browsertodo.com/billing"));
        // The shortcut while locked points at the mic.
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        if (!(await p.evaluate(() => document.querySelector(".voice-mic").classList.contains("nudge")))) fail("locked shortcut did not point at the mic");
        reportErrors(p, `voice-locked ${label}`);
        await p.close();
      }

      // Paid plan: idle, listening (live text, orb), finishing; toggling off keeps the text unsent.
      {
        const p = await openPanel(ctx, "account", ".chat-empty");
        if ((await voiceState(p)) !== "idle") fail(`paid plan mic ${await voiceState(p)}`);
        if ((await p.getAttribute(mic, "title")) !== `Voice · ${SHORTCUT_LABEL}`) fail(`mic tooltip "${await p.getAttribute(mic, "title")}"`);
        await checkLayout(p, `voice-idle ${label}`);
        await shoot(p, "panel-voice-idle", size, scheme);

        await p.click(mic);
        await waitVoice(p, "listening");
        await p.waitForFunction(() => document.getElementById("now-text").value.split(" ").length >= 6, null, { timeout: 15_000 });
        const problems = await orbCheck(p);
        if (problems.length) fail(`listening orb: ${problems.join("; ")}`);
        if ((await p.textContent(".voice-caption")) !== "Listening… Esc to cancel · Enter to send") fail("listening caption");
        if (!(await p.evaluate(() => document.activeElement === document.getElementById("now-text")))) fail("the box lost the cursor while listening");
        await checkLayout(p, `voice-listening ${label}`);
        await shoot(p, "panel-voice-listening", size, scheme);

        await p.evaluate(() => (window.__voiceHold = true));
        await p.click(mic);
        await waitVoice(p, "transcribing");
        if ((await p.textContent(".voice-caption")) !== "Finishing…") fail("finishing caption");
        await shoot(p, "panel-voice-transcribing", size, scheme);
        await p.evaluate(() => {
          window.__voiceHold = false;
          window.__voiceRelease?.();
        });
        await waitVoice(p, "idle");
        const kept = await p.inputValue("#now-text");
        if (kept !== "Open Gmail and reply to Sarah that I will be there at seven.") fail(`toggled off: box "${kept}"`);
        if (await p.evaluate(() => window.__requests.some((r) => r.type === "run.adhoc"))) fail("toggling voice off sent the message");
        if (!(await p.evaluate(() => document.querySelector(".voice-orb").hidden))) fail("orb still shown after stopping");

        // Esc: what was typed before stays, the voice text goes.
        await p.fill("#now-text", "On LinkedIn:");
        await p.click(mic);
        await p.waitForFunction(() => document.getElementById("now-text").value.length > "On LinkedIn:".length, null, { timeout: 15_000 });
        await p.keyboard.press("Escape");
        await waitVoice(p, "idle");
        if ((await p.inputValue("#now-text")) !== "On LinkedIn:") fail(`Esc left "${await p.inputValue("#now-text")}"`);

        // The shortcut starts listening; Enter stops, finishes the text and sends it like a typed message.
        await p.fill("#now-text", "");
        await p.evaluate(() => (window.__voiceClips = 0));
        await p.evaluate(() => window.__push({ type: "panel.voice" }));
        await waitVoice(p, "listening");
        await p.waitForFunction(() => document.getElementById("now-text").value.length > 0, null, { timeout: 15_000 });
        await p.keyboard.press("Enter");
        await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.adhoc"));
        const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.adhoc").instructions);
        if (!/^Open Gmail/.test(sent)) fail(`Enter sent "${sent}"`);
        if ((await p.inputValue("#now-text")) !== "") fail("the box was not cleared after sending");
        reportErrors(p, `voice ${label}`);
        await p.close();
      }

      // No microphone permission yet: the mic opens the permission page and says so.
      {
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
        await p.waitForSelector(".voice-tip:not([hidden])");
        if (!(await p.evaluate(() => window.__created.some((u) => u.endsWith("/mic-permission.html"))))) fail("the permission page did not open");
        if (!/Allow the microphone/.test(await p.textContent(".voice-tip"))) fail(`permission tip "${await p.textContent(".voice-tip")}"`);
        if ((await voiceState(p)) !== "idle") fail(`mic after asking: ${await voiceState(p)}`);
        await checkLayout(p, `voice-permission ${label}`);
        await shoot(p, "panel-voice-permission", size, scheme);
        reportErrors(p, `voice-permission ${label}`);
        await p.close();
      }
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
