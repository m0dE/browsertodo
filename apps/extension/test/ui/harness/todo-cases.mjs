// The TODO tab's cases of the UI harness: the rows (Run / Stop, the schedule in words, Run due (N)), and the
// add/edit form with its schedule section (packages/shared ui/schedule-fields.ts): once, daily at two times,
// weekly Mon/Wed/Fri, monthly on the first Monday, a custom cron, an end date, and editing a task. Each form
// case is screenshotted (the form itself) at every panel size and scheme, and checks what the form sends.
import { join } from "node:path";

/** "YYYY-MM-DD" `days` from today, in this machine's zone (the browser's too). */
function dateIn(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The requests of `type` the page sent. */
const sent = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t), type);

/** Nothing in the form (or in a task row) reaches past its box: no clipped control at this width. */
async function checkForm(p, fail, what) {
  const out = await p.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push("horizontal page scroll");
    const boxes = [...document.querySelectorAll("#add-form:not([hidden]), #task-list > li")];
    for (const box of boxes) {
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("input, select, textarea, button, label, .sch-summary")) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest("[hidden]")) continue;
        if (r.right > b.right + 0.5 || r.left < b.left - 0.5) problems.push(`${el.id || el.className || el.tagName} clipped (${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(b.left)}-${Math.round(b.right)})`);
      }
    }
    // Every control has a name a screen reader says.
    for (const el of document.querySelectorAll("#add-form input:not([type=file]), #add-form select, #add-form textarea, #add-form button")) {
      if (el.closest("[hidden]") || !el.getBoundingClientRect().width) continue;
      const named = el.getAttribute("aria-label") || el.labels?.length || el.getAttribute("aria-labelledby") || el.textContent.trim();
      if (!named) problems.push(`unnamed ${el.tagName.toLowerCase()} ${el.id || el.className}`);
    }
    return problems;
  });
  if (out.length) fail(`${what}: ${out.join("; ")}`);
}

const summary = (p) => p.locator(".sch-summary").textContent();

