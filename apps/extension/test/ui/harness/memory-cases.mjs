// The agent's memory in the UI harness: Settings > Memory (entries by kind, task history grouped by task with its
// records by key, search, edit, delete, delete a task's memory, the switches, Forget everything, the question after
// signing in to another account) at 360, 420 and 1280 px in light and dark, and in the side panel the chat's
// "Remembered" notes with Undo, the composer menu's Memory switch (off for a chat shows a badge; a new chat carries
// the choice) and the TODO tab's "Add this computer's memory to <account>?".
import { eventually, shown } from "./checks.mjs";

const SCHEMES = ["light", "dark"];
/** Settings > Memory is checked at a phone-like width too (the options page opens in a tab of any size). */
export const MEMORY_OPT_SIZES = [
  { w: 360, h: 900 },
  { w: 420, h: 900 },
  { w: 1280, h: 1000 },
];

const iso = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const DAY = 24 * 60;
const chat = (title) => ({ kind: "chat", sessionId: "s-mem", title });

const INBOX = "Answer each new message in the shared inbox";
const inbox = (e) => ({ kind: "task", scope: "task", taskKey: "tk2", taskTitle: INBOX, source: { kind: "task", title: INBOX }, ...e });

/**
 * What the agent keeps: every kind, a long text, a long site name, an entry never used, a task's run notes, and a
 * task that works through many things with its records by key (examples only: two addresses and an ID).
 */
export function memoryEntries() {
  return [
    { id: "m1", kind: "preference", subject: "Sign-off", text: "Sign emails “— Jae” with no other closing line.", scope: "global", source: chat("Reply to Jordan"), learnedAt: iso(-9 * DAY), updatedAt: iso(-9 * DAY), lastUsedAt: iso(-60) },
    { id: "m2", kind: "preference", subject: "Posting hours", text: "Never post on X before 8am in the user's time zone.", scope: "global", source: { kind: "user" }, learnedAt: iso(-20 * DAY), updatedAt: iso(-20 * DAY) },
    { id: "m3", kind: "account", subject: "Work email", text: "admin@runhq.io is the work email: Google account /u/2 (https://mail.google.com/mail/u/2/).", scope: "global", source: chat("Check my work inbox"), learnedAt: iso(-3 * DAY), updatedAt: iso(-3 * DAY), lastUsedAt: iso(-30) },
    { id: "m4", kind: "account", subject: "@mecharoyalecom", text: "The X account for the game Mecha Royale; switch to it for game posts.", scope: "global", source: chat("Post the patch notes"), learnedAt: iso(-5 * DAY), updatedAt: iso(-2 * DAY) },
    { id: "m5", kind: "person", subject: "Paul Lee", text: "The user's accountant (paul@leeandco.example).", scope: "global", source: chat("Send the invoices"), learnedAt: iso(-12 * DAY), updatedAt: iso(-12 * DAY) },
    { id: "m6", kind: "playbook", subject: "Compose", text: "Press C to open a new message; the send button is at the bottom left of the draft, not in the toolbar.", scope: "domain", domain: "mail.google.com", source: chat("Reply to Jordan"), learnedAt: iso(-9 * DAY), updatedAt: iso(-DAY), lastUsedAt: iso(-60) },
    { id: "m7", kind: "playbook", subject: "Sign-in", text: "Asks to sign in again each morning: pause and ask the user.", scope: "domain", domain: "partner-portal.enterprise-billing.example.co.uk", source: chat("Download the invoice"), learnedAt: iso(-4 * DAY), updatedAt: iso(-4 * DAY) },
    { id: "m8", kind: "task", subject: "Run note", text: "Posted the tip about the new arena map. Next: the ranked season.", scope: "task", taskKey: "tk1", taskTitle: "Post one tip about Mecha Royale on X", source: { kind: "task", title: "Post one tip about Mecha Royale on X" }, learnedAt: iso(-DAY), updatedAt: iso(-DAY) },
    { id: "m9", kind: "task", subject: "Run note", text: "Posted the tip about daily quests.", scope: "task", taskKey: "tk1", taskTitle: "Post one tip about Mecha Royale on X", source: { kind: "task", title: "Post one tip about Mecha Royale on X" }, learnedAt: iso(-2 * DAY), updatedAt: iso(-2 * DAY) },
    inbox({ id: "m10", subject: "Run note", text: "Answered 4 messages; 2 wait for the user.", learnedAt: iso(-180), updatedAt: iso(-180) }),
    inbox({
      id: "r1", subject: "Ada.Lee@example.com", key: "ada.lee@example.com", text: "Prefers email over calls; writes about the March invoice.",
      notes: [{ at: iso(-3 * DAY), text: "Resent the March invoice." }, { at: iso(-200), text: "Asked for a receipt too; sent it." }],
      learnedAt: iso(-9 * DAY), updatedAt: iso(-200), lastUsedAt: iso(-190),
    }),
    inbox({ id: "r2", subject: "sam.ortiz@example.com", key: "sam.ortiz@example.com", text: "Books the offsite; wants dates confirmed a week ahead.", learnedAt: iso(-4 * DAY), updatedAt: iso(-4 * DAY) }),
    inbox({ id: "r3", subject: "#48213", key: "48213", text: "Refund asked on the 20th; sent on the 22nd.", learnedAt: iso(-6 * DAY), updatedAt: iso(-5 * DAY) }),
  ];
}

