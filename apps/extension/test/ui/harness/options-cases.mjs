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

/** The visible billing buttons' labels (the Account tab has one at most). */
const billingButtons = (p) => p.locator("#panel-account button.billing-open:visible").allTextContents();

const onFree = (data) => {
  data.state.account = { ...data.state.account, plan: { id: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false } };
};

// Site logins: three saved logins behind a passphrase ("correct horse" in the stub), and the way out when it is forgotten.
const lockedVault = (d) => (d.vault = { exists: true, locked: true, sites: ["bank.example", "example.com", "news.ycombinator.com"] });
const sent = (p, type) => p.evaluate((t) => window.__requests.filter((r) => r.type === t).length, type);
/** Enters `passphrase` and waits until the answer is shown. */
async function tryPassphrase(p, passphrase) {
  const before = await sent(p, "vault.unlock");
  await p.fill("#vault-pass", passphrase);
  await p.click("#vault-unlock");
  await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "vault.unlock").length > n && !document.getElementById("vault-unlock").disabled, before);
}
const forgotProminent = (p) => p.evaluate(() => document.getElementById("vault-forgot-row").hasAttribute("data-prominent"));
const eraseQuestion = (p) => p.textContent("#vault-erase-question");
/** Forgot passphrase? then Erase saved logins (with `click`): the confirm step. */
async function armErase(p, click = (sel) => p.click(sel)) {
  await p.click("#vault-forgot");
  await click("#vault-erase");
  await p.waitForFunction(() => document.getElementById("vault-erase-question").textContent !== "");
}
const choosingPassphrase = async (p) =>
  (await p.getAttribute("#vault-pass", "placeholder")) === "Choose a passphrase" && (await p.textContent("#vault-unlock")) === "Set passphrase" && (await shown(p, "#vault-create-note"));

