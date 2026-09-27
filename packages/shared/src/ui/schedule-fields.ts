/**
 * The add/edit form's schedule section, shared by the side panel and the
 * dashboard (each styles the `sch-*` classes): "Scheduled at" (date and time;
 * empty = as soon as possible), a Repeat switch that reveals the rule's
 * choices (frequency, every N, weekdays, day of the month, times, starts,
 * ends, or a custom cron with a live description), a live summary line, and
 * the time zone. Plain DOM; the rules are in schedule-form.ts.
 *
 * Imported as "@browsertodo/shared/schedule-fields" (DOM code stays out of
 * the package's main entry, which the API Worker imports too).
 */
import { describeCron } from "../schedule-text.js";
import {
  defaultRepeatForm,
  formToRepeat,
  repeatToForm,
  type Ends,
  type FormField,
  type Frequency,
  type RepeatForm,
} from "../schedule-form.js";
import { cronProblem, nextRun, type RepeatSchedule } from "../schedule.js";
import { NTH_NAMES, ordinal, prefersHour12, repeatSummary, WEEK_ORDER, WEEKDAY_NAMES, WEEKDAY_SHORT } from "../schedule-text.js";
import { whenText } from "../task-view.js";
import { fromZonedInputs, localTimeZone, toZonedInputs } from "../zoned-time.js";

export interface ScheduleValue {
  /** The first (or only) run, ISO; null = as soon as possible (or the rule's first time). */
  at: string | null;
  repeat: RepeatSchedule | null;
}

export interface ScheduleFieldsOptions {
  /** Prefix of the element ids (unique on the page). */
  id: string;
  value?: ScheduleValue | null;
  /** The zone times are entered in; default this browser's. A rule being edited uses its own. */
  timeZone?: string;
  now?: () => Date;
  hour12?: boolean;
}

export type ScheduleRead = { ok: true; value: ScheduleValue } | { ok: false; error: string; focus: HTMLElement };

export interface ScheduleFields {
  readonly element: HTMLElement;
  /** The schedule entered, or what to fix (and the field to focus). */
  read(): ScheduleRead;
  /** Shows a schedule (null: empty, no repeat). */
  set(value: ScheduleValue | null): void;
}

type Attrs = Record<string, string | number | boolean | null | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

function select(id: string, options: [string, string][], label?: string): HTMLSelectElement {
  const s = el("select", { id, ...(label ? { "aria-label": label } : {}) });
  for (const [value, text] of options) s.append(el("option", { value }, text));
  return s;
}

const FREQUENCIES: [Frequency, string][] = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["custom", "Custom (cron)"],
];
const UNIT_WORDS: Record<Exclude<Frequency, "custom">, [string, string]> = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"] };
const ENDS: [Ends, string][] = [
  ["never", "Never"],
  ["on", "On date"],
  ["after", "After"],
];

/** Every IANA zone this browser knows, else just the ones given. */
function timeZones(known: string[]): string[] {
  const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...known, ...all])].sort();
}

