// The options page cases of the UI harness. OPTION_CASES: [name, scenario kind, hash, data edit,
// checks(page)], screenshotted at every size and scheme; OPTION_FLOWS: interactions run once, at
// the size and scheme their screenshot names.
import { join } from "node:path";
import { eventually, shown } from "./checks.mjs";
import { scenario } from "./scenarios.mjs";

// Options page: tabs, the brain choices and what each reveals, Jev, tasks, logins, advanced.
// It opens in a browser tab, so a wide and a narrow viewport.
export const OPT_SIZES = [
  { w: 1280, h: 1000 },
  { w: 420, h: 900 },
];

const radio = (v) => `input[name=brain][value="${v}"]`;
const OPT_PLUS = { id: "plus", status: "active", currentPeriodEnd: new Date(Date.now() + 864e5 * 20).toISOString(), cancelAtPeriodEnd: false };
const onPlus = (data) => {
  data.state.account = {
    ...data.state.account,
    plan: OPT_PLUS,
    credit: { subscriptionCents: 1540, topupCents: 0, totalCents: 1540, periodGrantCents: 2000, periodEnd: OPT_PLUS.currentPeriodEnd },
  };
};

/** [name, scenario kind, hash, data edit, checks(page)] */
export const OPTION_CASES = [
  ["options-ai-auto", "ok", "#ai", () => {}, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto says what it picks", async () => /picks Local Claude Code/.test(await p.textContent("#auto-pick"))],
    ["API key hidden under Auto", async () => !(await shown(p, "[data-secret=anthropicApiKey]"))],
    ["helper hidden under Auto", async () => !(await shown(p, "#helper-headline"))],
    ["hosted: plan inline with Get a plan", async () => /Free plan/.test(await p.textContent("#hosted-plan")) && (await shown(p, "#hosted-action"))],
    ["model select", async () => (await p.inputValue("#model-select")) === "claude-sonnet-5"],
  ]],
  ["options-ai-hosted", "ok", "#ai", (d) => {
    onPlus(d);
    d.state.settings.brain = "browsertodo";
    d.state.brain = { ...d.state.brain, effective: "browsertodo" };
  }, (p) => [
    ["browsertodo AI enabled and checked", async () => (await p.isChecked(radio("browsertodo"))) && (await p.isEnabled(radio("browsertodo")))],
    ["credit inline", async () => /\$15\.40 usage credit left/.test(await p.textContent("#hosted-credit"))],
    ["no buy action on a paid plan with credit", async () => !(await shown(p, "#hosted-action"))],
    ["no problem note", async () => !(await shown(p, "#brain-problem"))],
  ]],
  ["options-ai-hosted-signedout", "opt-signedout", "#ai", (d) => {
    d.state.settings.brain = "browsertodo";
    d.state.brain = { ...d.state.brain, effective: null, note: "Sign in to use browsertodo AI" };
  }, (p) => [
    ["browsertodo AI disabled", async () => !(await p.isEnabled(radio("browsertodo")))],
    ["still shown as the saved choice", () => p.isChecked(radio("browsertodo"))],
    ["log in button", () => shown(p, "#hosted-signin")],
    ["signed-out problem explained", async () => /logged out, so no tasks run/.test(await p.textContent("#brain-problem"))],
  ]],
  ["options-ai-signedout", "opt-signedout", "#ai", () => {}, (p) => [
    ["browsertodo AI disabled", async () => !(await p.isEnabled(radio("browsertodo")))],
    ["log in button", () => shown(p, "#hosted-signin")],
    ["no credit shown", async () => !(await shown(p, "#hosted-in"))],
  ]],
  ["options-ai-claudecode", "ok", "#ai", (d) => (d.state.settings.brain = "claude-code"), (p) => [
    ["helper shown", () => shown(p, "#helper-headline")],
    ["no install steps when connected", async () => !(await shown(p, "#helper-install"))],
    ["API key hidden", async () => !(await shown(p, "[data-secret=anthropicApiKey]"))],
  ]],
  ["options-ai-nohelper", "nobrain", "#ai", (d) => (d.state.settings.brain = "claude-code"), (p) => [
    ["helper not connected", async () => /not connected/.test(await p.textContent("#helper-headline"))],
    ["install steps", () => shown(p, "#helper-install")],
    ["Connect button", async () => (await p.textContent("#helper-connect")) === "Connect"],
  ]],
  ["options-ai-claudeapi", "ok", "#ai", (d) => (d.state.settings.brain = "claude-api"), (p) => [
    ["API key shown", () => shown(p, "[data-secret=anthropicApiKey]")],
    ["Test key shown", () => shown(p, "#test-claude")],
    ["key is set", async () => /Set/.test(await p.textContent("[data-secret=anthropicApiKey]"))],
    ["helper hidden", async () => !(await shown(p, "#helper-headline"))],
  ]],
  ["options-ai-nokey", "nobrain", "#ai", (d) => (d.state.settings.brain = "claude-api"), (p) => [
    ["key input", () => shown(p, "[data-secret=anthropicApiKey] input")],
    ["missing key hint", () => shown(p, "#api-key-missing")],
    ["Save disabled until typed", async () => !(await p.isEnabled("[data-secret=anthropicApiKey] button.primary"))],
  ]],
  ["options-speed-on", "ok", "#jev", () => {}, (p) => [
    ["on the Speed tab", async () => (await p.getAttribute("#tab-speed", "aria-selected")) === "true"],
    ["hash normalised", async () => (await p.evaluate(() => location.hash)) === "#speed"],
    ["Jev key shown", () => shown(p, "[data-secret=jevApiKey]")],
    ["threshold shown", () => shown(p, "#f-jevThreshold")],
  ]],
  ["options-speed-off", "ok", "#speed", (d) => (d.state.settings.jevEnabled = false), (p) => [
    ["Jev key hidden", async () => !(await shown(p, "[data-secret=jevApiKey]"))],
    ["test hidden", async () => !(await shown(p, "#test-jev"))],
  ]],
  ["options-tasks", "ok", "#tasks", () => {}, (p) => [
    ["interval", async () => (await p.inputValue("#f-intervalMinutes")) === "15"],
    ["tasks at once", async () => (await p.inputValue("#f-maxParallelTasks")) === "2"],
  ]],
  ["options-logins", "ok", "#logins", () => {}, (p) => [
    ["saved sites", async () => (await p.locator("#vault-sites li").count()) === 2],
  ]],
  ["options-advanced", "ok", "#advanced", (d) => {
    d.state.settings.cloudEnabled = true;
    d.state.settings.apiBase = "https://tasks.example.com";
  }, (p) => [
    ["account server", async () => (await p.inputValue("#f-accountApiBase")) === scenario("ok").state.settings.accountApiBase],
    ["cloud fields shown", () => shown(p, "[data-secret=runnerKey]")],
  ]],
  ["options-account-free", "opt-free", "#account", () => {}, (p) => [
    ["signed in", () => shown(p, "#acct-in")],
    ["plans", async () => (await p.locator("#acct-plans .plan").count()) === 3],
    ["keys locked", () => shown(p, "#keys-locked")],
  ]],
  ["options-account-paid", "opt-paid", "#account", () => {}, (p) => [
    ["portal", () => shown(p, "#acct-portal")],
    ["keys listed", async () => (await p.locator("#keys-list li:not(.empty)").count()) === 2],
    ["credit", async () => (await p.textContent("#acct-credit")) === "$25.40"],
  ]],
  ["options-account-outofcredit", "opt-out", "#account", () => {}, (p) => [
    ["out of credit", async () => (await p.textContent("#acct-credit")) === "Out of usage credit"],
    ["note", async () => /paused until you top up/.test(await p.textContent("#acct-note"))],
  ]],
  ["options-account-nobilling", "opt-nobilling", "#account", () => {}, (p) => [
    ["no billing buttons", async () => !(await shown(p, "#acct-plans")) && !(await shown(p, "#acct-portal"))],
    ["note", async () => /Billing isn't set up/.test(await p.textContent("#acct-note"))],
  ]],
  ["options-account-signedout", "opt-signedout", "#account", () => {}, (p) => [
    ["log in", () => shown(p, "#acct-signin")],
    ["no account", async () => !(await shown(p, "#acct-in")) && !(await shown(p, "#keys-card"))],
  ]],
];

