// The new chat's recent chats and chat titles (recent-chats.ts, history.ts): the UI harness cases, run like
// PANEL_CASES at each panel size and scheme.

export const RECENT_CASES = [
  // Tab 1 has no chat: the recent chats sit under "New chat" (the running one of tab 2 first, a TODO run not
  // offered); the keyboard moves through them; picking an ended one opens it here, bound to this tab, and a message
  // goes on with it. The running one switches to its tab; See all is History.
  {
    names: ["panel-recent", "panel-recent-opened"],
    async run({ ctx, size, scheme, label, fail, expectChipHints, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent", ".recent-chats:not([hidden]) .recent-row");
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll(".recent-row")].map((b) => ({
          id: b.dataset.id,
          title: b.querySelector(".recent-title").textContent,
          when: b.querySelector(".recent-when").textContent,
          chip: b.querySelector(".chip").textContent,
          where: b.querySelector(".recent-where")?.textContent ?? "",
          aria: b.getAttribute("aria-label"),
        })),
      );
      const ids = rows.map((r) => r.id).join(",");
      if (ids !== "s-r1,s-r2,s-r3,s-r4,s-r6,s-r7") fail(`recent: rows ${ids}`);
      const [run, web] = rows;
      if (run?.title !== "Schedule 3x daily X posts" || run.when !== "now" || run.chip !== "running" || run.where !== "another tab") fail(`recent: running row ${JSON.stringify(run)}`);
      if (web?.title !== "Check Chrome Web Store emails" || web.when !== "12 min ago" || web.chip !== "done" || web.where !== "mail.google.com") fail(`recent: row ${JSON.stringify(web)}`);
      if (!rows.every((r) => r.aria?.startsWith(r.title))) fail("recent: a row's accessible name does not start with its title");
      const look = await p.evaluate(() => ({
        newChat: document.querySelector(".chat-empty .empty-title")?.textContent,
        heading: document.querySelector(".recent-heading")?.textContent,
        all: document.querySelector(".recent-all")?.textContent,
        // The list sits down by the box, the title of a long chat is one line.
        gap: document.getElementById("composer").getBoundingClientRect().top - document.querySelector(".recent-chats").getBoundingClientRect().bottom,
        oneLine: [...document.querySelectorAll(".recent-title")].every((t) => t.scrollHeight <= t.clientHeight + 1),
      }));
      if (look.newChat !== "New chat" || look.heading !== "Recent chats" || look.all !== "See all") fail(`recent: ${JSON.stringify(look)}`);
      if (look.gap > 40 || look.gap < 0) fail(`recent: the list is ${look.gap}px from the box`);
      if (!look.oneLine) fail("recent: a title wraps");
      await expectChipHints(p, "recent");
      await checkLayout(p, `recent ${label}`);
      await shoot(p, "panel-recent", size, scheme);

      // Keyboard: Down moves to the next chat, Enter opens it here.
      await p.focus(".recent-row[data-id=s-r1]");
      await p.keyboard.press("ArrowDown");
      const focused = await p.evaluate(() => document.activeElement?.dataset.id);
      if (focused !== "s-r2") fail(`recent: ArrowDown focused ${focused}`);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("Two new emails"));
      const opened = await p.evaluate(() => ({
        bind: window.__requests.find((r) => r.type === "chat.bind"),
        list: !!document.querySelector(".recent-chats")?.isConnected,
      }));
      if (opened.bind?.sessionId !== "s-r2" || opened.bind.tabId !== 1) fail(`recent: opened with ${JSON.stringify(opened.bind)}`);
      if (opened.list) fail("recent: the list stays while a chat is shown");
      await checkLayout(p, `recent opened ${label}`);
      await shoot(p, "panel-recent-opened", size, scheme);
      // A message goes on with that chat.
      await p.click("#now-text");
      await p.keyboard.insertText("Reply to the review team and thank them");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      if (sent.sessionId !== "s-r2") fail(`recent: the message went to ${sent.sessionId ?? "a new chat"}`);
      reportErrors(p, `recent ${label}`);
      await p.close();

      // See all: History. The running chat of another tab: its tab is shown (the panel then shows its chat).
      const q = await openPanel(ctx, "recent", ".recent-chats:not([hidden]) .recent-row");
      await q.click(".recent-all");
      const tab = await q.evaluate(() => document.querySelector(".tabs [aria-selected=true]")?.dataset.tab);
      if (tab !== "history") fail(`recent: See all opened ${tab}`);
      await q.click("#tab-btn-chat");
      await q.click(".recent-row[data-id=s-r1]");
      await q.waitForFunction(() => window.__requests.some((r) => r.type === "tab.focus"));
      const focus = await q.evaluate(() => window.__requests.find((r) => r.type === "tab.focus"));
      if (focus.tabId !== 2) fail(`recent: the running chat switched to tab ${focus.tabId}`);
      reportErrors(q, `recent switch ${label}`);
      await q.close();
    },
  },
  // No chats yet: the new chat is as before (its title and shortcut hint), with no list.
  {
    names: ["panel-recent-empty"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent-empty", ".chat-empty .shortcut-hint");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "sessions.list" && r.chats));
      const hidden = await p.evaluate(() => document.querySelector(".recent-chats")?.hidden);
      if (hidden !== true) fail("recent empty: the list shows with no chats");
      await checkLayout(p, `recent empty ${label}`);
      await shoot(p, "panel-recent-empty", size, scheme);
      reportErrors(p, `recent empty ${label}`);
      await p.close();
    },
  },
  // History with the titles the model wrote; a chat renamed in place (the pencil, Enter saves, Escape cancels); a
  // TODO run has no pencil.
  {
    names: ["panel-history-titles", "panel-history-rename"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent", ".recent-chats:not([hidden]) .recent-row");
      await p.click("#tab-btn-history");
      await p.waitForSelector("#history-list li");
      const pencils = await p.evaluate(() => [...document.querySelectorAll("#history-list li")].map((li) => [li.querySelector(".s-open").dataset.id, !!li.querySelector(".s-rename")]));
      const todo = pencils.find(([id]) => id === "s-r5");
      if (!todo || todo[1]) fail(`history: the TODO run ${todo ? "has a pencil" : "is missing"}`);
      if (pencils.filter(([, has]) => has).length !== pencils.length - 1) fail(`history: pencils ${JSON.stringify(pencils)}`);
      await p.hover("#history-list li:nth-child(2)");
      await checkLayout(p, `history titles ${label}`);
      await shoot(p, "panel-history-titles", size, scheme);

      // Escape keeps the title.
      await p.click("#history-list li:nth-child(2) .s-rename");
      await p.keyboard.insertText("Nope");
      await p.keyboard.press("Escape");
      const kept = await p.evaluate(() => ({ title: document.querySelector("#history-list li:nth-child(2) .s-title").textContent, focus: document.activeElement?.classList.contains("s-open") }));
      if (kept.title !== "Check Chrome Web Store emails" || !kept.focus) fail(`history rename: Escape left ${JSON.stringify(kept)}`);
      // Enter saves.
      await p.click("#history-list li:nth-child(2) .s-rename");
      await p.waitForSelector(".s-rename-box");
      await p.keyboard.press("Control+A");
      await p.keyboard.insertText("Web Store review emails");
      await checkLayout(p, `history rename ${label}`);
      await shoot(p, "panel-history-rename", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector("#history-list li:nth-child(2) .s-title")?.textContent === "Web Store review emails");
      const req = await p.evaluate(() => window.__requests.find((r) => r.type === "session.rename"));
      if (req?.sessionId !== "s-r2" || req.title !== "Web Store review emails") fail(`history rename: request ${JSON.stringify(req)}`);
      if ((await p.evaluate(() => window.__requests.filter((r) => r.type === "session.rename").length)) !== 1) fail("history rename: Escape sent a rename");
      reportErrors(p, `history rename ${label}`);
      await p.close();
    },
  },
];
