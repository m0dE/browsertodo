/** Options page: account and API keys, brain, Jev, self-hosting (account server, cloud sync) and advanced settings. */
import type { BrainMode, ExtensionSettings } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, busy, errorText, flash, h } from "../sidepanel/dom.js";
import { brainLabel, KNOWN_MODELS } from "../sidepanel/format.js";
import { initAccountSection } from "./account-section.js";
import { initVaultSection } from "./vault-section.js";
import {
  adjustedFields,
  buildSettingsPatch,
  helperStatus,
  parseNumber,
  SECRET_KEYS,
  type SecretEdit,
  type SecretKey,
} from "./settings-patch.js";

const NUMBER_FIELDS = [
  "jevThreshold",
  "intervalMinutes",
  "delayMinSec",
  "delayMaxSec",
  "maxToolCalls",
  "maxTaskMinutes",
  "maxParallelTasks",
  "retryAfterMinutes",
  "pauseRetryMinutes",
  "maxConsecutiveFailures",
] as const satisfies readonly (keyof ExtensionSettings)[];
const TEXT_FIELDS = ["anthropicModel", "apiBase", "accountApiBase"] as const satisfies readonly (keyof ExtensionSettings)[];
const BOOL_FIELDS = ["jevEnabled", "cloudEnabled"] as const satisfies readonly (keyof ExtensionSettings)[];

const LABELS: Partial<Record<keyof ExtensionSettings, string>> = {
  jevThreshold: "Jev threshold",
  intervalMinutes: "check interval",
  delayMinSec: "min pause",
  delayMaxSec: "max pause",
  maxToolCalls: "max tool calls",
  maxTaskMinutes: "max minutes",
  maxParallelTasks: "tasks at once",
  retryAfterMinutes: "retry after",
  pauseRetryMinutes: "retry needed-you tasks after",
  maxConsecutiveFailures: "failure limit",
};

const form = $<HTMLFormElement>("form");
const saveBtn = $<HTMLButtonElement>("save");
const revertBtn = $<HTMLButtonElement>("revert");
const saveMsg = $("save-msg");

let saved: ExtensionSettings | null = null;
let secrets: Partial<Record<SecretKey, SecretEdit>> = {};

const input = (key: string) => $<HTMLInputElement>(`f-${key}`);

$("model-ids").replaceChildren(...KNOWN_MODELS.map((m) => h("option", { value: m.id }, m.label)));

function readForm(): Partial<Omit<ExtensionSettings, SecretKey>> {
  const out: Record<string, unknown> = {};
  const brain = form.querySelector<HTMLInputElement>("input[name=brain]:checked")?.value as BrainMode | undefined;
  if (brain) out.brain = brain;
  for (const k of NUMBER_FIELDS) out[k] = parseNumber(input(k).value);
  for (const k of TEXT_FIELDS) out[k] = input(k).value.trim();
  for (const k of BOOL_FIELDS) out[k] = input(k).checked;
  if (typeof out.apiBase === "string") out.apiBase = out.apiBase.replace(/\/+$/, "");
  if (typeof out.accountApiBase === "string") out.accountApiBase = out.accountApiBase.replace(/\/+$/, "");
  return out as Partial<Omit<ExtensionSettings, SecretKey>>;
}

function currentPatch(): Partial<ExtensionSettings> {
  return saved ? buildSettingsPatch(saved, readForm(), secrets) : {};
}

function fillForm(s: ExtensionSettings): void {
  for (const r of form.querySelectorAll<HTMLInputElement>("input[name=brain]")) r.checked = r.value === s.brain;
  for (const k of NUMBER_FIELDS) input(k).value = String(s[k]);
  for (const k of TEXT_FIELDS) input(k).value = s[k];
  for (const k of BOOL_FIELDS) input(k).checked = s[k];
  secrets = {};
  for (const k of SECRET_KEYS) renderSecret(k);
  onChange();
}

/** Masked key field: shows "set" with Replace / Clear, or an input. */
function renderSecret(key: SecretKey): void {
  const host = document.querySelector<HTMLElement>(`[data-secret=${key}]`)!;
  const label = host.querySelector("span")!;
  const isSet = saved?.[key] === "set";
  const edit = secrets[key] ?? { mode: "keep" };
  const setEdit = (e: SecretEdit, focus = false) => {
    secrets[key] = e;
    renderSecret(key);
    if (focus) host.querySelector("input")?.focus();
    onChange();
  };
  let row: HTMLElement;
  if (isSet && edit.mode === "keep") {
    row = h(
      "div.secret-row",
      null,
      h("div.secret-state", null, h("b", null, "Set"), h("span", null, "••••••••")),
      h("button.small", { type: "button", onclick: () => setEdit({ mode: "set", value: "" }, true) }, "Replace"),
      h("button.small.danger", { type: "button", onclick: () => setEdit({ mode: "clear" }) }, "Clear"),
    );
  } else if (edit.mode === "clear") {
    row = h(
      "div.secret-row",
      null,
      h("div.secret-state.clearing", null, h("b", null, "Will be removed"), h("span", null, "when you save")),
      h("button.small", { type: "button", onclick: () => setEdit({ mode: "keep" }) }, "Undo"),
    );
  } else {
    const field = h("input", {
      type: "password",
      placeholder: isSet ? "New key" : "Not set",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": label.textContent ?? key,
    });
    field.value = edit.mode === "set" ? edit.value : "";
    field.addEventListener("input", () => {
      secrets[key] = { mode: "set", value: field.value };
      onChange();
    });
    row = h(
      "div.secret-row",
      null,
      field,
      isSet ? h("button.small.ghost", { type: "button", onclick: () => setEdit({ mode: "keep" }) }, "Cancel") : null,
    );
  }
  host.replaceChildren(label, row);
}

