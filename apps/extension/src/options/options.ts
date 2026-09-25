/**
 * Options page: tabs for the account, the AI (brain, key, model, helper),
 * Jev, task scheduling, site logins and self-hosting. Settings save by
 * themselves as they change; keys save with their own Save button.
 * What shows when comes from settingsView() (settings-view.ts).
 */
import type { BrainMode, ExtensionSettings } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash, h } from "../sidepanel/dom.js";
import { brainLabel } from "../sidepanel/format.js";
import { initAccountSection } from "./account-section.js";
import { initVaultSection } from "./vault-section.js";
import { adjustedFields, buildSettingsPatch, helperStatus, SECRET_KEYS, type SecretKey } from "./settings-patch.js";
import {
  BOOL_FIELDS,
  CUSTOM_MODEL,
  formValues,
  modelOptions,
  NUMBER_FIELDS,
  parseForm,
  settingsView,
  TEXT_FIELDS,
  validateForm,
  type Draft,
  type FormValues,
  type Tone,
} from "./settings-view.js";
import { initTabs } from "./tabs.js";

const LABELS: Partial<Record<keyof ExtensionSettings, string>> = {
  jevThreshold: "Jev threshold",
  intervalMinutes: "check interval",
  delayMinSec: "shortest pause",
  delayMaxSec: "longest pause",
  maxToolCalls: "most tool calls",
  maxTaskMinutes: "longest run",
  maxParallelTasks: "tasks at once",
  retryAfterMinutes: "retry after",
  pauseRetryMinutes: "retry needed-you tasks after",
  maxConsecutiveFailures: "failure limit",
};
const SECRET_LABELS: Record<SecretKey, string> = { anthropicApiKey: "Anthropic API key", jevApiKey: "Jev API key", runnerKey: "Runner key" };

const form = $<HTMLFormElement>("form");
const saveMsg = $("save-msg");
const modelSelect = $<HTMLSelectElement>("model-select");
const input = (key: string) => $<HTMLInputElement>(`f-${key}`);
const tabs = initTabs();

let state: UiState | null = null;
let saved: ExtensionSettings | null = null;

modelSelect.replaceChildren(
  ...modelOptions().map((m) => h("option", { value: m.id }, m.label)),
  h("option", { value: CUSTOM_MODEL }, "Custom…"),
);

// ------------------------------------------------------------ form <-> settings

function readValues(): FormValues {
  const brain = (form.querySelector<HTMLInputElement>("input[name=brain]:checked")?.value ?? saved?.brain ?? "auto") as BrainMode;
  const out: Record<string, unknown> = { brain };
  for (const k of NUMBER_FIELDS) out[k] = input(k).value;
  for (const k of TEXT_FIELDS) out[k] = input(k).value;
  for (const k of BOOL_FIELDS) out[k] = input(k).checked;
  return out as FormValues;
}

function fillForm(s: ExtensionSettings, only?: (keyof ExtensionSettings)[]): void {
  const v = formValues(s);
  const want = (k: keyof ExtensionSettings) => !only || only.includes(k);
  if (want("brain")) for (const r of form.querySelectorAll<HTMLInputElement>("input[name=brain]")) r.checked = r.value === v.brain;
  for (const k of NUMBER_FIELDS) if (want(k)) input(k).value = v[k];
  for (const k of TEXT_FIELDS) if (want(k)) input(k).value = v[k];
  for (const k of BOOL_FIELDS) if (want(k)) input(k).checked = v[k];
  if (want("anthropicModel")) {
    const known = [...modelSelect.options].some((o) => o.value === v.anthropicModel && o.value !== CUSTOM_MODEL);
    modelSelect.value = known ? v.anthropicModel : CUSTOM_MODEL;
  }
}

/** Show (or clear) each field's problem; returns true when every field is fine. */
function showErrors(onlyTouched = true): boolean {
  const errors = validateForm(readValues());
  let ok = true;
  for (const k of [...NUMBER_FIELDS, ...TEXT_FIELDS]) {
    const el = input(k);
    const msg = errors[k] ?? "";
    if (msg) ok = false;
    if (onlyTouched && !el.dataset.touched && msg) continue;
    el.setAttribute("aria-invalid", String(!!msg));
    $(`err-${k}`).textContent = msg;
  }
  return ok;
}