export const OPTION_FLOWS = [
  // Interactions (wide, light): tabs by keyboard and hash, reveals, auto-save, keys, model, validation, Jev, sign-in.
  {
    name: "options-validation",
    size: { w: 1280 },
    scheme: "light",
    async run({ base, openOptions, optChecks, optShot }) {
      const size = { w: 1280, h: 1000 };
      const p = await openOptions(size, "light", "opt-signedout", "");
      const saves = () => p.evaluate(() => window.__requests.filter((r) => r.type === "settings.save").map((r) => r.settings));
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const selected = async (id) => (await p.getAttribute(`#tab-${id}`, "aria-selected")) === "true";
      /** Runs `action`, then waits until the auto-save it causes is answered. */
      const autoSaved = async (action) => {
        const before = (await saves()).length;
        await action();
        await p.waitForFunction(
          (n) => window.__requests.filter((r) => r.type === "settings.save").length > n && document.getElementById("save-msg").textContent !== "Saving…",
          before,
        );
      };
      /** Runs `action`, then waits until the auto-save refuses it (a field is invalid: nothing is sent). */
      const autoRefused = async (action) => {
        await action();
        await p.waitForFunction(() => document.getElementById("save-msg").textContent.startsWith("Not saved"));
      };

      check("first tab by default", await selected("account"));
      await p.focus("#tab-account");
      await p.keyboard.press("ArrowRight");
      check("ArrowRight -> AI, focused", (await selected("ai")) && (await p.evaluate(() => document.activeElement.id)) === "tab-ai");
      check("hash #ai", (await p.evaluate(() => location.hash)) === "#ai");
      check("only the AI panel shows", (await shown(p, "#panel-ai")) && !(await shown(p, "#panel-account")));
      await p.keyboard.press("End");
      check("End -> Advanced", await selected("advanced"));
      await p.keyboard.press("ArrowRight");
      check("ArrowRight wraps to Account", await selected("account"));
      // Our hashchange listener runs after the page's.
      await p.evaluate(() => new Promise((r) => (addEventListener("hashchange", () => r(), { once: true }), (location.hash = "#vault"))));
      check("hash #vault -> Site logins", await selected("logins"));
      await p.click("#tab-ai");
      await p.goto(`${base}/options.html`);
      await p.waitForSelector("#helper-headline:not(:empty)", { state: "attached" });
      check("no hash: the last tab", await selected("ai"));

      // Signed out: browsertodo AI is disabled; Log in runs sign-in and enables it.
      check("hosted disabled", !(await p.isEnabled(radio("browsertodo"))));
      await p.click("#hosted-signin");
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.signIn"));
      check("hosted enabled after sign-in", await eventually(() => p.isEnabled(radio("browsertodo"))));
      check("signed in: plan inline", await shown(p, "#hosted-in"));

      // Claude API reveals the key and saves the choice by itself.
      check("key hidden before", !(await shown(p, "[data-secret=anthropicApiKey]")));
      await autoSaved(() => p.click(`.opt[data-brain="claude-api"] .opt-head`));
      check("key revealed", await shown(p, "[data-secret=anthropicApiKey]"));
      check("brain auto-saved", (await saves()).some((s) => s.brain === "claude-api"));
      check("Saved note", /Saved/.test(await p.textContent("#save-msg")));
      await autoSaved(() => p.click(`.opt[data-brain="claude-code"] .opt-head`));
      check("helper revealed, key hidden", (await shown(p, "#helper-headline")) && !(await shown(p, "[data-secret=anthropicApiKey]")));

      // Key: Replace, type, Save sends only that key.
      await autoSaved(() => p.click(`.opt[data-brain="claude-api"] .opt-head`));
      await p.click("[data-secret=anthropicApiKey] button:has-text('Replace')");
      await p.fill("[data-secret=anthropicApiKey] input", "sk-ant-new");
      await p.click("[data-secret=anthropicApiKey] button:has-text('Save')");
      check("key saved alone", await eventually(async () => (await saves()).some((s) => s.anthropicApiKey === "sk-ant-new" && Object.keys(s).length === 1)));
      check("key saved note", /saved/.test(await p.textContent("[data-secret=anthropicApiKey] .msg")));

      // Model: a known model saves right away; Custom… shows the id field.
      await autoSaved(() => p.selectOption("#model-select", "claude-opus-5-5"));
      check("model saved", (await saves()).some((s) => s.anthropicModel === "claude-opus-5-5"));
      check("custom field hidden", !(await shown(p, "#f-anthropicModel")));
      await p.selectOption("#model-select", "custom");
      check("custom field shown", await shown(p, "#f-anthropicModel"));
      await autoSaved(() => p.fill("#f-anthropicModel", "claude-test-model"));
      check("custom model saved", (await saves()).some((s) => s.anthropicModel === "claude-test-model"));

      // Validation: out of range is explained and not saved; fixing it saves.
      await p.click("#tab-tasks");
      const before = (await saves()).length;
      await autoRefused(() => p.fill("#f-maxParallelTasks", "9"));
      check("range error", /1 to 4/.test(await p.textContent("#err-maxParallelTasks")));
      check("invalid not saved", (await saves()).length === before);
      await autoSaved(() => p.fill("#f-maxParallelTasks", "3"));
      check("error cleared", (await p.textContent("#err-maxParallelTasks")) === "");
      check("fixed value saved", (await saves()).some((s) => s.maxParallelTasks === 3));
      await autoRefused(() => p.fill("#f-delayMaxSec", "10"));
      check("longest pause below shortest", /at least the shortest/.test(await p.textContent("#err-delayMaxSec")));
      await optShot(p, "options-validation", size, "light");

      // Jev off hides its key; on shows it again.
      await p.click("#tab-speed");
      await autoSaved(() => p.click("#f-jevEnabled"));
      check("Jev off saved", (await saves()).some((s) => s.jevEnabled === false));
      check("Jev key hidden", !(await shown(p, "[data-secret=jevApiKey]")));
      await autoSaved(() => p.click("#f-jevEnabled"));
      check("Jev key shown", await shown(p, "[data-secret=jevApiKey]"));
      await optChecks(p, "interactions", checks);
      await p.ctx.close();
    },
  },
  // Free plan: "Get a plan" under browsertodo AI opens the Account tab; Subscribe and Top up ask for a Stripe page.
  {
    name: "options-account-free",
    size: { w: 420 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 420, h: 900 }, "light", "opt-free", "#ai");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      check("Get a plan", (await p.textContent("#hosted-action")) === "Get a plan");
      await p.click("#hosted-action");
      check("-> Account tab", (await p.getAttribute("#tab-account", "aria-selected")) === "true");
      await p.locator("#acct-plans .plan").nth(1).click();
      // Stripe opens in a new tab (chrome.tabs.create, as in the extension).
      await p.waitForFunction(() => window.__created.includes("https://checkout.stripe.com/c/pay/cs_test_harness"));
      const req = await p.evaluate(() => window.__requests.find((r) => r.type === "account.billing"));
      check("checkout request", req.action === "checkout" && req.plan === "plus" && req.returnUrl === "https://app.browsertodo.com/billing");
      await p.locator("#acct-topup button", { hasText: "$25.00" }).click();
      await p.waitForFunction(() => window.__requests.some((r) => r.type === "account.billing" && r.action === "topup" && r.amountCents === 2500));
      await optChecks(p, "billing", checks);
      await p.ctx.close();
    },
  },
  // Paid: create an API key.
  {
    name: "options-apikeys",
    size: { w: 420 },
    scheme: "light",
    async run({ openOptions, optChecks, shots, taken }) {
      const p = await openOptions({ w: 420, h: 900 }, "light", "opt-paid", "#account");
      await p.fill("#key-name", "ci pipeline");
      await p.click("#key-create");
      await p.waitForSelector("#key-new:not([hidden])");
      await optChecks(p, "apikeys", [
        ["new key shown", async () => (await p.locator("#key-value").textContent()) === "bt_EXAMPLE_not_a_real_key_0000000000000000"],
        ["3 keys", async () => (await p.locator("#keys-list li:not(.empty)").count()) === 3],
      ]);
      const kf = join(shots, "options-apikeys-420-light.png");
      await p.locator("#keys-card").screenshot({ path: kf });
      taken.push(kf);
      await p.ctx.close();
    },
  },
];
