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
        ["Upcoming", ["task:t3", "task:t4", "task:t1"]],
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

      // The running chat of tab 2: its page offers its tab (View goes there), nothing is bound here.
      await openJob(p, "chat:s-r1");
      await p.waitForSelector("#job-agent-tab:not([hidden])");
      await p.click("#job-agent-tab button");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tab.focus"));
      if ((await p.evaluate(() => window.__requests.find((r) => r.type === "tab.focus").tabId)) !== 2) fail("titles: View did not go to tab 2");
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
      if (JSON.stringify(g) !== JSON.stringify([["Upcoming", ["task:tip1"]], ["Recent", ["task:t9"]]])) fail(`series: list ${JSON.stringify(g)}`);
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
      await expectMenu(p, ["Run now", "Pause", "Edit schedule", "Raw", "Delete"], "series");
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
  // Dismissing jobs (job-dismiss.ts): Dismiss all on Needs you, Undo; ✕ on a row (on hover) moves a need to Recent
  // as Dismissed with Undo above the box; Delete on a focused row does the same and the focus goes on; nothing is kept
  // until Undo's time is over or the panel goes away (then jobs.dismiss); a Recent row dismissed leaves the list, and
  // a search still finds it.
  {
    names: ["panel-list-dismiss-hover", "panel-list-dismiss-undo"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "recent");
      const needs = async () => (await groups(p)).find(([g]) => g === "Needs you")?.[1] ?? [];
      const recent = async () => (await groups(p)).find(([g]) => g === "Recent")?.[1] ?? [];
      const sent = () => p.evaluate(() => window.__requests.filter((r) => r.type === "jobs.dismiss").map((r) => r.dismissals));
      if ((await needs()).join() !== "task:t5,chat:s-r3") fail(`dismiss: Needs you ${JSON.stringify(await needs())}`);

      // Dismiss all, then Undo: both back, nothing kept.
      await p.click("#job-groups .group-action");
      if ((await needs()).length) fail("dismiss: Dismiss all left rows under Needs you");
      await p.waitForSelector('#now-notice:not([hidden]) >> text=Dismissed 2 jobs');
      await p.click('#now-notice button:has-text("Undo")');
      await p.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="group-needs"] .job-row').length === 2);

      // ✕ on hover.
      await p.hover('.job-row[data-key="chat:s-r3"]');
      const x = await p.evaluate(() => {
        const b = document.querySelector('button.job-dismiss[data-key="chat:s-r3"]');
        return { opacity: getComputedStyle(b).opacity, label: b.getAttribute("aria-label"), key: document.querySelector('.job-row[data-key="chat:s-r3"]').getAttribute("aria-keyshortcuts") };
      });
      if (x.opacity !== "1" || x.label !== "Dismiss Find cheap flights to Lisbon" || x.key !== "Delete") fail(`dismiss: the row's ✕ ${JSON.stringify(x)}`);
      if (await p.evaluate(() => getComputedStyle(document.querySelector('button.job-dismiss[data-key="task:t5"]')).opacity) !== "0") fail("dismiss: ✕ shows on a row not hovered");
      if (await p.$('button.job-dismiss[data-key="task:t3"]')) fail("dismiss: an upcoming job has ✕");
      await checkLayout(p, `dismiss-hover ${label}`);
      await shoot(p, "panel-list-dismiss-hover", size, scheme);
      await p.click('button.job-dismiss[data-key="chat:s-r3"]');
      const moved = await p.evaluate(() => {
        const r = document.querySelector('.job-row[data-key="chat:s-r3"]');
        return { group: r.closest(".job-group").querySelector(".group-head").firstChild.textContent, state: r.dataset.state, meta: r.querySelector(".job-meta")?.textContent, notice: document.querySelector("#now-notice .notice-text")?.textContent };
      });
      if (JSON.stringify(moved) !== JSON.stringify({ group: "Recent", state: "dismissed", meta: "Needs you to pick dates", notice: "Dismissed “Find cheap flights to Lisbon”" })) fail(`dismiss: ✕ ${JSON.stringify(moved)}`);
      if ((await sent()).length) fail("dismiss: kept before Undo's time was over");
      await p.mouse.move(0, 0);
      await checkLayout(p, `dismiss-undo ${label}`);
      await shoot(p, "panel-list-dismiss-undo", size, scheme);

      // Delete on the focused row: the one before is kept now, the focus goes to the next row.
      await p.focus('.job-row[data-key="task:t5"]');
      await p.keyboard.press("Delete");
      const after = await p.evaluate(() => ({ focus: document.activeElement?.dataset?.key ?? null, needs: document.querySelector('section[aria-labelledby="group-needs"]') !== null }));
      if (after.needs || after.focus !== "chat:s-r1") fail(`dismiss: after Delete ${JSON.stringify(after)}`);
      const first = await sent();
      if (first.length !== 1 || !first[0]["chat:s-r3"]?.needs?.startsWith("run:s-r3:")) fail(`dismiss: kept ${JSON.stringify(first)}`);
      // The panel going away keeps what waits.
      await p.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await p.waitForFunction(() => window.__requests.filter((r) => r.type === "jobs.dismiss").length === 2);
      const second = (await sent())[1];
      if (!second["task:t5"]?.needs?.startsWith("task:t5:")) fail(`dismiss: Delete kept ${JSON.stringify(second)}`);

      // A Recent job dismissed leaves the list; a search finds it.
      await p.focus('.job-row[data-key="chat:s-r2"]');
      await p.keyboard.press("Backspace");
      if ((await recent()).includes("chat:s-r2")) fail("dismiss: a Recent job put away is still listed");
      await p.fill("#job-search", "chrome web store");
      await p.waitForFunction(() => !!document.querySelector('.job-row[data-key="chat:s-r2"]'));
      reportErrors(p, `dismiss ${label}`);
      await p.close();
    },
  },
  // The two views: Home (Needs you, Running, Upcoming cut to its soonest 3 with "All scheduled (N) →", Recent) and
  // Scheduled (every scheduled job, soonest first, paused last, each with Pause or Resume), switched by a segmented
  // control beside the search (a tablist: Left and Right); the search filters the view shown; the panel keeps the view.
  {
    names: ["panel-home", "panel-scheduled", "panel-scheduled-search"],
    async run({ ctx, size, scheme, label, fail, groups, openPanel, openJob, backToList, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "views");
      const bar = await p.evaluate(() => {
        const tabs = [...document.querySelectorAll("#job-views [role=tab]")];
        const search = document.getElementById("job-search").getBoundingClientRect();
        const seg = document.getElementById("job-views").getBoundingClientRect();
        return {
          role: document.getElementById("job-views").getAttribute("role"),
          tabs: tabs.map((t) => [t.textContent, t.getAttribute("aria-selected"), t.tabIndex]),
          panel: document.getElementById("job-groups").getAttribute("aria-labelledby"),
          searchWidth: Math.round(search.width),
          sameLine: Math.abs((search.top + search.bottom) / 2 - (seg.top + seg.bottom) / 2) <= 2,
        };
      });
      if (bar.role !== "tablist" || JSON.stringify(bar.tabs) !== JSON.stringify([["Home", "true", 0], ["Scheduled", "false", -1]]) || bar.panel !== "view-home") fail(`views: the switch ${JSON.stringify(bar)}`);
      if (!bar.sameLine || bar.searchWidth < (size.w <= 360 ? 150 : 250)) fail(`views: the bar ${JSON.stringify(bar)}`);

      // Home: every group; Upcoming its soonest 3 and the way to the rest; the job paused by the user is not here, the
      // one paused after failures needs the user.
      const home = await groups(p);
      const names = home.map(([n]) => n).join();
      const upcoming = home.find(([n]) => n === "Upcoming")?.[1] ?? [];
      const needs = home.find(([n]) => n === "Needs you")?.[1] ?? [];
      if (names !== "Needs you,Running,Upcoming,Recent" || upcoming.length !== 3 || !needs.includes("task:t11") || home.some(([, keys]) => keys.includes("task:t10"))) fail(`views: Home ${JSON.stringify(home)}`);
      const all = await p.evaluate(() => ({ text: document.querySelector(".all-scheduled")?.textContent, count: document.querySelector("#group-scheduled .count")?.textContent }));
      if (all.text !== "All scheduled (8) →" || all.count !== "5") fail(`views: Upcoming's way to the rest ${JSON.stringify(all)}`);
      await checkLayout(p, `home ${label}`);
      await shoot(p, "panel-home", size, scheme);

      // "All scheduled": the Scheduled view, its tab selected; soonest first, the paused ones last with Resume.
      await p.click(".all-scheduled");
      await p.waitForSelector('#view-scheduled[aria-selected="true"]');
      const sched = await groups(p);
      const next = sched.find(([n]) => n === "Next runs")?.[1] ?? [];
      if (JSON.stringify(sched.map(([n]) => n)) !== JSON.stringify(["Next runs", "Paused"]) || next.length !== 6 || next.includes("task:t2") || JSON.stringify(sched[1][1]) !== JSON.stringify(["task:t11", "task:t10"])) fail(`views: Scheduled ${JSON.stringify(sched)}`);
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll("#job-groups li")].map((li) => ({
          key: li.querySelector(".job-row").dataset.key,
          meta: li.querySelector(".job-meta")?.textContent ?? "",
          when: li.querySelector(".job-when").textContent,
          toggle: li.querySelector(".job-toggle")?.textContent ?? null,
          toggleName: li.querySelector(".job-toggle")?.getAttribute("aria-label") ?? null,
        })),
      );
      const row = (k) => rows.find((r) => r.key === k);
      if (row("task:t10")?.toggle !== "Resume" || row("task:t10")?.when !== "Paused" || row("task:t1")?.toggle !== "Pause" || !/^Daily at /.test(row("task:t1")?.meta ?? "") || row("task:t9")?.meta !== "Once" || row("task:t5")?.toggle !== null) fail(`views: Scheduled rows ${JSON.stringify(rows)}`);
      if (!/^Once · Paused after 3 failed runs/.test(row("task:t11")?.meta ?? "") && !/Paused after 3 failed runs/.test(row("task:t11")?.meta ?? "")) fail(`views: failing row ${JSON.stringify(row("task:t11"))}`);
      if (!row("task:t1")?.toggleName?.startsWith("Pause ")) fail(`views: toggle name ${JSON.stringify(row("task:t1"))}`);
      await checkLayout(p, `scheduled ${label}`);
      await shoot(p, "panel-scheduled", size, scheme);

      // Pause on a row: the job moves to the paused ones, with Resume.
      await p.click('li:has(.job-row[data-key="task:t1"]) .job-toggle');
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.pause" && r.id === "t1"));
      await p.waitForFunction(() => document.querySelector('#group-paused')?.closest("section")?.querySelector('.job-row[data-key="task:t1"]'));
      if ((await p.textContent('li:has(.job-row[data-key="task:t1"]) .job-toggle')) !== "Resume") fail("views: a paused row offers no Resume");
      await p.click('li:has(.job-row[data-key="task:t1"]) .job-toggle');
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.resume" && r.id === "t1"));

      // The keyboard: Left and Right move between the views, which show at once.
      await p.focus("#view-scheduled");
      await p.keyboard.press("ArrowLeft");
      const left = await p.evaluate(() => ({ focus: document.activeElement?.id, home: document.getElementById("view-home").getAttribute("aria-selected") }));
      await p.keyboard.press("ArrowRight");
      const right = await p.evaluate(() => ({ focus: document.activeElement?.id, sched: document.getElementById("view-scheduled").getAttribute("aria-selected") }));
      if (left.focus !== "view-home" || left.home !== "true" || right.focus !== "view-scheduled" || right.sched !== "true") fail(`views: arrows ${JSON.stringify({ left, right })}`);

      // The search filters the view shown.
      await p.fill("#job-search", "tip");
      const found = await groups(p);
      if (JSON.stringify(found) !== JSON.stringify([["Paused", ["task:t10"]]])) fail(`views: search "tip" in Scheduled ${JSON.stringify(found)}`);
      await checkLayout(p, `scheduled search ${label}`);
      await shoot(p, "panel-scheduled-search", size, scheme);
      await p.fill("#job-search", "");

      // The panel keeps the view: back from a job, and in its session storage.
      await openJob(p, "task:t9");
      await backToList(p);
      const kept = await p.evaluate(() => ({ sel: document.getElementById("view-scheduled").getAttribute("aria-selected"), stored: sessionStorage.getItem("browsertodo.jobs.view") }));
      if (kept.sel !== "true" || kept.stored !== "scheduled") fail(`views: kept ${JSON.stringify(kept)}`);
      reportErrors(p, `views ${label}`);
      await p.close();
    },
  },
];
