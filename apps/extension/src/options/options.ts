import { z } from "zod";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "@browsertodo/shared";
import type { StatusResponse, UiMessage } from "../messages.js";
import { loadSettings, saveSettings } from "../settings-store.js";

z.config({ jitless: true });

type FieldKind = "text" | "password" | "number" | "checkbox";
interface FieldDef {
  key: keyof ExtensionSettings;
  label: string;
  kind: FieldKind;
  step?: string;
  wide?: boolean;
}

const FIELDS: FieldDef[] = [
  { key: "apiBase", label: "API base URL", kind: "text", wide: true },
  { key: "runnerKey", label: "Runner key", kind: "password", wide: true },
  { key: "intervalMinutes", label: "Run every (minutes)", kind: "number", step: "1" },
  { key: "delayMinSec", label: "Delay between tasks, min (s)", kind: "number", step: "1" },
  { key: "delayMaxSec", label: "Delay between tasks, max (s)", kind: "number", step: "1" },
  { key: "maxToolCalls", label: "Max tool calls per task", kind: "number", step: "1" },
  { key: "maxTaskMinutes", label: "Max minutes per task", kind: "number", step: "1" },
  { key: "pauseRetryMinutes", label: "Retry paused tasks after (minutes)", kind: "number", step: "1" },
  { key: "jevThreshold", label: "Jev confidence threshold", kind: "number", step: "0.05" },
  { key: "jevEnabled", label: "Use Jev for simple steps", kind: "checkbox" },
  { key: "paused", label: "Pause scheduled runs", kind: "checkbox" },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function send<T = Record<string, unknown>>(msg: UiMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function say(el: HTMLElement, text: string, tone: "ok" | "bad" | "" = ""): void {
  el.textContent = text;
  el.className = `msg ${tone}`;
}

function renderFields(): void {
  const box = $("fields");
  for (const f of FIELDS) {
    const label = document.createElement("label");
    label.className = `field${f.kind === "checkbox" ? " check" : ""}${f.wide ? " wide" : ""}`;
    const input = document.createElement("input");
    input.id = `f-${f.key}`;
    input.name = f.key;
    input.type = f.kind;
    if (f.step) input.step = f.step;
    if (f.key === "apiBase") input.placeholder = "https://tasks.example.com";
    if (f.kind === "password") input.autocomplete = "off";
    const span = document.createElement("span");
    span.textContent = f.label;
    if (f.kind === "checkbox") label.append(input, span);
    else label.append(span, input);
    box.append(label);
  }
}

function fillFields(s: ExtensionSettings): void {
  for (const f of FIELDS) {
    const input = $<HTMLInputElement>(`f-${f.key}`);
    if (f.kind === "checkbox") input.checked = Boolean(s[f.key]);
    else input.value = String(s[f.key]);
  }
}

function readFields(): Partial<ExtensionSettings> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const input = $<HTMLInputElement>(`f-${f.key}`);
    if (f.kind === "checkbox") out[f.key] = input.checked;
    else if (f.kind === "number") out[f.key] = input.value === "" ? undefined : Number(input.value);
    else out[f.key] = input.value.trim();
  }
  return out as Partial<ExtensionSettings>;
}

async function onSave(ev: Event): Promise<void> {
  ev.preventDefault();
  const wanted = readFields();
  const saved = await saveSettings(wanted);
  fillFields(saved);
  const changed = FIELDS.filter((f) => wanted[f.key] !== undefined && wanted[f.key] !== saved[f.key]).map((f) => f.label);
  if (changed.length) say($("save-msg"), `Saved. Out-of-range values were reset: ${changed.join(", ")}`, "bad");
  else say($("save-msg"), "Saved.", "ok");
}

let helperConnected = false;