// ------------------------------------------------------------ saving

let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function status(text: string, tone: "ok" | "bad" | "" = "ok"): void {
  saveMsg.textContent = text;
  saveMsg.dataset.tone = tone;
  saveMsg.classList.toggle("show", !!text);
  clearTimeout(hideTimer);
  if (tone === "ok" && text) hideTimer = setTimeout(() => saveMsg.classList.remove("show"), 1800);
}

/** Saves whatever differs from the saved settings (fields with a problem are left out). */
async function saveChanged(): Promise<boolean> {
  if (!saved) return true;
  const valid = showErrors();
  const patch = buildSettingsPatch(saved, parseForm(readValues()), {});
  const ok = Object.keys(patch).length ? await sendPatch(patch) : true;
  // Fields with a problem keep their saved value until fixed.
  if (ok && !valid && form.querySelector("[aria-invalid=true]")) status("Not saved: fix the field marked in red", "bad");
  return ok;
}

async function sendPatch(patch: Partial<ExtensionSettings>): Promise<boolean> {
  status("Saving…", "");
  try {
    const next = await uiRequest({ type: "settings.save", settings: patch });
    const adjusted = adjustedFields(patch, next.settings);
    applyState(next);
    if (adjusted.length) {
      fillForm(next.settings, adjusted);
      status(`Saved. Changed to the allowed range: ${adjusted.map((k) => LABELS[k] ?? k).join(", ")}`, "bad");
    } else status("Saved");
    return true;
  } catch (err) {
    status(`Not saved: ${errorText(err)}`, "bad");
    return false;
  }
}

/** Queue a save; `delay` lets typing settle first. */
function scheduleSave(delay = 0): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    chain = chain.then(() => saveChanged().then(() => undefined));
  }, delay);
}

/** Save anything pending now (before a test). */
async function flush(): Promise<boolean> {
  clearTimeout(timer);
  timer = undefined;
  let ok = true;
  chain = chain.then(async () => {
    ok = await saveChanged();
  });
  await chain;
  return ok;
}

form.addEventListener("submit", (e) => e.preventDefault());
form.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.id?.startsWith("f-")) return;
  t.dataset.touched = "1";
  if (t.type === "checkbox") return;
  render();
  scheduleSave(700);
});
form.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === "brain" || t.id?.startsWith("f-")) {
    t.dataset.touched = "1";
    render();
    scheduleSave();
  }
});
modelSelect.addEventListener("change", () => {
  const custom = input("anthropicModel");
  if (modelSelect.value === CUSTOM_MODEL) {
    render();
    custom.select();
    custom.focus();
    return;
  }
  custom.value = modelSelect.value;
  render();
  scheduleSave();
});

// ------------------------------------------------------------ keys (masked fields)

/** Keys being replaced (Replace clicked), per key. */
const replacing = new Set<SecretKey>();
const secretNotes: Partial<Record<SecretKey, { text: string; tone: "ok" | "bad" | "" }>> = {};

