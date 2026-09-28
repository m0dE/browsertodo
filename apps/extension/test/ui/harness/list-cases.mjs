// The jobs list with chat titles (jobs.ts, job-list.ts) and a job renamed from its page (job-page.ts): the UI harness
// cases, run like PANEL_CASES at each panel size and scheme.

export const LIST_CASES = [
  // Chats titled by the title model, a chat running in another tab, a TODO task with its run, as one list; each row
  // names itself for screen readers; the running one's page says where it runs (and is not bound here); a finished
  // chat opens bound to this tab and the box goes on with it.
  {
    names: ["panel-list-titles", "panel-list-titles-opened"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, openJob, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      const g = await groups(p);
      const want = [
        ["Needs you", ["task:t5", "chat:s-r3"]],
        ["Running", ["chat:s-r1", "task:t2"]],
        ["Scheduled", ["task:t3", "task:t4", "task:t1"]],
      ];
      if (JSON.stringify(g.slice(0, 3)) !== JSON.stringify(want)) fail(`titles: groups ${JSON.stringify(g)}`);
      const recent = g.find(([name]) => name === "Recent")?.[1] ?? [];
      // Newest first; the TODO run is its task's job (t6), shown once.
      if (recent.slice(0, 4).join() !== "chat:s-r2,task:t6,task:t7,chat:s-r4" || recent.filter((k) => k === "task:t6").length !== 1) fail(`titles: Recent ${JSON.stringify(recent)}`);
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll(".job-row")].map((b) => ({
          key: b.dataset.key,
          title: b.querySelector(".job-title").textContent,
          meta: b.querySelector(".job-meta")?.textContent ?? "",
          when: b.querySelector(".job-when").textContent,
          aria: b.getAttribute("aria-label"),
        })),
      );
      const row = (key) => rows.find((r) => r.key === key);
      if (row("chat:s-r1")?.title !== "Schedule 3x daily X posts" || row("chat:s-r1")?.when !== "now") fail(`titles: running row ${JSON.stringify(row("chat:s-r1"))}`);
      const web = row("chat:s-r2");
      if (web?.title !== "Check Chrome Web Store emails" || web.when !== "12 min ago" || web.meta !== "mail.google.com" || web.aria !== "Check Chrome Web Store emails, Done, 12 min ago, mail.google.com") fail(`titles: row ${JSON.stringify(web)}`);
      if (row("chat:s-r3")?.meta !== "Needs you to pick dates") fail(`titles: needs-you row ${JSON.stringify(row("chat:s-r3"))}`);
      await checkLayout(p, `titles ${label}`);
      await shoot(p, "panel-list-titles", size, scheme);

      // A finished chat, by keyboard: bound to this tab; a message goes on with it.
      await p.focus('.job-row[data-key="chat:s-r2"]');
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector("#chat-log")?.textContent.includes("Two new emails"));
      const bind = await p.evaluate(() => window.__requests.find((r) => r.type === "chat.bind"));
      if (bind?.sessionId !== "s-r2" || bind.tabId !== 1) fail(`titles: opened with ${JSON.stringify(bind)}`);
      if ((await p.textContent("#job-title")) !== "Check Chrome Web Store emails") fail(`titles: page title "${await p.textContent("#job-title")}"`);
      await checkLayout(p, `titles opened ${label}`);
      await shoot(p, "panel-list-titles-opened", size, scheme);
      await p.click("#now-text");
      await p.keyboard.insertText("Reply to the review team and thank them");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      const sent = await p.evaluate(() => window.__requests.find((r) => r.type === "run.message" && r.text?.startsWith("Reply to the review team")));
      if (sent.sessionId !== "s-r2") fail(`titles: the message went to ${sent.sessionId ?? "a new job"}`);
      await backToList(p);

      // The running chat of tab 2: its page says so, Show tab goes there, nothing is bound here.
      await openJob(p, "chat:s-r1");
      await p.waitForSelector("#job-elsewhere:not([hidden])");
      await p.click("#job-elsewhere button");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tab.focus"));
      if ((await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus").tabId)) !== 2) fail("titles: Show tab did not go to tab 2");
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "chat.bind" && r.sessionId === "s-r1"))) fail("titles: a chat running in tab 2 was bound here");
      reportErrors(p, `titles ${label}`);
      await p.close();
    },
  },
  // Rename from the job's "⋯": the title becomes a box (Escape keeps the name, Enter saves); the list shows the new
  // name. A TODO task's job has no Rename (it is named by its task).
  {
    names: ["panel-job-rename"],
    async run({ ctx, size, scheme, label, fail, openPanel, openJob, menuItems, pick, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      await openJob(p, "task:t6");
      if ((await menuItems(p)).includes("Rename")) fail("rename: a TODO task's job offers Rename");
      await backToList(p);
      await openJob(p, "chat:s-r2");
      // Escape keeps the title.
      await pick(p, "Rename");
      await p.waitForSelector("input.job-rename");
      await p.keyboard.insertText("Nope");
      await p.keyboard.press("Escape");
      const kept = await p.evaluate(() => ({ title: document.getElementById("job-title").textContent, box: !!document.querySelector("input.job-rename"), focus: document.activeElement?.id }));
      if (kept.title !== "Check Chrome Web Store emails" || kept.box || kept.focus !== "job-title") fail(`rename: Escape left ${JSON.stringify(kept)}`);
      // Enter saves.
      await pick(p, "Rename");
      await p.waitForSelector("input.job-rename");
      await p.keyboard.press("Control+A");
      await p.keyboard.insertText("Web Store review emails");
      await checkLayout(p, `rename ${label}`);
      await shoot(p, "panel-job-rename", size, scheme);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.getElementById("job-title")?.textContent === "Web Store review emails");
      const req = await p.evaluate(() => window.__requests.filter((r) => r.type === "session.rename"));
      if (req.length !== 1 || req[0].sessionId !== "s-r2" || req[0].title !== "Web Store review emails") fail(`rename: requests ${JSON.stringify(req)}`);
      await backToList(p);
      const title = await p.textContent('.job-row[data-key="chat:s-r2"] .job-title');
      if (title !== "Web Store review emails") fail(`rename: the list says "${title}"`);
      reportErrors(p, `rename ${label}`);
      await p.close();
    },
  },
  // A repeating task that ran three times is one job: its page lists the earlier runs, collapsed (date and how each
  // ended; the newest last), above the latest run's conversation; one opens to that run's conversation. Delete asks
  // first, then deletes the task's rows and runs.
  {
    names: ["panel-job-series", "panel-job-series-open", "panel-job-delete"],
    async run({ ctx, size, scheme, label, fail, groups, expectMenu, pick, openPanel, openJob, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "series");
      const g = await groups(p);
      if (JSON.stringify(g) !== JSON.stringify([["Scheduled", ["task:tip1"]], ["Recent", ["task:t9"]]])) fail(`series: list ${JSON.stringify(g)}`);
      const meta = await p.textContent('.job-row[data-key="task:tip1"] .job-meta');
      if (meta !== "Daily at 9:00 AM") fail(`series: row meta "${meta}"`);
      await openJob(p, "task:tip1");
      await p.waitForSelector("#chat-log .job-runs .job-run");
      const page = await p.evaluate(() => ({
        sub: document.getElementById("job-sub").textContent,
        runs: [...document.querySelectorAll("#chat-log .job-run > summary")].map((s) => s.textContent),
        open: document.querySelectorAll("#chat-log .job-run[open]").length,
        heads: [...document.querySelectorAll("#chat-log .job-runs-head")].map((h) => h.textContent),
        latest: document.querySelector("#chat-log > .ev-opening .ev-user-text")?.textContent,
        end: document.querySelector("#chat-log > .ev-end .ev-summary")?.textContent,
      }));
      // The next run is the next 9:00 (in words inside the line: "next tomorrow 9:00 AM").
      if (!/^Daily at 9:00 AM · next (today|tomorrow) 9:00 AM$/.test(page.sub)) fail(`series: subtitle "${page.sub}"`);
      if (page.runs.length !== 2 || !/done/.test(page.runs[0]) || !/failed/.test(page.runs[1]) || page.open !== 0) fail(`series: earlier runs ${JSON.stringify(page)}`);
      if (page.heads[0] !== "Earlier runs · 2" || !page.heads[1]?.startsWith("Latest run · ")) fail(`series: headings ${JSON.stringify(page.heads)}`);
      if (!page.latest?.startsWith("Post a short tip") || page.end !== "Posted: Ctrl+. opens BrowserTODO from any tab") fail(`series: latest run ${JSON.stringify(page)}`);
      await expectMenu(p, ["Run now", "Edit schedule", "Raw", "Delete"], "series");
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `series ${label}`);
      await shoot(p, "panel-job-series", size, scheme);
      // The failed run opens to its conversation, loaded then.
      await p.click("#chat-log .job-run:nth-child(2) > summary");
      await p.waitForSelector("#chat-log .job-run[open] .run-log .ev-end");
      const opened = await p.evaluate(() => ({ text: document.querySelector("#chat-log .job-run[open] .run-log").textContent, loads: window.__requests.filter((r) => r.type === "sessions.events").map((r) => r.sessionId) }));
      if (!opened.text.includes("X asked to confirm the login") || !opened.loads.includes("r-tip2")) fail(`series: opened run ${JSON.stringify(opened)}`);
      await p.evaluate(() => (document.getElementById("chat-log").scrollTop = 0));
      await checkLayout(p, `series open ${label}`);
      await shoot(p, "panel-job-series-open", size, scheme);
      // Delete: asked first in the menu (Keep goes back), then every row and run of it goes, and the list shows again.
      await pick(p, "Delete");
      await p.waitForSelector("#job-menu-pop .menu-note");
      await shoot(p, "panel-job-delete", size, scheme);
      if (await p.evaluate(() => window.__requests.some((r) => r.type === "tasks.delete" || r.type === "session.delete"))) fail("series: Delete deleted before it was confirmed");
      await p.click('#job-menu-pop [data-action="delete-confirm"]');
      await p.waitForSelector("#view-list:not([hidden])");
      const gone = await p.evaluate(() => ({ tasks: window.__requests.filter((r) => r.type === "tasks.delete").map((r) => r.id), runs: window.__requests.filter((r) => r.type === "session.delete").map((r) => r.sessionId) }));
      if (gone.tasks.sort().join() !== "tip1,tip2,tip3" || gone.runs.sort().join() !== "r-tip1,r-tip2,r-tip3") fail(`series: deleted ${JSON.stringify(gone)}`);
      reportErrors(p, `series ${label}`);
      await p.close();
    },
  },
];