/** [name, scenario kind, hash, data edit, checks(page)] */
export const OPTION_CASES = [
  ["options-ai-auto", "ok", "#ai", onFree, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto says what it picks", async () => /picks Local Claude Code/.test(await p.textContent("#auto-pick"))],
    ["API key hidden under Auto", async () => !(await shown(p, "[data-secret=anthropicApiKey]"))],
    ["helper hidden under Auto", async () => !(await shown(p, "#helper-headline"))],
    ["hosted: plan inline with Get a plan", async () => /Free plan/.test(await p.textContent("#hosted-plan")) && (await shown(p, "#hosted-action"))],
    ["model select", async () => (await p.inputValue("#model-select")) === "claude-sonnet-5"],
  ]],
  // Auto takes the user's own Claude first: with the helper working it picks Local Claude Code even on a plan with credit.
  ["options-ai-auto-plus", "ok", "#ai", onPlus, (p) => [
    ["Auto checked", () => p.isChecked(radio("auto"))],
    ["Auto describes its order", async () => /Uses your own Claude first, then BrowserTODO AI/.test(await p.textContent("#panel-ai"))],
    ["Auto picks Local Claude Code over BrowserTODO AI", async () => /picks Local Claude Code/.test(await p.textContent("#auto-pick"))],
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
    d.state.brain = { ...d.state.brain, effective: null, note: "Sign in to use BrowserTODO AI" };
  }, (p) => [
    ["browsertodo AI disabled", async () => !(await p.isEnabled(radio("browsertodo")))],
    ["still shown as the saved choice", () => p.isChecked(radio("browsertodo"))],
    ["log in button", () => shown(p, "#hosted-signin")],
    ["signed-out problem explained", async () => /Logged out/.test(await p.textContent("#brain-problem"))],
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
  ["options-ai-nothing", "nobrain", "#ai", (d) => {
    d.state.settings.brain = "auto";
    d.state.account = { signedIn: false, signInConfigured: true, apiBase: d.state.account.apiBase, dashboardUrl: d.state.account.dashboardUrl };
  }, (p) => [
    ["Auto points signed-in Claude Code users at the helper", async () => /install the helper/.test(await p.textContent("#auto-pick"))],
  ]],
  ["options-ai-nohelper", "nobrain", "#ai", (d) => (d.state.settings.brain = "claude-code"), (p) => [
    ["helper not installed", async () => /not installed/.test(await p.textContent("#helper-headline"))],
    ["says signing in is not enough", async () => /not enough/.test(await p.textContent("#helper-details"))],
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
    // Both shortcuts, as Chrome assigned them, each with Change.
    ["open shortcut", async () => (await p.textContent("#shortcut-key")) === "Ctrl+." && (await p.textContent("#shortcut-change")) === "Change"],
    ["talk shortcut", async () => (await p.textContent("#voice-shortcut-key")) === "Ctrl+," && (await p.textContent("#voice-shortcut-change")) === "Change"],
    ["interval", async () => (await p.inputValue("#f-intervalMinutes")) === "15"],
    ["tasks at once", async () => (await p.inputValue("#f-maxParallelTasks")) === "2"],
  ]],
  ["options-logins", "ok", "#logins", () => {}, (p) => [
    ["saved sites", async () => (await p.locator("#vault-sites li").count()) === 2],
    ["no passphrase field when unlocked", async () => !(await shown(p, "#vault-locked"))],
  ]],
  ["options-logins-create", "ok", "#logins", (d) => (d.vault = { exists: false, locked: true, sites: [] }), (p) => [
    ["choose a passphrase", () => choosingPassphrase(p)],
    ["says up front that a forgotten passphrase means erasing", async () => (await p.textContent("#vault-create-note")) === "If you forget this passphrase, your saved logins can't be recovered; you'd erase them and add them again."],
    ["no Forgot passphrase? (nothing to forget yet)", async () => !(await shown(p, "#vault-forgot-row"))],
  ]],
  ["options-logins-locked", "ok", "#logins", lockedVault, (p) => [
    ["unlock field", async () => (await p.getAttribute("#vault-pass", "placeholder")) === "Passphrase" && (await p.textContent("#vault-unlock")) === "Unlock"],
    ["no create note", async () => !(await shown(p, "#vault-create-note"))],
    ["quiet Forgot passphrase? link", async () => (await shown(p, "#vault-forgot")) && !(await forgotProminent(p)) && (await p.textContent("#vault-forgot")) === "Forgot passphrase?"],
    ["its explanation closed", async () => !(await shown(p, "#vault-forgot-box")) && (await p.getAttribute("#vault-forgot", "aria-expanded")) === "false"],
    ["logins hidden while locked", async () => !(await shown(p, "#vault-open"))],
  ]],
  ["options-logins-wrong", "ok", "#logins", lockedVault, (p) => [
    ["two wrong tries: the link stays quiet", async () => (await tryPassphrase(p, "hunter2"), await tryPassphrase(p, "hunter3"), !(await forgotProminent(p)))],
    ["Wrong passphrase", async () => (await p.textContent("#vault-msg")) === "Wrong passphrase"],
    ["third wrong try in a row: Forgot passphrase? stands out", async () => (await tryPassphrase(p, "hunter4"), forgotProminent(p))],
    ["says why", async () => (await p.textContent("#vault-forgot-lead")) === "Wrong passphrase 3 times in a row."],
    ["no lockout: Unlock still enabled", () => p.isEnabled("#vault-unlock")],
    ["nothing erased", async () => (await sent(p, "vault.reset")) === 0],
  ]],
  ["options-logins-forgot", "ok", "#logins", lockedVault, (p) => [
    ["Forgot passphrase? opens the explanation", async () => (await p.click("#vault-forgot"), (await shown(p, "#vault-forgot-box")) && (await p.getAttribute("#vault-forgot", "aria-expanded")) === "true")],
    ["explains why it can't be recovered", async () => (await p.textContent("#vault-forgot-box p")).startsWith("Your passphrase can't be recovered: your logins are encrypted on this computer, and BrowserTODO never sees them.")],
    ["one way out: Erase saved logins, styled as danger", async () => (await p.textContent("#vault-erase")) === "Erase saved logins" && (await p.getAttribute("#vault-erase", "class")).includes("danger")],
    ["no question yet", async () => (await eraseQuestion(p)) === ""],
  ]],
  ["options-logins-confirm", "ok", "#logins", lockedVault, (p) => [
    // The second click confirms in the same place: asking must not move the button.
    ["Erase stays in place when it asks", async () => {
      await p.click("#vault-forgot");
      const before = await p.locator("#vault-erase").boundingBox();
      await p.click("#vault-erase");
      const after = await p.locator("#vault-erase").boundingBox();
      await p.click("#vault-erase-cancel");
      return before.x === after.x && before.y === after.y;
    }],
    // A double-click on Erase saved logins asks, but its second click (on the same button) never erases.
    ["a double-click only asks", async () => (await armErase(p, (sel) => p.dblclick(sel)), (await sent(p, "vault.reset")) === 0)],
    ["and selects no text", async () => (await p.evaluate(() => getSelection().toString())) === ""],
    ["the question names the count", async () => (await eraseQuestion(p)) === "Erase 3 saved logins? This can't be undone."],
    ["the same button confirms", async () => (await p.textContent("#vault-erase")) === "Yes, erase 3 logins"],
  ]],
  ["options-logins-erased", "ok", "#logins", lockedVault, (p) => [
    ["a second click erases", async () => {
      await armErase(p);
      await p.click("#vault-erase");
      await p.waitForSelector("#vault-create-note:not([hidden])");
      return (await sent(p, "vault.reset")) === 1;
    }],
    ["back to choosing a passphrase", () => choosingPassphrase(p)],
    ["the forgot steps are gone", async () => !(await shown(p, "#vault-forgot-row")) && !(await shown(p, "#vault-forgot-box"))],
    ["says what went and what next", async () => (await p.textContent("#vault-msg")) === "Erased 3 saved logins. Choose a new passphrase to start over."],
  ]],
  ["options-advanced", "ok", "#advanced", (d) => {
    d.state.settings.cloudEnabled = true;
    d.state.settings.apiBase = "https://tasks.example.com";
  }, (p) => [
    ["account server", async () => (await p.inputValue("#f-accountApiBase")) === scenario("ok").state.settings.accountApiBase],
    ["cloud fields shown", () => shown(p, "[data-secret=runnerKey]")],
  ]],
  // Account: plan and credit, and one billing button to the dashboard's Billing page (no Stripe buttons here).
  ["options-account-free", "opt-free", "#account", () => {}, (p) => [
    ["signed in", () => shown(p, "#acct-in")],
    ["one billing button: Choose a plan", async () => (await billingButtons(p)).join() === "Choose a plan"],
    ["says where plans are", async () => /Plans, top-ups and invoices are on your browsertodo dashboard\./.test(await p.textContent("#acct-billing"))],
    ["no subscribe, top-up or portal buttons", async () => (await p.locator("#panel-account button").allTextContents()).every((t) => !/Subscribe|Top up \$|\$\d|Manage billing|Change plan/.test(t))],
    ["API keys are not on the Account tab", async () => (await p.locator("#panel-account #keys-card").count()) === 0],
  ]],
  ["options-account-paid", "opt-paid", "#account", () => {}, (p) => [
    ["one billing button: Manage plan & billing", async () => (await billingButtons(p)).join() === "Manage plan & billing"],
    ["credit", async () => (await p.textContent("#acct-credit")) === "$25.40"],
    ["plan", async () => (await p.textContent("#acct-plan")) === "Plus"],
  ]],
  ["options-account-outofcredit", "opt-out", "#account", () => {}, (p) => [
    ["out of credit", async () => (await p.textContent("#acct-credit")) === "Out of usage credit"],
    ["note", async () => /paused until you top up/.test(await p.textContent("#acct-note"))],
    // On Free a plan is the way to credit.
    ["one billing button: Choose a plan", async () => (await billingButtons(p)).join() === "Choose a plan"],
  ]],
  ["options-account-paid-outofcredit", "opt-paid-out", "#account", () => {}, (p) => [
    ["plan", async () => (await p.textContent("#acct-plan")) === "Plus"],
    ["out of credit", async () => (await p.textContent("#acct-credit")) === "Out of usage credit"],
    ["one billing button: Top up or change plan", async () => (await billingButtons(p)).join() === "Top up or change plan"],
  ]],
  ["options-account-nobilling", "opt-nobilling", "#account", () => {}, (p) => [
    ["no billing button", async () => (await billingButtons(p)).length === 0],
    ["note", async () => /Billing isn't set up/.test(await p.textContent("#acct-note"))],
  ]],
  ["options-account-signedout", "opt-signedout", "#account", () => {}, (p) => [
    ["log in", () => shown(p, "#acct-signin")],
    ["no account", async () => !(await shown(p, "#acct-in"))],
  ]],
  // API keys: their own tab.
  ["options-keys-free", "opt-free", "#keys", () => {}, (p) => [
    ["on the API keys tab", async () => (await p.getAttribute("#tab-keys", "aria-selected")) === "true"],
    ["what keys come with, from the catalog", async () => (await p.textContent("#keys-locked-text")) === "API access to add TODO tasks comes with a paid plan."],
    ["Choose a plan", async () => (await p.textContent("#keys-billing-open")) === "Choose a plan" && (await shown(p, "#keys-billing-open"))],
    ["no key form", async () => !(await shown(p, "#keys-body"))],
  ]],
  ["options-keys-paid", "opt-paid", "#keys", () => {}, (p) => [
    ["keys listed", async () => (await p.locator("#keys-list li:not(.empty)").count()) === 2],
    ["create form", () => shown(p, "#key-create")],
    ["no plan button", async () => !(await shown(p, "#keys-locked"))],
  ]],
  ["options-keys-signedout", "opt-signedout", "#keys", () => {}, (p) => [
    ["log in", () => shown(p, "#keys-signin")],
    ["no key form", async () => !(await shown(p, "#keys-body")) && !(await shown(p, "#keys-locked"))],
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
      check("ArrowRight -> API keys, focused", (await selected("keys")) && (await p.evaluate(() => document.activeElement.id)) === "tab-keys");
      check("hash #keys", (await p.evaluate(() => location.hash)) === "#keys");
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
  // Free plan: every billing button opens the dashboard's Billing page in a new tab (never a Stripe page from
  // here); coming back to the page refreshes the account. #keys deep-links to the API keys tab, remembered.
  {
    name: "options-account-free",
    size: { w: 420 },
    scheme: "light",
    async run({ base, openOptions, optChecks }) {
      const p = await openOptions({ w: 420, h: 900 }, "light", "opt-free", "#ai");
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      const BILLING = "https://app.browsertodo.com/billing";
      const created = () => p.evaluate(() => window.__created.slice());
      const forced = () => p.evaluate(() => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length);
      check("Get a plan", (await p.textContent("#hosted-action")) === "Get a plan");
      await p.click("#hosted-action");
      await p.waitForFunction((u) => window.__created.includes(u), BILLING);
      check("AI tab Get a plan -> Billing page", (await created()).join() === BILLING);
      check("stays on the AI tab", (await p.getAttribute("#tab-ai", "aria-selected")) === "true");
      // Back from the dashboard: blur then focus (the tab was left) refreshes plan and credit once.
      const before = await forced();
      await p.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        dispatchEvent(new Event("blur"));
        dispatchEvent(new Event("focus"));
      });
      await p.waitForFunction((n) => window.__requests.filter((r) => r.type === "account.refresh" && r.force === true).length === n + 1, before);
      check("refreshed once on return", (await forced()) === before + 1);
      await p.click("#tab-account");
      await p.click("#acct-billing-open");
      await p.waitForFunction((u) => window.__created.filter((c) => c === u).length === 2, BILLING);
      await p.click("#acct-dashboard");
      await p.waitForFunction(() => window.__created.includes("https://app.browsertodo.com/"));
      await p.click("#tab-keys");
      await p.click("#keys-billing-open");
      await p.waitForFunction((u) => window.__created.filter((c) => c === u).length === 3, BILLING);
      check("no Stripe page asked for", !(await p.evaluate(() => window.__requests.some((r) => /billing/.test(r.type)))));
      check("only dashboard pages opened", (await created()).every((u) => u.startsWith("https://app.browsertodo.com/")));
      // A plain options.html opens the tab used last: API keys.
      await p.goto(`${base}/options.html`);
      await p.waitForSelector("#keys-locked:not([hidden])");
      check("last tab remembered: API keys", (await p.getAttribute("#tab-keys", "aria-selected")) === "true");
      await optChecks(p, "billing", checks);
      await p.ctx.close();
    },
  },
  // Site logins: wrong tries start over after a right one; Cancel closes the forgot steps; after the erase a new passphrase works.
  {
    name: "options-logins-recover",
    size: { w: 1280 },
    scheme: "light",
    async run({ openOptions, optChecks }) {
      const p = await openOptions({ w: 1280, h: 1000 }, "light", "ok", "#logins", lockedVault);
      const checks = [];
      const check = (what, ok) => checks.push([what, async () => ok]);
      for (const guess of ["a", "b", "c"]) await tryPassphrase(p, guess);
      check("3 wrong: prominent", await forgotProminent(p));
      await tryPassphrase(p, "correct horse");
      check("the right passphrase unlocks", (await shown(p, "#vault-open")) && (await p.textContent("#vault-msg")) === "Unlocked.");
      await p.click("#vault-lock");
      await p.waitForSelector("#vault-locked:not([hidden])");
      check("wrong tries start over after an unlock", !(await forgotProminent(p)));
      await p.click("#vault-forgot");
      await p.click("#vault-erase-cancel");
      check("Cancel closes and returns focus", !(await shown(p, "#vault-forgot-box")) && (await p.evaluate(() => document.activeElement.id)) === "vault-forgot");
      await armErase(p);
      await p.click("#vault-erase");
      await p.waitForSelector("#vault-create-note:not([hidden])");
      check("focus in the new passphrase field", (await p.evaluate(() => document.activeElement.id)) === "vault-pass");
      await tryPassphrase(p, "a new start");
      check("a new passphrase opens the empty vault", (await shown(p, "#vault-open")) && (await p.textContent("#vault-sites")) === "No saved logins yet.");
      check("says so", (await p.textContent("#vault-msg")) === "Passphrase set. Add your first login.");
      await optChecks(p, "logins-recover", checks);
      await p.ctx.close();
    },
  },
  // Paid: create an API key.
  {
    name: "options-apikeys",
    size: { w: 420 },
    scheme: "light",
    async run({ openOptions, optChecks, shots, taken }) {
      const p = await openOptions({ w: 420, h: 900 }, "light", "opt-paid", "#keys");
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