function renderSecret(key: SecretKey): void {
  const host = document.querySelector<HTMLElement>(`[data-secret=${key}]`)!;
  const label = host.querySelector("span")!;
  const isSet = saved?.[key] === "set";
  // A note from the last action on this key shows once, in the re-rendered field.
  const note = h("p.msg", { role: "status" });
  const last = secretNotes[key];
  delete secretNotes[key];
  if (last) flash(note, last.text, last.tone);
  const say = (text: string, tone: "ok" | "bad" | "" = "") => flash(note, text, tone);
  const done = (text: string) => {
    secretNotes[key] = { text, tone: "ok" };
    renderSecret(key);
  };
  let row: HTMLElement;
  if (isSet && !replacing.has(key)) {
    const remove = h("button.small.danger", { type: "button" }, "Remove");
    remove.addEventListener("click", () =>
      void busy(remove, async () => {
        if (await sendPatch({ [key]: "" })) done(`${SECRET_LABELS[key]} removed.`);
      }),
    );
    row = h(
      "div.secret-row",
      null,
      h("div.secret-state", null, h("b", null, "Set"), h("span", null, "••••••••")),
      h("button.small", { type: "button", onclick: () => { replacing.add(key); renderSecret(key); host.querySelector("input")?.focus(); } }, "Replace"),
      remove,
    );
  } else {
    const field = h("input", {
      type: "password",
      placeholder: isSet ? "New key" : "Paste the key",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": SECRET_LABELS[key],
    });
    const save = h("button.small.primary", { type: "button", disabled: true }, "Save");
    const doSave = () =>
      void busy(save, async () => {
        const value = field.value.trim();
        if (!value) return say("Paste a key first.", "bad");
        replacing.delete(key);
        if (await sendPatch({ [key]: value })) done(`${SECRET_LABELS[key]} saved.`);
        else replacing.add(key);
      }).then(() => {
        save.disabled = !field.value.trim();
      });
    field.addEventListener("input", () => (save.disabled = !field.value.trim()));
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSave();
      } else if (e.key === "Escape" && isSet) {
        replacing.delete(key);
        renderSecret(key);
      }
    });
    save.addEventListener("click", doSave);
    row = h(
      "div.secret-row",
      null,
      field,
      save,
      isSet ? h("button.small.ghost", { type: "button", onclick: () => { replacing.delete(key); renderSecret(key); } }, "Cancel") : null,
    );
  }
  host.replaceChildren(label, row, note);
}

// ------------------------------------------------------------ rendering

function draft(): Draft {
  const v = readValues();
  return { brain: v.brain, jevEnabled: v.jevEnabled, cloudEnabled: v.cloudEnabled, anthropicModel: v.anthropicModel };
}

/** Opens or closes a revealed block; closed blocks are inert (not focusable). */
function reveal(el: Element, open: boolean): void {
  el.classList.toggle("open", open);
  (el as HTMLElement).inert = !open;
}

function setTone(el: HTMLElement, tone: Tone): void {
  el.dataset.tone = tone;
}

/** Everything that depends on the settings on screen and the background's state. */
function render(): void {
  if (!state || !saved) return;
  const d = draft();
  const v = settingsView({ settings: saved, draft: d, brain: state.brain, account: state.account });

  for (const o of v.options) {
    const row = document.querySelector<HTMLElement>(`.opt[data-brain="${o.value}"]`)!;
    const radio = row.querySelector<HTMLInputElement>("input[type=radio]")!;
    radio.disabled = !o.enabled;
    row.querySelector(".opt-detail")!.textContent = o.detail;
    const more = row.querySelector(".reveal");
    if (more) reveal(more, d.brain === o.value);
  }
  const pick = $("auto-pick");
  pick.querySelector(".t")!.textContent = v.autoPick.text;
  setTone(pick, v.autoPick.tone);
  setTone(pick.querySelector<HTMLElement>(".dot")!, v.autoPick.tone);

  $("hosted-out").hidden = !v.showHostedSignIn;
  $("hosted-in").hidden = !v.hosted;
  if (v.hosted) {
    $("hosted-plan").textContent = v.hosted.plan;
    $("hosted-credit").textContent = v.hosted.credit;
    setTone($("hosted-credit"), v.hosted.tone);
    const action = $<HTMLButtonElement>("hosted-action");
    action.hidden = !v.hosted.action;
    action.textContent = v.hosted.action?.label ?? "";
  }
  const problem = $("brain-problem");
  problem.hidden = !v.brainProblem;
  problem.textContent = v.brainProblem ?? "";

  $("api-key-missing").hidden = !v.apiKeyMissing;
  $("model-group").hidden = !v.showModel;
  const custom = modelSelect.value === CUSTOM_MODEL;
  input("anthropicModel").hidden = !custom;
  $("model-hint").textContent = v.model.hint;

  reveal($("jev-fields"), v.showJevFields);
  const jevSource = $("jev-source");
  jevSource.textContent = v.jevNote ?? "";
  reveal($("cloud-fields"), v.showCloudFields);
}