export function createScheduleFields(opts: ScheduleFieldsOptions): ScheduleFields {
  const now = opts.now ?? (() => new Date());
  const hour12 = opts.hour12 ?? prefersHour12();
  const id = (s: string) => `${opts.id}-${s}`;
  let tz = opts.timeZone ?? localTimeZone();
  let form: RepeatForm = defaultRepeatForm({ ...toZonedInputs(now().getTime(), tz), tz });
  /** The user changed the rule: it no longer follows "Scheduled at". */
  let ruleTouched = false;
  /** The user typed a cron: switching to Custom keeps it. */
  let cronTouched = false;

  // Scheduled at
  const date = el("input", { id: id("date"), type: "date", "aria-describedby": id("when-hint") });
  const time = el("input", { id: id("time"), type: "time", "aria-label": "Time", "aria-describedby": id("when-hint") });
  const clearWhen = el("button", { type: "button", class: "sch-link", "aria-label": "Clear the scheduled time" }, "Clear");
  const whenHint = el("p", { id: id("when-hint"), class: "sch-hint" });
  const when = el(
    "div",
    { class: "sch-when" },
    el("label", { class: "sch-label", for: id("date") }, "Scheduled at"),
    el("div", { class: "sch-row" }, date, time, clearWhen),
    whenHint,
  );

  // Repeat switch
  const repeatOn = el("input", { id: id("repeat"), type: "checkbox", role: "switch", "aria-controls": id("rule") });
  const toggle = el("label", { class: "sch-switch", for: id("repeat") }, repeatOn, el("span", { class: "sch-track", "aria-hidden": "true" }), el("span", null, "Repeat"));

  // Frequency and every N
  const frequency = select(id("freq"), FREQUENCIES);
  const every = el("input", { id: id("every"), type: "number", min: 1, max: 99, step: 1, inputmode: "numeric", class: "sch-num" });
  const everyUnit = el("span", { class: "sch-unit", id: id("every-unit") });
  every.setAttribute("aria-describedby", id("every-unit"));
  const everyField = el("div", { class: "sch-field sch-every" }, el("label", { for: id("every") }, "Every"), el("div", { class: "sch-row" }, every, everyUnit));
  const freqRow = el("div", { class: "sch-grid" }, el("div", { class: "sch-field" }, el("label", { for: id("freq") }, "Frequency"), frequency), everyField);

  // Weekly: day chips, Monday first
  const dayButtons = WEEK_ORDER.map((d) =>
    el("button", { type: "button", class: "sch-day", "aria-pressed": "false", "data-day": d, "aria-label": WEEKDAY_NAMES[d], title: WEEKDAY_NAMES[d] }, WEEKDAY_SHORT[d]!.slice(0, 2)),
  );
  const days = el("div", { class: "sch-field sch-days-field" }, el("span", { class: "sch-label", id: id("days-label") }, "On"), el("div", { class: "sch-days", role: "group", "aria-labelledby": id("days-label") }, ...dayButtons));

  // Monthly: on day N, or on the nth weekday
  const byDay = el("input", { type: "radio", name: id("monthly"), id: id("by-day"), value: "day" });
  const byWeekday = el("input", { type: "radio", name: id("monthly"), id: id("by-weekday"), value: "weekday" });
  const monthDay = select(id("month-day"), [...Array.from({ length: 31 }, (_, i): [string, string] => [String(i + 1), ordinal(i + 1)]), ["-1", "last day"]], "Day of the month");
  const nth = select(id("nth"), [1, 2, 3, 4, -1].map((n): [string, string] => [String(n), NTH_NAMES[n]!]), "Which week");
  const nthDay = select(id("nth-day"), WEEK_ORDER.map((d): [string, string] => [String(d), WEEKDAY_NAMES[d]!]), "Day of the week");
  const monthly = el(
    "div",
    { class: "sch-field sch-monthly", role: "radiogroup", "aria-label": "Day of the month" },
    el("div", { class: "sch-row" }, byDay, el("label", { for: id("by-day") }, "On the"), monthDay),
    el("div", { class: "sch-row" }, byWeekday, el("label", { for: id("by-weekday") }, "On the"), nth, nthDay),
  );

  // Times
  const timeList = el("div", { class: "sch-times", role: "group", "aria-labelledby": id("times-label") });
  const addTime = el("button", { type: "button", class: "sch-link sch-add" }, "+ Add time");
  const times = el("div", { class: "sch-field" }, el("span", { class: "sch-label", id: id("times-label") }, "At"), el("div", { class: "sch-row sch-wrap" }, timeList, addTime));

  // Custom cron
  const cron = el("textarea", {
    id: id("cron"),
    rows: 2,
    spellcheck: "false",
    autocomplete: "off",
    class: "sch-cron",
    placeholder: "0 9 * * 1-5",
    "aria-describedby": `${id("cron-text")} ${id("cron-help")}`,
  });
  const cronText = el("p", { id: id("cron-text"), class: "sch-cron-text", "aria-live": "polite" });
  const custom = el(
    "div",
    { class: "sch-field sch-custom" },
    el("label", { for: id("cron") }, "Cron"),
    cron,
    cronText,
    el("p", { id: id("cron-help"), class: "sch-hint" }, "minute hour day-of-month month day-of-week; one rule per line"),
  );

  // Starts and ends
  const start = el("input", { id: id("start"), type: "date" });
  const ends = select(id("ends"), ENDS);
  const endDate = el("input", { id: id("end-date"), type: "date", "aria-label": "End date" });
  const count = el("input", { id: id("count"), type: "number", min: 1, max: 1000, step: 1, inputmode: "numeric", class: "sch-num", "aria-label": "Number of runs" });
  const countUnit = el("span", { class: "sch-unit" }, "runs");
  const range = el(
    "div",
    { class: "sch-grid sch-range" },
    el("div", { class: "sch-field" }, el("label", { for: id("start") }, "Starts"), start),
    el("div", { class: "sch-field" }, el("label", { for: id("ends") }, "Ends"), el("div", { class: "sch-row" }, ends, endDate, count, countUnit)),
  );

  const rule = el("fieldset", { id: id("rule"), class: "sch-rule" }, el("legend", { class: "sch-sr" }, "Repeat"), freqRow, days, monthly, times, custom, range);
  const summary = el("p", { class: "sch-summary", id: id("summary"), "aria-live": "polite" });
  const firstRun = el("p", { class: "sch-hint sch-first" });

  // Time zone: shown; a select when the user asks to change it.
  const tzName = el("span", { class: "sch-tz-name" });
  const tzChange = el("button", { type: "button", class: "sch-link", "aria-controls": id("tz") }, "Change");
  const tzSelect = el("select", { id: id("tz"), "aria-label": "Time zone", hidden: true });
  const tzRow = el("p", { class: "sch-hint sch-tz" }, "Time zone: ", tzName, " ", tzChange, tzSelect);

  const element = el("div", { class: "sch" }, when, toggle, rule, summary, firstRun, tzRow);

  // ---- form state <-> fields ---------------------------------------------

  function timeRow(value: string): HTMLElement {
    const n = timeList.children.length + 1;
    const input = el("input", { type: "time", value, "aria-label": `Time ${n}`, required: true });
    input.value = value;
    const rm = el("button", { type: "button", class: "sch-x", "aria-label": `Remove time ${n}`, title: "Remove" }, "×");
    const row = el("span", { class: "sch-time" }, input, rm);
    rm.addEventListener("click", () => {
      if (timeList.children.length === 1) return;
      const next = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector("input");
      row.remove();
      renumberTimes();
      next?.focus();
      touched();
    });
    input.addEventListener("input", touched);
    return row;
  }

  function renumberTimes(): void {
    [...timeList.children].forEach((row, i) => {
      row.querySelector("input")!.setAttribute("aria-label", `Time ${i + 1}`);
      row.querySelector("button")!.setAttribute("aria-label", `Remove time ${i + 1}`);
      row.querySelector("button")!.toggleAttribute("disabled", timeList.children.length === 1);
    });
  }

  function writeForm(): void {
    frequency.value = form.frequency;
    every.value = String(form.every);
    for (const b of dayButtons) b.setAttribute("aria-pressed", String(form.weekdays.includes(Number(b.dataset.day))));
    const m = form.monthly;
    byDay.checked = m.by === "day";
    byWeekday.checked = m.by === "weekday";
    if (m.by === "day") monthDay.value = String(m.day);
    else {
      nth.value = String(m.nth);
      nthDay.value = String(m.weekday);
    }
    timeList.replaceChildren();
    for (const t of form.times.length ? form.times : ["09:00"]) timeList.append(timeRow(t));
    renumberTimes();
    cron.value = form.cron;
    start.value = form.start;
    ends.value = form.ends;
    endDate.value = form.endDate;
    count.value = String(form.count);
  }

  function readForm(): RepeatForm {
    const m: RepeatForm["monthly"] = byWeekday.checked
      ? { by: "weekday", nth: Number(nth.value), weekday: Number(nthDay.value) }
      : { by: "day", day: Number(monthDay.value) };
    return {
      ...form,
      frequency: frequency.value as Frequency,
      every: every.value === "" ? NaN : Number(every.value),
      weekdays: dayButtons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.day)),
      monthly: m,
      times: [...timeList.querySelectorAll("input")].map((i) => i.value),
      start: start.value,
      ends: ends.value as Ends,
      endDate: endDate.value,
      count: count.value === "" ? NaN : Number(count.value),
      cron: cron.value,
      tz,
    };
  }

  const fieldFor: Record<FormField, () => HTMLElement> = {
    every: () => every,
    weekdays: () => dayButtons[0]!,
    times: () => [...timeList.querySelectorAll("input")].find((i) => !i.value) ?? timeList.querySelector("input")!,
    start: () => start,
    endDate: () => endDate,
    count: () => count,
    cron: () => cron,
  };

  /** "Scheduled at" as an instant, "" when empty, or null when it is not a valid date and time. */
  function whenValue(): string | null | "" {
    if (!date.value && !time.value) return "";
    const d = date.value || toZonedInputs(now().getTime(), tz).date;
    const at = fromZonedInputs(d, time.value, tz);
    return at === null ? null : new Date(at).toISOString();
  }

  function update(): void {
    form = readForm();
    const on = repeatOn.checked;
    rule.hidden = !on;
    const f = form.frequency;
    everyField.hidden = f === "custom";
    days.hidden = f !== "weekly";
    monthly.hidden = f !== "monthly";
    times.hidden = f === "custom";
    custom.hidden = f !== "custom";
    if (f !== "custom") {
      const [one, many] = UNIT_WORDS[f];
      everyUnit.textContent = form.every === 1 ? one : many;
    }
    endDate.hidden = form.ends !== "on";
    count.hidden = countUnit.hidden = form.ends !== "after";
    clearWhen.hidden = !date.value && !time.value;
    tzName.textContent = tz;

    // The custom cron in words as it is typed.
    const problem = f === "custom" && cron.value.trim() ? cronProblem(cron.value) : null;
    cron.setAttribute("aria-invalid", String(!!problem));
    cronText.textContent = f !== "custom" || !cron.value.trim() ? "" : problem ?? describeCron(cron.value, form.customInterval, { hour12 });
    cronText.dataset.tone = problem ? "bad" : "";

    const at = whenValue();
    whenHint.textContent = at === null ? "Pick a date and a time" : on ? "The first run; empty: the first repeat time" : "Empty: as soon as possible";
    whenHint.dataset.tone = at === null ? "bad" : "";
    const n = now();
    if (!on) {
      summary.textContent = at ? `Runs once, ${whenText(at, n.getTime(), { tz, hour12 }).replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase())}` : "Runs as soon as possible";
      summary.dataset.tone = "";
      firstRun.textContent = "";
      return;
    }
    const built = formToRepeat(form);
    if (!built.ok) {
      summary.textContent = built.error;
      summary.dataset.tone = "bad";
      firstRun.textContent = "";
      return;
    }
    summary.textContent = repeatSummary(built.repeat, { hour12, now: n });
    summary.dataset.tone = "";
    const first = at || nextRun(built.repeat, n)?.toISOString();
    firstRun.textContent = first ? `First run: ${whenText(first, n.getTime(), { tz, hour12 })}` : "This rule never runs: check its days, start and end";
    firstRun.dataset.tone = first ? "" : "bad";
  }

  /** A fresh rule from "Scheduled at": daily at its time (09:00 when empty), starting its day. */
  function ruleFromWhen(): RepeatForm {
    const at = whenValue();
    const base = toZonedInputs(at ? Date.parse(at) : now().getTime(), tz);
    return defaultRepeatForm({ date: base.date, time: at ? base.time : "09:00", tz });
  }

  /** Until the user changes the rule, it follows "Scheduled at" (its day, weekday and time). */
  function followWhen(): void {
    if (!repeatOn.checked || ruleTouched) return;
    form = { ...ruleFromWhen(), frequency: form.frequency, every: form.every };
    writeForm();
  }

  /** A change to the rule: it stops following "Scheduled at". */
  function touched(): void {
    ruleTouched = true;
    update();
  }

  // ---- events --------------------------------------------------------------

  for (const input of [date, time]) {
    input.addEventListener("input", () => {
      if (input === date && date.value && !time.value) time.value = "09:00";
      followWhen();
      update();
    });
  }
  clearWhen.addEventListener("click", () => {
    date.value = time.value = "";
    followWhen();
    update();
    date.focus();
  });
  repeatOn.addEventListener("change", () => {
    followWhen();
    update();
  });
  for (const input of [every, byDay, byWeekday, ends, endDate, count, start]) {
    input.addEventListener(input instanceof HTMLSelectElement || input.type === "radio" ? "change" : "input", touched);
  }
  cron.addEventListener("input", () => {
    cronTouched = true;
    touched();
  });
  frequency.addEventListener("change", () => {
    // Custom starts from the rule chosen so far, in cron (unless a cron was typed already).
    if (frequency.value === "custom" && !cronTouched && form.frequency !== "custom") {
      const built = formToRepeat(form);
      if (built.ok) cron.value = built.repeat.cron;
    }
    touched();
  });
  // Picking a day of the month picks its way of saying it.
  monthDay.addEventListener("change", () => {
    byDay.checked = true;
    touched();
  });
  for (const s of [nth, nthDay]) {
    s.addEventListener("change", () => {
      byWeekday.checked = true;
      touched();
    });
  }
  for (const b of dayButtons) {
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      touched();
    });
  }
  addTime.addEventListener("click", () => {
    const last = [...timeList.querySelectorAll("input")].at(-1)?.value ?? "09:00";
    const [h, m] = last.split(":").map(Number) as [number, number];
    const row = timeRow(`${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    timeList.append(row);
    renumberTimes();
    row.querySelector("input")!.focus();
    touched();
  });
  tzChange.addEventListener("click", () => {
    if (!tzSelect.options.length) for (const z of timeZones([tz])) tzSelect.append(el("option", { value: z }, z));
    tzSelect.value = tz;
    tzSelect.hidden = false;
    tzChange.hidden = tzName.hidden = true;
    tzSelect.focus();
  });
  tzSelect.addEventListener("change", () => {
    tz = tzSelect.value;
    update();
  });

  // ---- API -------------------------------------------------------------------

  function set(value: ScheduleValue | null): void {
    tz = value?.repeat?.tz ?? opts.timeZone ?? localTimeZone();
    tzSelect.hidden = true;
    tzChange.hidden = tzName.hidden = false;
    const at = value?.at ? toZonedInputs(Date.parse(value.at), tz) : null;
    date.value = at?.date ?? "";
    time.value = at?.time ?? "";
    const fallback = at ?? { ...toZonedInputs(now().getTime(), tz), time: "09:00" };
    form = value?.repeat ? repeatToForm(value.repeat, fallback) : defaultRepeatForm({ ...fallback, tz });
    ruleTouched = !!value?.repeat;
    cronTouched = form.frequency === "custom";
    repeatOn.checked = !!value?.repeat;
    writeForm();
    update();
  }

  function read(): ScheduleRead {
    update();
    const at = whenValue();
    if (at === null) return { ok: false, error: "Pick a date and a time for Scheduled at, or clear it", focus: date.value ? time : date };
    if (!repeatOn.checked) return { ok: true, value: { at: at || null, repeat: null } };
    const built = formToRepeat(form);
    if (!built.ok) return { ok: false, error: built.error, focus: fieldFor[built.field]() };
    if (!at && !nextRun(built.repeat, now())) return { ok: false, error: "This repeat rule never runs: check its days, start and end", focus: start };
    return { ok: true, value: { at: at || null, repeat: built.repeat } };
  }

  set(opts.value ?? null);
  return { element, read, set };
}