function onChange(): void {
  const dirty = Object.keys(currentPatch()).length > 0;
  saveBtn.disabled = !dirty;
  revertBtn.disabled = !dirty;
  if (dirty) flash(saveMsg, "Unsaved changes");
  else if (saveMsg.textContent === "Unsaved changes") flash(saveMsg, "");
  $("cloud-fields").hidden = !input("cloudEnabled").checked;
}

const accountSection = initAccountSection({ onState: (s) => renderState(s) });

function renderState(state: UiState): void {
  accountSection.render(state);
  const b = state.brain;
  const now = $("now-using");
  if (b.effective) {
    now.textContent = `Running tasks with ${brainLabel(b.effective, b.jevActive)}${b.note ? ` · ${b.note}` : ""}`;
    now.className = "muted";
  } else {
    now.textContent = b.note || "Nothing can run tasks yet. Add a Claude API key or install the helper.";
    now.className = "msg";
    now.dataset.tone = "bad";
  }
  const hs = helperStatus(b.helper, b.helperError);
  $("helper-dot").dataset.tone = hs.tone;
  $("helper-headline").textContent = hs.headline;
  $("helper-details").replaceChildren(...hs.details.map((d) => h("li", null, d)));
  $("helper-install").hidden = !!b.helper;
  $("helper-connect").textContent = b.helper ? "Re-check" : "Connect";

  // Say where Jev's key comes from when it is not set here.
  const jevSource = $("jev-source");
  const fromHelper = !state.settings.jevApiKey && !!b.helper?.jevAvailable;
  jevSource.hidden = !fromHelper;
  jevSource.textContent = fromHelper
    ? state.settings.jevEnabled
      ? "In use with local Claude Code: the helper has its own Jev key (TYPESAFE_API_KEY in its .env file). A key entered here takes priority and also works with the Claude API."
      : "The helper has its own Jev key (TYPESAFE_API_KEY in its .env file), but Jev is switched off."
    : "";
}

/** Apply a saved state; keeps unsaved edits only when asked. */
function applySaved(state: UiState): void {
  saved = state.settings;
  fillForm(state.settings);
  renderState(state);
}

async function save(): Promise<boolean> {
  const patch = currentPatch();
  if (!Object.keys(patch).length) return true;
  try {
    const state = await uiRequest({ type: "settings.save", settings: patch });
    applySaved(state);
    const adjusted = adjustedFields(patch, state.settings);
    if (adjusted.length) flash(saveMsg, `Saved. Adjusted to the allowed range: ${adjusted.map((k) => LABELS[k] ?? k).join(", ")}`, "bad");
    else flash(saveMsg, "Saved.", "ok");
    return true;
  } catch (err) {
    flash(saveMsg, `Not saved: ${errorText(err)}`, "bad");
    return false;
  }
}

form.addEventListener("input", onChange);
form.addEventListener("change", onChange);
form.addEventListener("submit", (e) => {
  e.preventDefault();
  void busy(saveBtn, save).then(onChange);
});
revertBtn.addEventListener("click", () => {
  if (saved) fillForm(saved);
});

function testButton(id: string, type: "settings.testClaude" | "settings.testJev" | "settings.testCloud"): void {
  const btn = $<HTMLButtonElement>(id);
  const msg = $(`${id}-msg`);
  btn.addEventListener("click", () =>
    void busy(btn, async () => {
      flash(msg, "Testing…");
      // Test what is on screen: save pending edits first.
      if (!(await save())) return flash(msg, "Save failed; fix the settings first.", "bad");
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
      const state = await uiRequest({ type: "helper.connect" });
      renderState(state);
      flash(msg, state.brain.helper ? "" : state.brain.helperError || "Helper not found.", state.brain.helper ? "" : "bad");
    } catch (err) {
      flash(msg, errorText(err), "bad");
    }
  }),
);

async function main(): Promise<void> {
  try {
    applySaved(await uiRequest({ type: "state.get" }));
    // Fresh plan and credit (e.g. back from a Stripe page).
    renderState(await uiRequest({ type: "account.refresh", force: true }));
  } catch (err) {
    $("now-using").textContent = `Background not reachable: ${errorText(err)}`;
  }
}

void main();
initVaultSection();