export const TODO_CASES = [
  {
    names: [
      "panel-todo-rows",
      "panel-form-once",
      "panel-form-daily",
      "panel-form-weekly",
      "panel-form-monthly",
      "panel-form-custom",
      "panel-form-end",
      "panel-form-edit",
    ],
    async run({ ctx, size, scheme, label, fail, want, openPanel, shoot, checkLayout, reportErrors, shots, taken }) {
      const p = await openPanel(ctx, "ok", ".ev-tool");
      await p.click("#tab-btn-todo");
      await p.waitForSelector(".task");
      /** The whole form: a viewport tall enough to show all of it above the composer, for the shot only. */
      const shootForm = async (name) => {
        if (!want(name, size, scheme)) return;
        const form = p.locator("#add-form");
        const height = (await form.boundingBox()).height;
        await p.setViewportSize({ width: size.w, height: Math.max(size.h, Math.ceil(height) + 360) });
        await form.scrollIntoViewIfNeeded();
        const file = join(shots, `${name}-${size.w}-${scheme}.png`);
        await form.screenshot({ path: file, animations: "disabled" });
        taken.push(file);
        await p.setViewportSize({ width: size.w, height: size.h });
      };
      /** Opens a fresh add form with this task text. */
      const openForm = async (text) => {
        if (await p.locator("#add-form").isVisible()) await p.click("#add-cancel");
        await p.click("#add-toggle");
        if ((await p.evaluate(() => document.activeElement?.id)) !== "add-text") fail("Add task did not focus the task field");
        await p.fill("#add-text", text);
      };
      const repeatOn = async () => {
        await p.locator(".sch-switch").click();
        if (!(await p.locator("#add-sched-rule").isVisible())) fail("the Repeat switch did not show the repeat choices");
      };
      /** Submits and returns what tasks.add (or tasks.update) sent. */
      const submit = async (type = "tasks.add") => {
        const before = (await sent(p, type)).length;
        await p.click("#add-submit");
        await p.waitForFunction(([t, n]) => window.__requests.filter((r) => r.type === t).length > n, [type, before]);
        return (await sent(p, type)).at(-1);
      };

      // The rows: the task on two lines at most, when it runs in words, Run / Stop, "⋯"; Run due (N) counts what is due.
      const rows = await p.evaluate(() =>
        [...document.querySelectorAll("#task-list > li")].map((li) => ({
          title: li.querySelector(".task-title").textContent,
          when: li.querySelector(".when")?.textContent ?? null,
          run: li.querySelector(".run-btn")?.textContent ?? null,
          lines: Math.round(li.querySelector(".task-title").getBoundingClientRect().height / parseFloat(getComputedStyle(li.querySelector(".task-title")).lineHeight)),
        })),
      );
      const byTitle = (start) => rows.find((r) => r.title.startsWith(start));
      if (byTitle("Reply to new mentions")?.when?.match(/^Daily at 9:00 AM and 6:00 PM · Next /) === null) fail(`repeating row says "${byTitle("Reply to new mentions")?.when}"`);
      if (byTitle("Post the photo")?.when !== "Due now") fail(`due row says "${byTitle("Post the photo")?.when}"`);
      if (!/^Once · Retries /.test(byTitle("Like the three")?.when ?? "")) fail(`retry row says "${byTitle("Like the three")?.when}"`);
      if (rows.some((r) => r.lines > 2)) fail(`a task title takes more than two lines: ${JSON.stringify(rows)}`);
      if (rows.find((r) => r.run === "Stop")?.title !== rows[0].title) fail(`the running task has no Stop: ${JSON.stringify(rows)}`);
      if (rows.filter((r) => r.run === "Run").length !== rows.length - 1) fail(`not every waiting task has Run: ${JSON.stringify(rows)}`);
      if (rows.some((r) => /\d \d|\*/.test(r.when ?? ""))) fail(`raw cron in a row: ${JSON.stringify(rows)}`);
      const runDue = await p.evaluate(() => ({ text: document.getElementById("run-now").textContent, hidden: document.getElementById("run-now").hidden }));
      if (runDue.hidden || runDue.text !== "Run due (1)") fail(`Run due ${JSON.stringify(runDue)}`);
      await checkForm(p, fail, `rows ${label}`);
      await checkLayout(p, `todo rows ${label}`);
      await shoot(p, "panel-todo-rows", size, scheme);
      // Run on a row runs that task, and its run opens in Chat.
      await p.locator("#task-list > li", { hasText: "Post the photo" }).locator(".run-btn").click();
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "tasks.run"));
      if ((await sent(p, "tasks.run"))[0]?.id !== "t3") fail(`Run sent ${JSON.stringify(await sent(p, "tasks.run"))}`);
      await p.click("#tab-btn-todo");
      await p.waitForSelector(".task");

      // Once: a date and time; the summary says when.
      await openForm("Post the launch thread on X from @alpha");
      if ((await summary(p)) !== "Runs as soon as possible") fail(`empty schedule summary "${await summary(p)}"`);
      await p.fill("#add-sched-date", dateIn(3));
      await p.fill("#add-sched-time", "15:00");
      if (!/^Runs once, [A-Z][a-z]{2} 3:00 PM$/.test(await summary(p))) fail(`one-off summary "${await summary(p)}"`);
      await checkForm(p, fail, `once ${label}`);
      await shootForm("panel-form-once");
      const once = await submit();
      if (once.repeat || once.notBefore !== new Date(`${dateIn(3)}T15:00`).toISOString() || once.instructions !== "Post the launch thread on X from @alpha" || "account" in once) {
        fail(`one-off sent ${JSON.stringify(once)}`);
      }

      // Daily at two times.
      await openForm("Post the weekly recap");
      await repeatOn();
      await p.click(".sch-add");
      await p.locator(".sch-time input").nth(1).fill("18:30");
      if ((await summary(p)) !== "Repeats daily at 9:00 AM and 6:30 PM") fail(`daily summary "${await summary(p)}"`);
      await checkForm(p, fail, `daily ${label}`);
      await shootForm("panel-form-daily");
      const daily = await submit();
      if (daily.repeat?.cron !== "0 9 * * *\n30 18 * * *" || !daily.repeat.tz || daily.notBefore) fail(`daily sent ${JSON.stringify(daily)}`);

      // Weekly on Mon, Wed and Fri: Mon is picked for a Monday start; the chips are toggle buttons.
      await openForm("Check the analytics dashboard and send me the numbers");
      await repeatOn();
      await p.selectOption("#add-sched-freq", "weekly");
      const pressed = () => p.evaluate(() => [...document.querySelectorAll(".sch-day[aria-pressed=true]")].map((b) => b.textContent));
      for (const day of ["Monday", "Wednesday", "Friday"]) if (!(await pressed()).includes(day.slice(0, 2))) await p.getByRole("button", { name: day, exact: true }).click();
      for (const day of await pressed()) if (!["Mo", "We", "Fr"].includes(day)) await p.locator(".sch-day", { hasText: day }).click();
      if ((await summary(p)) !== "Repeats every Mon, Wed and Fri at 9:00 AM") fail(`weekly summary "${await summary(p)}"`);
      await checkForm(p, fail, `weekly ${label}`);
      await shootForm("panel-form-weekly");
      const weekly = await submit();
      if (weekly.repeat?.cron !== "0 9 * * 1,3,5") fail(`weekly sent ${JSON.stringify(weekly)}`);

      // Monthly on the first Monday, every 2 months.
      await openForm("Pay the office rent");
      await repeatOn();
      await p.selectOption("#add-sched-freq", "monthly");
      await p.fill("#add-sched-every", "2");
      await p.selectOption("#add-sched-nth", "1");
      await p.selectOption("#add-sched-nth-day", "1");
      if (!(await p.locator("#add-sched-by-weekday").isChecked())) fail("picking a weekday did not pick its way of saying the day");
      if ((await summary(p)) !== "Repeats every 2 months on the first Monday at 9:00 AM") fail(`monthly summary "${await summary(p)}"`);
      await checkForm(p, fail, `monthly ${label}`);
      await shootForm("panel-form-monthly");
      const monthly = await submit();
      if (monthly.repeat?.cron !== "0 9 * * 1#1" || monthly.repeat.interval?.every !== 2 || monthly.repeat.interval.unit !== "month" || !monthly.repeat.start) {
        fail(`monthly sent ${JSON.stringify(monthly)}`);
      }

      // Custom: the cron is described as it is typed; a bad one says why and is not sent.
      await openForm("Check the status page");
      await repeatOn();
      await p.selectOption("#add-sched-freq", "custom");
      if ((await p.inputValue("#add-sched-cron")) !== "0 9 * * *") fail(`Custom did not start from the rule so far: "${await p.inputValue("#add-sched-cron")}"`);
      await p.fill("#add-sched-cron", "0 9 * *");
      if (!/has 4 fields/.test(await p.textContent("#add-sched-cron-text")) || (await p.getAttribute("#add-sched-cron", "aria-invalid")) !== "true") fail("a bad cron is not flagged");
      await p.click("#add-submit");
      if ((await p.evaluate(() => document.activeElement?.id)) !== "add-sched-cron" || !/has 4 fields/.test(await p.textContent("#add-msg"))) fail("submitting a bad cron did not say why and focus it");
      await p.fill("#add-sched-cron", "*/30 9-17 * * 1-5");
      if ((await p.textContent("#add-sched-cron-text")) !== "Every weekday, 18 times a day, 9:00 AM to 5:30 PM") fail(`custom text "${await p.textContent("#add-sched-cron-text")}"`);
      await checkForm(p, fail, `custom ${label}`);
      await shootForm("panel-form-custom");
      const custom = await submit();
      if (custom.repeat?.cron !== "*/30 9-17 * * 1-5") fail(`custom sent ${JSON.stringify(custom)}`);

      // Ends on a date (and the error when it is before the start).
      await openForm("Water the plants reminder");
      await p.fill("#add-sched-date", dateIn(2));
      await p.fill("#add-sched-time", "08:00");
      await repeatOn();
      if ((await p.inputValue("#add-sched-start")) !== dateIn(2) || (await p.inputValue(".sch-time input")) !== "08:00") fail("the rule did not start from Scheduled at");
      await p.selectOption("#add-sched-ends", "on");
      await p.fill("#add-sched-end-date", dateIn(1));
      if ((await summary(p)) !== "The end date is before the start date") fail(`end before start "${await summary(p)}"`);
      await p.fill("#add-sched-end-date", `${new Date().getFullYear()}-12-31`);
      if (!/^Repeats daily at 8:00 AM, starting \w{3} \d+, until Dec 31$/.test(await summary(p))) fail(`end summary "${await summary(p)}"`);
      await checkForm(p, fail, `end ${label}`);
      await shootForm("panel-form-end");
      const ending = await submit();
      if (ending.repeat?.end !== `${new Date().getFullYear()}-12-31` || ending.notBefore !== new Date(`${dateIn(2)}T08:00`).toISOString()) fail(`end sent ${JSON.stringify(ending)}`);

      // Edit: "⋯" > Edit opens the form with the task as it is; Save sends the change.
      const row = p.locator("#task-list > li", { hasText: "Reply to new mentions" });
      await row.locator(".menu summary").click();
      await row.getByRole("button", { name: "Edit" }).click();
      const edit = await p.evaluate(() => ({
        title: document.getElementById("add-title").textContent,
        submit: document.getElementById("add-submit").textContent,
        text: document.getElementById("add-text").value,
        repeat: document.getElementById("add-sched-repeat").checked,
        freq: document.getElementById("add-sched-freq").value,
        times: [...document.querySelectorAll(".sch-time input")].map((i) => i.value),
        attach: !document.getElementById("add-attach").hidden,
      }));
      if (edit.title !== "Edit task" || edit.submit !== "Save" || !edit.text.startsWith("Reply to new mentions") || !edit.repeat || edit.freq !== "daily" || edit.times.join() !== "09:00,18:00" || edit.attach) {
        fail(`edit form ${JSON.stringify(edit)}`);
      }
      await checkForm(p, fail, `edit ${label}`);
      await shootForm("panel-form-edit");
      await p.locator(".sch-time input").nth(1).fill("17:00");
      const saved = await submit("tasks.update");
      if (saved.id !== "t1" || saved.patch.repeat?.cron !== "0 9,17 * * *" || !saved.patch.instructions.startsWith("Reply")) fail(`edit sent ${JSON.stringify(saved)}`);
      if ((await p.evaluate(() => document.activeElement?.dataset.taskId)) !== "t1") fail("Save did not return the focus to the task");
      reportErrors(p, `todo ${label}`);
      await p.close();
    },
  },
  // A task stored with the old { dailyAt } rule (before the store migrates it): no errors anywhere it shows.
  {
    names: ["panel-todo-legacy"],
    async run({ ctx, size, scheme, label, fail, openPanel, shoot, reportErrors }) {
      const legacy = (d) => {
        const t = d.tasks.find((x) => x.id === "t1");
        Object.assign(t, { repeat: { dailyAt: ["07:15", "21:00"] } });
      };
      const p = await openPanel(ctx, "ok", ".ev-tool", { edit: legacy });
      await p.click("#tab-btn-todo");
      await p.waitForSelector(".task");
      const row = p.locator("#task-list > li", { hasText: "Reply to new mentions" });
      const when = await row.locator(".when").textContent();
      if (!when.startsWith("Daily at 7:15 AM and 9:00 PM")) fail(`legacy row says "${when}"`);
      // Details, then Open in TODO from a run's details, then Edit: each shows the rule.
      await row.locator(".task-title").click();
      await p.waitForSelector("dialog.sheet[open]");
      const repeats = await p.evaluate(() => [...document.querySelectorAll("dialog.sheet[open] dt")].find((d) => d.textContent === "Repeats")?.nextElementSibling?.textContent ?? null);
      if (!repeats?.startsWith("Daily at 7:15 AM and 9:00 PM")) fail(`legacy details Repeats: ${repeats}`);
      await p.keyboard.press("Escape");
      await row.locator(".menu summary").click();
      await row.getByRole("button", { name: "Edit" }).click();
      const times = await p.evaluate(() => [...document.querySelectorAll(".sch-time input")].map((i) => i.value).join());
      if (times !== "07:15,21:00") fail(`legacy edit times ${times}`);
      await shoot(p, "panel-todo-legacy", size, scheme);
      reportErrors(p, `todo legacy ${label}`);
      await p.close();
    },
  },
];
