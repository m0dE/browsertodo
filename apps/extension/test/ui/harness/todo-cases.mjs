// The TODO tab's cases of the UI harness: the rows (Run / Stop, the schedule in words, Run due (N)), and the
// add/edit form with its schedule section (packages/shared ui/schedule-fields.ts): One time | Repeat (radios; each
// shows only its own fields), once, daily at two times, weekly Mon/Wed/Fri, monthly on the first Monday, a custom
// cron, an end date, and editing repeating and one-time tasks (switching modes). Each form case is screenshotted
// (the form itself) at every panel size and scheme, and checks what the form sends.
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
      for (const el of box.querySelectorAll("input, select, textarea, button, label, .sch-first")) {
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

/** The line under the rule: its first run, or what to fix. */
const firstRun = (p) => p.locator("#add-sched-first").textContent();

/** The chosen mode and what shows: One time shows only Scheduled at; Repeat only the rule. No summary line. */
async function checkMode(p, fail, mode, what) {
  const got = await p.evaluate(() => ({
    once: document.getElementById("add-sched-mode-once").checked,
    repeat: document.getElementById("add-sched-mode-repeat").checked,
    when: !!document.getElementById("add-sched-when").getBoundingClientRect().height,
    rule: !!document.getElementById("add-sched-rule").getBoundingClientRect().height,
    summary: document.querySelectorAll(".sch-summary").length,
  }));
  const want = mode === "once" ? { once: true, repeat: false, when: true, rule: false, summary: 0 } : { once: false, repeat: true, when: false, rule: true, summary: 0 };
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: mode ${mode} shows ${JSON.stringify(got)}`);
}

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
      "panel-form-edit-once",
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
        await p.getByRole("radio", { name: "Repeat", exact: true }).check();
        await checkMode(p, fail, "repeat", "Repeat");
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

      // One time (the default): only Scheduled at; empty is as soon as possible.
      await openForm("Post the launch thread on X from @alpha");
      await checkMode(p, fail, "once", "new task");
      if ((await p.textContent("#add-sched-when-hint")) !== "Empty: as soon as possible") fail(`empty schedule hint "${await p.textContent("#add-sched-when-hint")}"`);
      await p.fill("#add-sched-date", dateIn(3));
      await p.fill("#add-sched-time", "15:00");
      // The modes are one radio group: arrows switch them, the focus shows, and each keeps its values.
      await p.focus("#add-sched-mode-once");
      await p.keyboard.press("ArrowRight");
      await checkMode(p, fail, "repeat", "ArrowRight");
      const ring = await p.evaluate(() => getComputedStyle(document.activeElement.nextElementSibling).outlineStyle);
      if ((await p.evaluate(() => document.activeElement?.id)) !== "add-sched-mode-repeat" || ring === "none") fail(`the focused mode shows no focus (${ring})`);
      await p.keyboard.press("ArrowLeft");
      await checkMode(p, fail, "once", "ArrowLeft");
      if ((await p.inputValue("#add-sched-date")) !== dateIn(3) || (await p.inputValue("#add-sched-time")) !== "15:00") fail("switching back to One time lost Scheduled at");
      await p.focus("#add-text");
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
      if (!/^First run: /.test(await firstRun(p))) fail(`daily first run "${await firstRun(p)}"`);
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
      if ((await pressed()).join() !== "Mo,We,Fr" || !/^First run: /.test(await firstRun(p))) fail(`weekly ${await pressed()} "${await firstRun(p)}"`);
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
      if (!/^First run: /.test(await firstRun(p))) fail(`monthly first run "${await firstRun(p)}"`);
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

      // Ends on a date (and the error when it is before the start). The rule starts from the One time date and time;
      // saving Repeat sends only the rule (Starts and the rule give the first run).
      await openForm("Water the plants reminder");
      await p.fill("#add-sched-date", dateIn(2));
      await p.fill("#add-sched-time", "08:00");
      await repeatOn();
      if ((await p.inputValue("#add-sched-start")) !== dateIn(2) || (await p.inputValue(".sch-time input")) !== "08:00") fail("the rule did not start from Scheduled at");
      await p.selectOption("#add-sched-ends", "on");
      await p.fill("#add-sched-end-date", dateIn(1));
      if ((await firstRun(p)) !== "The end date is before the start date" || (await p.getAttribute("#add-sched-first", "data-tone")) !== "bad") fail(`end before start "${await firstRun(p)}"`);
      await p.fill("#add-sched-end-date", `${new Date().getFullYear()}-12-31`);
      if (!/^First run: /.test(await firstRun(p))) fail(`end first run "${await firstRun(p)}"`);
      await checkForm(p, fail, `end ${label}`);
      await shootForm("panel-form-end");
      const ending = await submit();
      if (ending.repeat?.end !== `${new Date().getFullYear()}-12-31` || ending.repeat.start !== dateIn(2) || "notBefore" in ending) fail(`end sent ${JSON.stringify(ending)}`);

      // Edit: "⋯" > Edit opens the form with the task as it is; Save sends the change.
      const row = p.locator("#task-list > li", { hasText: "Reply to new mentions" });
      await row.locator(".menu summary").click();
      await row.getByRole("button", { name: "Edit" }).click();
      const edit = await p.evaluate(() => ({
        title: document.getElementById("add-title").textContent,
        submit: document.getElementById("add-submit").textContent,
        text: document.getElementById("add-text").value,
        repeat: document.getElementById("add-sched-mode-repeat").checked,
        freq: document.getElementById("add-sched-freq").value,
        times: [...document.querySelectorAll(".sch-time input")].map((i) => i.value),
        attach: !document.getElementById("add-attach").hidden,
      }));
      if (edit.title !== "Edit task" || edit.submit !== "Save" || !edit.text.startsWith("Reply to new mentions") || !edit.repeat || edit.freq !== "daily" || edit.times.join() !== "09:00,18:00" || edit.attach) {
        fail(`edit form ${JSON.stringify(edit)}`);
      }
      await checkMode(p, fail, "repeat", "edit a repeating task");
      await checkForm(p, fail, `edit ${label}`);
      await shootForm("panel-form-edit");
      await p.locator(".sch-time input").nth(1).fill("17:00");
      const saved = await submit("tasks.update");
      if (saved.id !== "t1" || saved.patch.repeat?.cron !== "0 9,17 * * *" || saved.patch.notBefore !== null || !saved.patch.instructions.startsWith("Reply")) fail(`edit sent ${JSON.stringify(saved)}`);
      if ((await p.evaluate(() => document.activeElement?.dataset.taskId)) !== "t1") fail("Save did not return the focus to the task");

      const editRow = async (text) => {
        const r = p.locator("#task-list > li", { hasText: text });
        await r.locator(".menu summary").click();
        await r.getByRole("button", { name: "Edit" }).click();
      };
      // A repeating task made One time: Scheduled at holds its next run; saving drops the rule.
      await editRow("Reply to new mentions");
      const shownAt = await p.evaluate(() => [document.getElementById("add-sched-date").value, document.getElementById("add-sched-time").value]);
      await p.getByRole("radio", { name: "One time", exact: true }).check();
      await checkMode(p, fail, "once", "repeating task to One time");
      const once2 = await submit("tasks.update");
      if (once2.patch.repeat !== null || once2.patch.notBefore !== new Date(`${shownAt[0]}T${shownAt[1]}`).toISOString() || !shownAt[0]) fail(`to One time sent ${JSON.stringify(once2)} (shown ${shownAt})`);

      // A one-time task opens in One time; made Repeat, it sends only the rule.
      await editRow("Post the photo of the week");
      await checkMode(p, fail, "once", "edit a one-time task");
      if ((await p.inputValue("#add-sched-date")) || (await p.inputValue("#add-sched-time"))) fail("an as-soon-as-possible task opened with a Scheduled at");
      await shootForm("panel-form-edit-once");
      await repeatOn();
      const toRepeat = await submit("tasks.update");
      if (toRepeat.id !== "t3" || toRepeat.patch.notBefore !== null || toRepeat.patch.repeat?.cron !== "0 9 * * *") fail(`to Repeat sent ${JSON.stringify(toRepeat)}`);
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