function renderState(s: UiState): void {
  state = s;
  accountSection.render(s);
  const b = s.brain;
  const now = $("now-using");
  if (b.effective) {
    $("now-text").textContent = `Running tasks with ${brainLabel(b.effective, b.jevActive)}${b.note ? ` · ${b.note}` : ""}`;
    now.dataset.tone = "ok";
  } else {
    $("now-text").textContent = b.note || "Nothing can run tasks yet. Pick a brain on the AI tab.";
    now.dataset.tone = "bad";
  }
  setTone($("now-dot"), b.effective ? "ok" : "bad");

  const hs = helperStatus(b.helper, b.helperError);
  $("helper-dot").dataset.tone = hs.tone;
  $("helper-headline").textContent = hs.headline;
  $("helper-details").replaceChildren(...hs.details.map((d) => h("li", null, d)));
  $("helper-install").hidden = !!b.helper;
  $("helper-connect").textContent = b.helper ? "Re-check" : "Connect";
  render();
}

/** A new state from the background: new saved settings, keys re-rendered. */
function applyState(s: UiState): void {
  saved = s.settings;
  for (const k of SECRET_KEYS) renderSecret(k);
  renderState(s);
}

/** Plan and credit on the Account tab, highlighted. */
function showBilling(): void {
  tabs.show("account");
  const target = $("acct-in").hidden ? $("account-card") : $("h-plan").nextElementSibling as HTMLElement;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("flash-target");
  void target.offsetWidth;
  target.classList.add("flash-target");
}

const accountSection = initAccountSection({ onState: (s) => renderState(s), showBilling });
const hostedSignIn = $<HTMLButtonElement>("hosted-signin");
hostedSignIn.addEventListener("click", () => accountSection.signIn(hostedSignIn, $("hosted-signin-msg")));
$("hosted-action").addEventListener("click", showBilling);

// ------------------------------------------------------------ tests and helper

function testButton(id: string, type: "settings.testClaude" | "settings.testJev" | "settings.testCloud"): void {
  const btn = $<HTMLButtonElement>(id);
  const msg = $(`${id}-msg`);
  btn.addEventListener("click", () =>
    void busy(btn, async () => {
      flash(msg, "Testing…");
      // Test what is on screen: save pending edits first.
      if (!(await flush())) return flash(msg, "Save failed; fix the settings first.", "bad");
      try {
        const res = await uiRequest({ type });
        flash(msg, res.detail || (res.ok ? "Works." : "Failed."), res.ok ? "" : "bad");
        msg.dataset.tone = res.ok ? "ok" : "bad";
      } catch (err) {
        flash(msg, errorText(err), "bad");
      }
    }),
  );
}
testButton("test-claude", "settings.testClaude");
testButton("test-jev", "settings.testJev");
testButton("test-cloud", "settings.testCloud");

const connectBtn = $<HTMLButtonElement>("helper-connect");
connectBtn.addEventListener("click", () =>
  void busy(connectBtn, async () => {
    const msg = $("helper-msg");
    flash(msg, "Connecting… (the self-test can take up to a minute)");
    try {
      const s = await uiRequest({ type: "helper.connect" });
      renderState(s);
      flash(msg, s.brain.helper ? "" : s.brain.helperError || "Helper not found.", s.brain.helper ? "" : "bad");
    } catch (err) {
      flash(msg, errorText(err), "bad");
    }
  }),
);

async function main(): Promise<void> {
  try {
    const s = await uiRequest({ type: "state.get" });
    fillForm(s.settings);
    applyState(s);
    showErrors(false);
    // Fresh plan and credit (e.g. back from a Stripe page).
    renderState(await uiRequest({ type: "account.refresh", force: true }));
  } catch (err) {
    $("now-text").textContent = `Background not reachable: ${errorText(err)}`;
    $("now-using").dataset.tone = "bad";
  }
}

void main();
initVaultSection();