/** A task with many records (more than one page of them in Settings): examples only, numbered items. */
export function manyRecords(n = 120) {
  const title = "Check every open order on the shop dashboard and update its status";
  return Array.from({ length: n }, (_, i) => ({
    id: `q${i}`, kind: "task", scope: "task", taskKey: "tk3", taskTitle: title, source: { kind: "task", title },
    subject: `#${50000 + i}`, key: String(50000 + i), text: `Status checked; ${i % 3 ? "shipped" : "waiting for stock"}.`,
    learnedAt: iso(-10 * DAY + i), updatedAt: iso(-10 * DAY + i),
  }));
}

const requests = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t), type);

/** Nothing in a memory box reaches past it (text, buttons, the editor), at this width. */
const clippedInBoxes = (p) =>
  p.evaluate(() => {
    const out = [];
    for (const box of document.querySelectorAll("#panel-memory .box")) {
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("button, input, textarea, .mem-text, .mem-subject, .mem-where, .mem-meta")) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > b.right + 0.5 || r.left < b.left - 0.5) out.push(`${el.className || el.tagName} ${el.textContent.slice(0, 30)}`);
      }
    }
    return out;
  });

async function openMemory(h, size, scheme, edit = (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "on", lastSyncAt: iso(-5) }))) {
  const p = await h.openOptions(size, scheme, "ok", "#memory", edit);
  await p.waitForSelector("#memory-kinds .mem-kind");
  return p;
}

