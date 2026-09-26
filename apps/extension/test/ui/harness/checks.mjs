// What the UI harness checks and records: screenshots, page errors, the panel's layout, the options
// page's checks, and the count of problems found (the harness exits non-zero when there are any).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installChromeStub } from "./chrome-stub.mjs";
import { scenario } from "./scenarios.mjs";

/** Visible to the user: laid out, and not inside a hidden element or a closed reveal. */
export const shownJs = (sel) => {
  const el = document.querySelector(sel);
  if (!el || !el.getClientRects().length) return false;
  for (let n = el; n; n = n.parentElement) {
    if (n.hidden || n.inert) return false;
    if (n.classList?.contains("reveal") && !n.classList.contains("open")) return false;
  }
  return true;
};
export const shown = (page, sel) => page.evaluate(shownJs, sel);

/** Polls `ok` until it holds or `ms` pass, and says whether it held (for UI that updates after a request is answered). */
export async function eventually(ok, ms = 2000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 25))) {
    if (await ok()) return true;
    if (Date.now() > end) return false;
  }
}

/**
 * The harness's checks for pages of `base` in `browser`. `only`: a substring of the screenshot file
 * names to limit the run to (--only); `shots`: where screenshots go.
 */
export function createChecks({ browser, base, only, shots }) {
  mkdirSync(shots, { recursive: true });
  const taken = [];
  let failures = 0;
  /** A problem found: printed, and counted. */
  const problem = (...message) => {
    console.error(...message);
    failures++;
  };
  /** True when --only is unset or matches the screenshot file name for this size and scheme. */
  const want = (name, size, scheme) => !only || `${name}-${size.w}-${scheme}`.includes(only);
  const wantAny = (names, size, scheme) => names.some((n) => want(n, size, scheme));

  async function shoot(page, name, size, scheme) {
    if (!want(name, size, scheme)) return;
    const file = join(shots, `${name}-${size.w}-${scheme}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    taken.push(file);
  }

  /** Opens the side panel on a scenario; `opts.edit` changes its canned data, `opts.init` are more init scripts (e.g. installVoiceFakes). */
  async function openPanel(ctx, kind, waitFor = "#chat-log > *", opts = {}) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const data = scenario(kind);
    opts.edit?.(data);
    for (const init of opts.init ?? []) await page.addInitScript(init);
    await page.addInitScript(installChromeStub, data);
    await page.goto(`${base}/sidepanel.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    try {
      // "attached": rows inside a folded steps group are in the log but not visible.
      await page.waitForSelector(waitFor, { state: "attached" });
    } catch (err) {
      console.error(`panel did not load (${kind}):`, errors);
      throw err;
    }
    page.errors = errors;
    return page;
  }

  function reportErrors(page, label) {
    if (page.errors.length) problem(`page errors (${label}):`, page.errors);
  }

  /** The composer sits flush at the bottom, nothing overlaps it, nothing in it is clipped. */
  async function checkLayout(page, label) {
    const problems = await page.evaluate(() => {
      const out = [];
      const comp = document.getElementById("composer");
      const main = document.querySelector("main");
      if (document.documentElement.scrollWidth > window.innerWidth) out.push("horizontal page scroll");
      // The tab row and the Chat action bar each stay on one line, inside the panel.
      const one = (sel, what) => {
        const row = document.querySelector(sel);
        if (!row || !row.offsetParent) return;
        const r = row.getBoundingClientRect();
        const kids = [...row.children].filter((k) => k.getBoundingClientRect().width);
        const top = kids[0]?.getBoundingClientRect().top;
        for (const k of kids) {
          const b = k.getBoundingClientRect();
          if (Math.abs(b.top - top) > 1 && !k.classList.contains("bar-sep")) out.push(`${what}: ${k.id || k.textContent.trim()} wraps`);
          if (b.right > r.right + 0.5) out.push(`${what}: ${k.id || k.textContent.trim()} clipped`);
        }
      };
      one(".tabs", "tab row");
      one(".chat-bar", "chat bar");
      const tab = document.querySelector(".tabs [aria-selected=true]")?.dataset.tab;
      // The TODO tab as one call to action (Log In signed out; Get a plan on a plan without the TODO list) has no composer.
      const ctaOnly = tab === "todo" && ["out", "locked"].includes(document.getElementById("tab-todo").dataset.auth);
      if (comp.hidden !== (tab === "history" || ctaOnly)) out.push(`composer ${comp.hidden ? "hidden" : "shown"} on the ${tab} tab${ctaOnly ? " (call to action)" : ""}`);
      if (comp.hidden) return out;
      const c = comp.getBoundingClientRect();
      if (Math.abs(c.bottom - window.innerHeight) > 1) out.push(`composer bottom ${c.bottom} != viewport ${window.innerHeight}`);
      if (main.getBoundingClientRect().bottom > c.top + 1) out.push("main overlaps the composer");
      for (const el of comp.querySelectorAll("button, input:not([type=file]), label, textarea")) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > c.right + 0.5 || r.left < c.left - 0.5) out.push(`#${el.id} clipped horizontally`);
      }
      // The model chip sits on one row with the other controls.
      const bar = comp.querySelector(".now-bar").getBoundingClientRect();
      for (const el of comp.querySelectorAll(".now-bar > *:not([hidden])")) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5)) out.push(`${el.id || el.className} wraps out of the control row`);
      }
      const menu = document.getElementById("model-menu");
      if (!menu.hidden) {
        const m = menu.getBoundingClientRect();
        if (m.left < 0 || m.right > window.innerWidth || m.top < 0) out.push("model menu off screen");
      }
      return out;
    });
    if (!problems.length) return;
    problem(`layout (${label}):`, problems);
  }

  /** Opens options.html (with a hash) on a scenario; `edit` changes the canned data first. */
  async function openOptions(size, scheme, kind, hash = "", edit = () => {}) {
    // Reduced motion: reveals open and close at once (options.css honours it), so checks need no settling time.
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const data = scenario(kind);
    edit(data);
    await page.addInitScript(installChromeStub, data);
    await page.goto(`${base}/options.html${hash}`);
    await page.waitForSelector("#helper-headline:not(:empty)", { state: "attached" });
    page.errors = errors;
    page.ctx = ctx;
    return page;
  }

  async function optChecks(page, label, checks) {
    const problems = [];
    for (const [what, ok] of checks) if (!(await ok())) problems.push(what);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) problems.push("horizontal page scroll");
    if (page.errors.length) problems.push(`page errors: ${page.errors.join("; ")}`);
    if (problems.length) {
      problem(`options (${label}):`, problems);
    }
  }

  async function optShot(page, name, size, scheme) {
    const file = join(shots, `${name}-${size.w}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    taken.push(file);
  }

  return {
    base,
    shots,
    taken,
    only,
    problem,
    failures: () => failures,
    want,
    wantAny,
    shoot,
    openPanel,
    reportErrors,
    checkLayout,
    openOptions,
    optChecks,
    optShot,
  };
}