async function refreshStatus(): Promise<void> {
  try {
    const st = await send<StatusResponse>({ type: "status" });
    $("st-run").textContent = st.running ? "running" : "idle";
    $("st-task").textContent = st.currentTaskId ?? "—";
    $("st-last").textContent = st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : "—";
    const err = $("st-error");
    err.textContent = st.lastError ?? "—";
    err.className = st.lastError ? "bad" : "";
    const h = $("st-helper");
    helperConnected = st.helper !== null;
    if (st.helper) {
      h.className = "good";
      h.textContent = `connected, v${st.helper.version}; Claude: ${st.helper.claudePath ?? "not found"}; Jev: ${st.helper.jevAvailable ? "available" : "off (no TYPESAFE_API_KEY)"}`;
    } else {
      h.className = "";
      h.textContent = "not connected (connects on the next run, or use Connect helper)";
    }
  } catch (err) {
    $("st-run").textContent = `background not reachable: ${String(err)}`;
  }
}

async function refreshLog(): Promise<void> {
  if (!helperConnected) return;
  const res = await send<{ text?: string; error?: string }>({ type: "getLog", lines: 200 }).catch(() => null);
  if (!res || res.text === undefined) return;
  const log = $("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = res.text || "(log is empty)";
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function refreshVault(): Promise<void> {
  const res = await send<{ locked: boolean; sites: string[] }>({ type: "vault.list" });
  $("vault-state").textContent = res.locked ? "locked" : "unlocked";
  const list = $("vault-sites");
  list.replaceChildren();
  for (const site of res.sites) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = site;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await send({ type: "vault.delete", site });
      await refreshVault();
    });
    li.append(name, del);
    list.append(li);
  }
  $<HTMLButtonElement>("vault-lock").disabled = res.locked;
  for (const el of $("vault-add").querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) el.disabled = res.locked;
}

async function action(label: string, msg: UiMessage, okText: (r: Record<string, unknown>) => string): Promise<void> {
  const out = $("action-msg");
  say(out, `${label}…`);
  const res = await send(msg).catch((e: unknown) => ({ ok: false, error: String(e) }));
  if (res.ok === false || res.error) say(out, `${label} failed: ${String(res.error)}`, "bad");
  else say(out, okText(res), "ok");
  await refreshStatus();
}

async function main(): Promise<void> {
  renderFields();
  fillFields(await loadSettings().catch(() => DEFAULT_SETTINGS));
  $("settings-form").addEventListener("submit", (ev) => void onSave(ev));

  const id = chrome.runtime.id;
  $("ext-id").textContent = id;
  $("install-cmd").textContent = `node <path>\\apps\\helper\\dist\\install.js --extension-id ${id}`;

  $("run-now").addEventListener("click", () => void action("Run", { type: "runNow" }, () => "Run started."));
  $("test-api").addEventListener("click", () => void action("API test", { type: "testApi" }, () => "API reachable and runner key accepted."));
  $("connect-helper").addEventListener("click", () => void action("Helper", { type: "connectHelper" }, () => "Helper connected."));

  $("unlock-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pass = $<HTMLInputElement>("vault-pass");
    const res = await send({ type: "vault.unlock", passphrase: pass.value });
    pass.value = "";
    say($("vault-msg"), res.error ? String(res.error) : "Unlocked.", res.error ? "bad" : "ok");
    await refreshVault();
  });
  $("vault-lock").addEventListener("click", async () => {
    await send({ type: "vault.lock" });
    say($("vault-msg"), "Locked.", "ok");
    await refreshVault();
  });
  $("vault-add").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const site = $<HTMLInputElement>("va-site");
    const user = $<HTMLInputElement>("va-user");
    const pass = $<HTMLInputElement>("va-pass");
    const res = await send({ type: "vault.set", site: site.value, username: user.value, password: pass.value });
    say($("vault-msg"), res.error ? String(res.error) : `Saved ${site.value}.`, res.error ? "bad" : "ok");
    if (!res.error) {
      site.value = user.value = pass.value = "";
    }
    await refreshVault();
  });

  await Promise.all([refreshStatus(), refreshVault()]);
  await refreshLog();
  setInterval(() => {
    void refreshStatus().then(refreshLog);
  }, 2000);
}

void main();