/** Settings > Memory at every size and scheme, then its interactions once. */
export async function runMemoryOptions(h) {
  for (const scheme of SCHEMES) {
    for (const size of MEMORY_OPT_SIZES) {
      if (h.want("options-memory", size, scheme)) {
        const p = await openMemory(h, size, scheme);
        await p.waitForSelector("#memory-kinds .mem-entry");
        await h.optChecks(p, `memory ${size.w} ${scheme}`, [
          ["the Memory tab is shown", async () => (await p.getAttribute("#tab-memory", "aria-selected")) === "true" && (await shown(p, "#panel-memory"))],
          ["five kinds in order", async () => (await p.$$eval(".mem-kind", (els) => els.map((e) => e.dataset.kind).join())) === "preference,account,person,playbook,task"],
          ["every entry listed", async () => (await p.locator(".mem-entry").count()) === 13],
          ["counts per kind", async () => (await p.$$eval(".mem-kind-head .mem-count", (els) => els.map((e) => e.textContent).join())) === "2,2,1,2,6"],
          ["memory and every kind on", async () => (await p.isChecked("#memory-on")) && (await p.$$eval(".mem-kind input[role=switch]", (els) => els.every((e) => e.checked)))],
          ["a playbook says its site", async () => (await p.textContent('.mem-entry[data-id="m6"] .mem-where')) === "mail.google.com"],
          ["task history grouped by task, newest first, collapsed, with counts", async () =>
            JSON.stringify(await p.$$eval(".mem-task", (els) => els.map((e) => [e.dataset.task, e.open, e.querySelector(".mem-task-head .mem-count").textContent]))) ===
            JSON.stringify([["tk2", false, "1 run note · 3 records"], ["tk1", false, "2 run notes"]])],
          ["the search box shows", async () => shown(p, "#memory-search")],
          ["where it came from and when it was used", async () => /^Learned .* · used .* · from “Reply to Jordan”$/.test(await p.textContent('.mem-entry[data-id="m1"] .mem-meta'))],
          ["never used says so", async () => /not used yet · added by you$/.test(await p.textContent('.mem-entry[data-id="m2"] .mem-meta'))],
          ["no empty note", async () => !(await shown(p, "#memory-empty"))],
          ["says it syncs with the account", async () => /^Synced with your account, last /.test(await p.textContent("#memory-sync"))],
          ["nothing clipped", async () => (await clippedInBoxes(p)).length === 0],
          ["Edit and Delete named for readers", async () => (await p.getAttribute('.mem-entry[data-id="m5"] button', "aria-label")) === "Edit Paul Lee"],
        ]);
        await h.optShot(p, "options-memory", size, scheme);
        await p.ctx.close();
      }
      if (size.w === 420 && h.want("options-memory-empty", size, scheme)) {
        const p = await openMemory(h, size, scheme, (d) => ((d.memory = []), (d.memorySync = { state: "no-plan" })));
        await h.optChecks(p, `memory empty ${scheme}`, [
          ["says it is kept on this computer only, and how to sync it", async () => /^Kept on this computer only\. With a paid plan it syncs/.test(await p.textContent("#memory-sync"))],
          ["says nothing is kept yet", async () => eventually(() => shown(p, "#memory-empty"))],
          ["each kind says nothing yet", async () => (await p.locator(".mem-none").allTextContents()).every((t) => t === "Nothing yet.")],
        ]);
        await h.optShot(p, "options-memory-empty", size, scheme);
        await p.ctx.close();
      }
      if (size.w === 420 && h.want("options-memory-ask", size, scheme)) {
        const p = await openMemory(h, size, scheme, (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "ask", account: "bob@example.com" })));
        await h.optChecks(p, `memory ask ${scheme}`, [
          ["asks whether to add this computer's memory", async () => /^Add this computer's memory to bob@example\.com\? Nothing is sent until you choose\.$/.test(await p.textContent("#memory-sync"))],
          ["with Keep separate and Add", async () => (await p.$$eval("#memory-sync-actions button", (els) => els.map((e) => e.textContent).join())) === "Keep separate,Add"],
          ["and what each means", async () => /Keep separate: it stays on this computer only/.test(await p.textContent("#memory-sync-actions .mem-sync-hint"))],
          ["nothing clipped", async () => (await clippedInBoxes(p)).length === 0],
        ]);
        await h.optShot(p, "options-memory-ask", size, scheme);
        await p.ctx.close();
      }
    }
  }
  for (const flow of MEMORY_FLOWS) if (h.want(flow.name, flow.size, flow.scheme)) await flow.run(h);
}

