/**
 * Settings > AI > Voice: which engine hands-free voice uses (Realtime or
 * Standard, each with its cost a minute from the account server), and the
 * Standard engine's voice and speed with a Test button. Saves by itself, like
 * the rest of the page; voice-view.ts decides what shows.
 */
import { errorMessage, type ExtensionSettings, type VoiceEngine, type VoiceEngineId } from "@browsertodo/shared";
import { VOICE_COMMAND, readShortcut } from "../shortcut.js";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, find, flash, h } from "../ui/dom.js";
import { Speaker, speechVoices } from "../voice/speaker.js";
import { voiceView } from "./voice-view.js";

/** What Test voice says. */
export const SPEECH_SAMPLE = "Opening Gmail. You have two new emails; Jordan needs a reply by Friday.";

export interface VoiceSection {
  render(state: UiState): void;
}

export function initVoiceSection(opts: { onState(state: UiState): void }): VoiceSection {
  const voiceSelect = $<HTMLSelectElement>("speech-voice");
  const rate = $<HTMLInputElement>("speech-rate");
  const testBtn = $<HTMLButtonElement>("speech-test");
  const testMsg = $("speech-test-msg");
  let state: UiState | null = null;
  let engines: VoiceEngine[] | null | "loading" = "loading";

  const settings = (): ExtensionSettings | null => state?.settings ?? null;

  async function save(patch: Partial<ExtensionSettings>): Promise<void> {
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      flash(testMsg, `Not saved: ${errorMessage(err)}`, "bad");
    }
  }

  function fillVoices(): void {
    const s = settings();
    const voices = speechVoices();
    const current = s?.speechVoice ?? "";
    const known = !current || voices.some((v) => v.name === current);
    voiceSelect.replaceChildren(
      h("option", { value: "" }, "Browser default"),
      ...voices.map((v) => h("option", { value: v.name }, `${v.name} (${v.lang})`)),
      // A voice saved on another computer: kept, shown as it is.
      ...(known ? [] : [h("option", { value: current }, `${current} (not on this computer)`)]),
    );
    voiceSelect.value = current;
  }

  function draw(): void {
    const s = settings();
    if (!s) return;
    const v = voiceView({ engines, selected: s.voiceEngine, account: state?.account });
    for (const o of v.options) {
      const row = find(document, `.opt[data-voice="${o.id}"]`);
      find<HTMLInputElement>(row, "input[type=radio]").checked = o.id === v.selected;
      find(row, ".voice-name").textContent = o.label;
      find(row, ".voice-detail").textContent = o.detail;
      const cost = find(row, ".voice-cost");
      cost.textContent = o.cost;
      cost.title = o.title;
    }
    const note = $("voice-note");
    note.hidden = !v.note;
    note.textContent = v.note ?? "";
    if (document.activeElement !== rate) rate.value = String(s.speechRate);
    if (voiceSelect.value !== s.speechVoice) fillVoices();
  }

  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=voiceEngine]")) {
    r.addEventListener("change", () => void save({ voiceEngine: r.value as VoiceEngineId }));
  }
  voiceSelect.addEventListener("change", () => void save({ speechVoice: voiceSelect.value }));
  rate.addEventListener("change", () => {
    const n = Number(rate.value);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) return flash(testMsg, "Enter a speed from 0.5 to 2.", "bad");
    void save({ speechRate: Math.round(n * 10) / 10 });
  });
  const speaker = new Speaker(() => ({ voice: voiceSelect.value, rate: Number(rate.value) || 1 }));
  testBtn.addEventListener("click", () => {
    if (typeof speechSynthesis === "undefined") return flash(testMsg, "This browser has no built-in speech.", "bad");
    flash(testMsg, "Speaking…");
    void speaker.speak(SPEECH_SAMPLE).then(() => flash(testMsg, ""));
  });
  // Chrome loads its voices a moment after the page.
  globalThis.speechSynthesis?.addEventListener?.("voiceschanged", fillVoices);

  void uiRequest({ type: "voice.engines" }).then(
    (r) => {
      engines = "error" in r ? null : r.engines;
      draw();
    },
    () => {
      engines = null;
      draw();
    },
  );
  void readShortcut(VOICE_COMMAND).then((key) => {
    if (key) $("voice-group-key").textContent = key;
  });

  return {
    render(next) {
      state = next;
      draw();
    },
  };
}