const MEMORY_FLOWS = [
  // Edit (and a refused edit), delete, a kind's switch, pausing memory, and Forget everything asked twice.
  {
    name: "options-memory-edit",
    size: { w: 360 },
    scheme: "light",
    async run(h) {
      const size = { w: 360, h: 900 };
      const p = await openMemory(h, size, "light");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click('.mem-entry[data-id="m5"] button:has-text("Edit")');
      await p.waitForSelector("#memory-edit-text-m5");
      check("the editor has the entry", (await p.inputValue("#memory-edit-subject-m5")) === "Paul Lee" && /accountant/.test(await p.inputValue("#memory-edit-text-m5")));
      check("the subject field has the focus", await p.evaluate(() => document.activeElement?.id === "memory-edit-subject-m5"));
      check("the editor fits", (await clippedInBoxes(p)).length === 0);
      // A refused edit (it looks like a secret) says why and keeps the editor.
      await p.evaluate(() => (window.__refuse = { "memory.edit": "Not saved: it contains what looks like a password, PIN or one-time code." }));
      await p.fill("#memory-edit-text-m5", "PIN: 4821");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("a refusal shows in the editor", await eventually(async () => /one-time code/.test((await p.textContent(".mem-problem")) ?? "")));
      await h.optShot(p, "options-memory-edit", size, "light");
      await p.evaluate(() => (window.__refuse = {}));
      await p.fill("#memory-edit-text-m5", "The user's accountant since 2020.");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("saved: the row shows the new text", await eventually(async () => (await p.textContent('.mem-entry[data-id="m5"] .mem-text')) === "The user's accountant since 2020."));
      check("the edit was sent", (await requests(p, "memory.edit")).some((r) => r.id === "m5" && r.subject === "Paul Lee" && /since 2020/.test(r.text)));

      await p.click('.mem-entry[data-id="m7"] .mem-delete');
      check("delete removes the row", await eventually(async () => (await p.locator('.mem-entry[data-id="m7"]').count()) === 0));
      check("and says so", /Deleted “Sign-in”/.test(await p.textContent("#memory-msg")));

      await p.click('label[for="memory-kind-person"]');
      check("a kind's switch saves the kinds that are off", await eventually(async () => (await requests(p, "settings.save")).some((r) => JSON.stringify(r.settings.memoryKindsOff) === '["person"]')));
      check("the kind says it is off", await eventually(async () => /^Off:/.test(await p.textContent("#memory-kind-person-hint"))));
      check("its switch keeps the focus", await p.evaluate(() => document.activeElement?.id === "memory-kind-person"));

      await p.click('label[for="memory-on"]');
      check("Use memory off pauses it", await eventually(async () => (await requests(p, "settings.save")).some((r) => r.settings.memoryPaused === true)));
      check("paused says what it means", await eventually(() => shown(p, "#memory-paused-note")));
      await h.optShot(p, "options-memory-paused", size, "light");

      await p.click("#memory-forget");
      check("Forget everything asks first", /Forget all 12 memories\? This can't be undone\./.test(await p.textContent("#memory-forget-question")));
      check("nothing forgotten yet", (await requests(p, "memory.clear")).length === 0);
      await h.optShot(p, "options-memory-forget", size, "light");
      await p.click("#memory-forget-cancel");
      check("Cancel leaves it", (await p.textContent("#memory-forget")) === "Forget everything" && (await p.locator(".mem-entry").count()) === 12);
      await p.click("#memory-forget");
      await p.click("#memory-forget");
      check("confirmed: everything forgotten", await eventually(async () => (await requests(p, "memory.clear")).length === 1 && (await p.locator(".mem-entry").count()) === 0));
      check("the empty note shows", await eventually(() => shown(p, "#memory-empty")));
      await h.optChecks(p, "memory flows", checks);
      await p.ctx.close();
    },
  },
  // A task's records: open its group, its dated notes, Show more, search, edit a record, delete the task's memory.
  {
    name: "options-memory-tasks",
    size: { w: 420 },
    scheme: "light",
    async run(h) {
      const size = { w: 420, h: 900 };
      const p = await openMemory(h, size, "light", (d) => ((d.memory = [...memoryEntries(), ...manyRecords()]), (d.memorySync = { state: "on", lastSyncAt: iso(-5) })));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      await p.click('.mem-task[data-task="tk2"] > summary');
      await p.waitForSelector('.mem-task[data-task="tk2"][open] .mem-entry[data-id="r1"]');
      check("an open task lists its run notes, then its records", (await p.$$eval('.mem-task[data-task="tk2"] .mem-sub', (els) => els.map((e) => e.textContent).join())) === "Run notes,Records by key");
      check("records newest first", (await p.$$eval('.mem-task[data-task="tk2"] .mem-records .mem-entry', (els) => els.map((e) => e.dataset.id).join())) === "r1,r2,r3");
      check("a record shows its dated notes", /Asked for a receipt too; sent it\./.test(await p.textContent('.mem-entry[data-id="r1"] .mem-notes')));
      check("nothing clipped", (await clippedInBoxes(p)).length === 0);
      await h.optShot(p, "options-memory-task-open", size, "light");

      await p.click('.mem-task[data-task="tk3"] > summary');
      await p.waitForSelector('.mem-task[data-task="tk3"][open] .mem-more');
      check("a long task shows one page of records", (await p.locator('.mem-task[data-task="tk3"] .mem-records .mem-entry').count()) === 50);
      check("and says how many more there are", (await p.textContent('.mem-task[data-task="tk3"] .mem-more')) === "Show 50 more of 70");
      await p.click('.mem-task[data-task="tk3"] .mem-more');
      check("Show more adds a page", await eventually(async () => (await p.locator('.mem-task[data-task="tk3"] .mem-records .mem-entry').count()) === 100));
      check("the group stays open", await p.evaluate(() => document.querySelector('.mem-task[data-task="tk3"]').open));

      await p.fill("#memory-search", "ADA lee");
      check("search narrows to what matches, case aside", await eventually(async () => (await p.textContent("#memory-found")) === "1 match"));
      check("the task with the match opens", await p.evaluate(() => document.querySelector('.mem-task[data-task="tk2"]').open && !document.querySelector('.mem-task[data-task="tk1"]')));
      check("other kinds say no matches", (await p.locator(".mem-none").allTextContents()).every((t) => t === "No matches."));
      check("the task's delete still counts all it keeps", (await p.textContent('.mem-task[data-task="tk2"] .mem-task-delete')) === "Delete this task's memory");
      await h.optShot(p, "options-memory-search", size, "light");
      await p.fill("#memory-search", "");
      check("clearing the search lists everything again", await eventually(async () => (await p.locator(".mem-task").count()) === 3));

      await p.click('.mem-entry[data-id="r2"] button:has-text("Edit")');
      await p.fill("#memory-edit-text-r2", "Books the offsite; confirm dates two weeks ahead.");
      await p.click('.mem-entry.editing button:has-text("Save")');
      check("a record is edited like any entry", await eventually(async () => (await requests(p, "memory.edit")).some((r) => r.id === "r2" && /two weeks/.test(r.text))));

      await p.click('.mem-task[data-task="tk2"] .mem-task-delete');
      check("deleting a task's memory asks first", /^Delete everything this task keeps \(4 entries\)\? This can't be undone\.$/.test(await p.textContent('.mem-task[data-task="tk2"] .mem-question')));
      check("nothing deleted yet", (await requests(p, "memory.deleteTask")).length === 0);
      await h.optShot(p, "options-memory-task-delete", size, "light");
      await p.click('.mem-task[data-task="tk2"] .mem-task-delete');
      check("confirmed: the task's memory goes", await eventually(async () => (await requests(p, "memory.deleteTask")).some((r) => r.taskKey === "tk2") && (await p.locator('.mem-task[data-task="tk2"]').count()) === 0));
      check("and says so", /^Deleted 4 entries of “Answer each new message/.test(await p.textContent("#memory-msg")));
      check("other tasks stay", (await p.locator(".mem-task").count()) === 2);
      await h.optChecks(p, "memory task flows", checks);
      await p.ctx.close();
    },
  },
  // Signed in to another account: Add sends this computer's memory there; then it says it syncs.
  {
    name: "options-memory-ask-add",
    size: { w: 420 },
    scheme: "light",
    async run(h) {
      const p = await openMemory(h, { w: 420, h: 900 }, "light", (d) => ((d.memory = memoryEntries()), (d.memorySync = { state: "ask", account: "bob@example.com" })));
      await p.click("#memory-sync-add");
      await h.optChecks(p, "memory ask add", [
        ["Add answers the question", async () => eventually(async () => (await requests(p, "memory.syncChoice")).some((r) => r.add === true))],
        ["then it syncs", async () => eventually(async () => /^Synced with your account/.test(await p.textContent("#memory-sync")))],
        ["and the buttons go", async () => eventually(async () => !(await shown(p, "#memory-sync-actions")))],
      ]);
      await p.ctx.close();
    },
  },
];

/** The chat's memory notes and the composer's Memory switch, at each panel size and scheme. */
export const MEMORY_PANEL_CASES = [
  {
    names: ["panel-memory", "panel-memory-undone", "panel-memory-menu", "panel-memory-off"],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors }) {
      const entries = memoryEntries();
      const p = await openPanel(ctx, "idle", "#chat-log .ev-memory", {
        edit: (d) => {
          const conv = {
            sessionId: "s-mem", source: "adhoc", title: "Check my work inbox", instructions: "Check my work inbox and tell me what needs a reply",
            brain: "claude-api", jev: true, model: "claude-sonnet-5", startedAt: iso(-2), firstStartedAt: iso(-2), endedAt: iso(0), outcome: "done", summary: "Checked the work inbox",
          };
          const ev = (m, e) => ({ ...e, ts: iso(m), sessionId: "s-mem" });
          const work = entries.find((e) => e.id === "m3");
          const compose = entries.find((e) => e.id === "m6");
          d.sessions.unshift(conv);
          d.eventsBySession["s-mem"] = [
            ev(-2, { type: "status", text: "Claude API (claude-sonnet-5) with Jev" }),
            ev(-2, { type: "tool_call", id: "1", name: "navigate", args: { url: "https://mail.google.com/mail/u/2/" } }),
            ev(-2, { type: "tool_result", id: "1", name: "navigate", text: "Navigated to https://mail.google.com/mail/u/2/\nTitle: Inbox - admin@runhq.io - Gmail" }),
            ev(-1, { type: "tool_call", id: "2", name: "remember", args: { kind: "account", subject: work.subject, text: work.text } }),
            ev(-1, { type: "memory", changeId: "c1", before: null, after: work }),
            ev(-1, { type: "tool_result", id: "2", name: "remember", text: "Remembered [m3] Work email. The user sees it in the chat with Undo." }),
            ev(-1, { type: "memory", changeId: "c2", before: { ...compose, text: "The send button is in the toolbar." }, after: compose }),
            ev(0, { type: "assistant_text", text: "Two emails need a reply: **Jordan Lee** (contract renewal, by Friday) and **Sam Ortiz** (offsite dates)." }),
            ev(0, { type: "task_end", outcome: "done", summary: conv.summary }),
          ];
          d.state.tabChats = { 1: "s-mem" };
          d.memory = entries;
        },
      });
      const notes = () =>
        p.evaluate(() =>
          [...document.querySelectorAll("#chat-log .ev-memory")].map((n) => {
            const line = n.querySelector(".mem-line");
            const kids = [...line.children].filter((k) => k.getBoundingClientRect().width);
            const tops = kids.map((k) => k.getBoundingClientRect().top + k.getBoundingClientRect().height / 2);
            return {
              line: line.textContent,
              oneLine: Math.max(...tops) - Math.min(...tops) < 4,
              inside: n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= document.getElementById("chat-log").getBoundingClientRect().right + 1,
              buttons: [...n.querySelectorAll("button")].map((b) => b.textContent),
              undone: n.classList.contains("undone"),
              title: line.title,
            };
          }),
        );
      const got = await notes();
      if (got.length !== 2) fail(`memory notes: ${got.length}`);
      if (!got[0]?.line.startsWith("Remembered:Work email· admin@runhq.io")) fail(`remembered line "${got[0]?.line}"`);
      if (!got[1]?.line.startsWith("Updated memory:Compose· Press C")) fail(`updated line "${got[1]?.line}"`);
      if (!got.every((n) => n.oneLine && n.inside)) fail(`memory note layout ${JSON.stringify(got)}`);
      if (!got.every((n) => n.buttons.join() === "Undo")) fail(`memory note buttons ${JSON.stringify(got.map((n) => n.buttons))}`);
      if (!/^Accounts\nWork email: admin@runhq.io/.test(got[0]?.title ?? "") || !/Was: The send button is in the toolbar\.$/.test(got[1]?.title ?? "")) fail("memory note tooltips");
      await checkLayout(p, `memory ${label}`);
      await shoot(p, "panel-memory", size, scheme);

      // Undo: the change is undone (the background pushes memory_undone) and the note says so, without a button.
      await p.click("#chat-log .ev-memory .mem-undo");
      await p.waitForSelector("#chat-log .ev-memory.undone");
      const sent = (await requests(p, "memory.undo"))[0];
      if (sent?.sessionId !== "s-mem" || sent.changeId !== "c1") fail(`undo sent ${JSON.stringify(sent)}`);
      const [u] = await notes();
      if (!u.undone || u.buttons.length || !u.line.startsWith("Undone:")) fail(`undone note ${JSON.stringify(u)}`);
      if ((await p.textContent("#chat-log .ev-memory.undone .mem-note")) !== "Not kept.") fail("undone note text");
      await checkLayout(p, `memory-undone ${label}`);
      await shoot(p, "panel-memory-undone", size, scheme);

      // The composer's menu: Memory on for this chat; turning it off tells the background and shows the badge.
      await p.click("#now-model");
      await p.waitForSelector("#model-menu .mm-memory");
      const item = () => p.evaluate(() => {
        const b = document.querySelector("#model-menu .mm-memory");
        return { checked: b.getAttribute("aria-checked"), hint: b.querySelector(".mm-hint").textContent, disabled: b.disabled };
      });
      const before = await item();
      if (before.checked !== "true" || before.disabled) fail(`menu switch ${JSON.stringify(before)}`);
      await p.click("#model-menu .mm-memory");
      const off = await eventually(async () => (await item()).checked === "false");
      if (!off || (await item()).hint !== "Off in this chat") fail(`menu switch after click ${JSON.stringify(await item())}`);
      const setOff = (await requests(p, "chat.setMemory"))[0];
      if (setOff?.sessionId !== "s-mem" || setOff.on !== false) fail(`chat.setMemory ${JSON.stringify(setOff)}`);
      await checkLayout(p, `memory-menu ${label}`);
      await shoot(p, "panel-memory-menu", size, scheme);
      await p.keyboard.press("Escape");
      if (!(await eventually(() => shown(p, "#now-memory-off")))) fail("no memory-off badge");
      await checkLayout(p, `memory-off ${label}`);
      await shoot(p, "panel-memory-off", size, scheme);
      // The badge turns memory back on.
      await p.click("#now-memory-off");
      if (!(await eventually(async () => (await requests(p, "chat.setMemory")).some((r) => r.on === true)))) fail("badge did not turn memory on");
      if (!(await eventually(async () => !(await shown(p, "#now-memory-off"))))) fail("badge still shown");

      // A new chat (tab 2): the choice waits for its first message, which carries it.
      await p.evaluate(() => window.__activateTab(2));
      await p.waitForSelector("#chat-log .chat-empty");
      await p.click("#now-model");
      await p.click("#model-menu .mm-memory");
      if ((await item()).hint !== "Off for this new chat") fail(`new chat hint ${(await item()).hint}`);
      await p.keyboard.press("Escape");
      await p.fill("#now-text", "What's on my calendar today?");
      await p.press("#now-text", "Enter");
      const adhoc = await eventually(async () => (await requests(p, "run.adhoc")).some((r) => r.memoryOff === true));
      if (!adhoc) fail(`new chat did not carry memory off ${JSON.stringify(await requests(p, "run.adhoc"))}`);
      reportErrors(p, `memory ${label}`);
      await p.close();
    },
  },
  // Signed in to another account than this computer's memory was synced with: the TODO tab asks what to do with it.
  {
    names: ["panel-memory-ask"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, checkLayout, reportErrors }) {
      const p = await openPanel(ctx, "account", ".chat-empty", { edit: (d) => (d.state = { ...d.state, memoryQuestion: { account: "ada.lovelace@example.com" } }) });
      await p.click("#tab-btn-todo");
      await p.waitForSelector("#memory-ask:not([hidden])");
      const card = await p.evaluate(() => ({
        text: document.getElementById("memory-ask-text").textContent,
        hint: document.getElementById("memory-ask-hint").textContent,
        buttons: [...document.querySelectorAll("#memory-ask button")].map((b) => b.textContent).join(),
      }));
      if (card.text !== "Add this computer's memory to ada.lovelace@example.com?") fail(`memory question "${card.text}"`);
      if (!/^What the agent learned on this computer goes to that account/.test(card.hint)) fail(`memory question hint "${card.hint}"`);
      if (card.buttons !== "Keep separate,Add") fail(`memory question buttons ${card.buttons}`);
      await checkLayout(p, `memory-ask ${label}`);
      await shoot(p, "panel-memory-ask", size, scheme);
      await p.click("#memory-ask-keep");
      if (!(await eventually(async () => (await requests(p, "memory.syncChoice")).some((r) => r.add === false)))) fail("Keep separate not sent");
      if (!(await eventually(async () => !(await shown(p, "#memory-ask"))))) fail("memory question still shown after the answer");
      if (!(await eventually(async () => /stays separate from ada\.lovelace@example\.com/.test(await p.textContent("#tasks-msg"))))) fail("no word after Keep separate");
      reportErrors(p, `memory-ask ${label}`);
      await p.close();
    },
  },
];
