/**
 * The voice bar: a full-width bar in the live colour at the top of the side
 * panel, under the tabs, while a hands-free session is on (hands-free.ts
 * shows it; voice/voice-bar-view.ts decides what it says). It carries the
 * state word with its icon, the engine and the time on, the live meter (the
 * microphone's level, or the speaker while a line is said, with Interrupt),
 * Mute (a toggle: pressed while muted, the bar then grey), and a big Stop
 * with the voice shortcut. On another tab: where it listens,
 * with Go to tab and Use voice here (in another tab's panel too, with nothing
 * live: voice-bar-view.ts remoteBarView).
 *
 * The bar is a labelled region; a polite live line inside it says the state
 * when it changes (the ticking time and "Hearing you…" are left out of it).
 * The meter follows --level, which voice-input.ts sets on the page.
 */
import { h } from "../ui/dom.js";
import type { VoiceBarState, VoiceBarView } from "../voice/voice-bar-view.js";

export interface VoiceBarActions {
  stop(): void;
  /** Cuts off the line being said. */
  interrupt(): void;
  /** Mutes or unmutes the microphone. */
  mute(): void;
  goToTab(): void;
  useThisTab(): void;
}

export interface VoiceBar {
  /** Shows the bar as `view` says (null: no session, hidden). */
  show(view: VoiceBarView | null): void;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const MIC_PATHS = '<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75"/>';
const MIC_OFF_PATHS =
  '<path d="M10.25 6.5V4a2.25 2.25 0 0 0-4.4-.66M5.75 5.75v1.75a2.25 2.25 0 0 0 3.6 1.8M3.25 7.75a4.75 4.75 0 0 0 7.6 3.8M12.6 9.2c.1-.47.15-.95.15-1.45M8 12.5v1.75M2.25 2.25l11.5 11.5"/>';
const MIC = svg(MIC_PATHS);
const MIC_OFF = svg(MIC_OFF_PATHS);
const ICONS: Record<VoiceBarState, string> = {
  starting: MIC,
  listening: MIC,
  hearing: MIC,
  muted: MIC_OFF,
  sending: svg('<path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25"/>'),
  working: svg('<path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75"/>'),
  speaking: svg('<path d="M2.5 6.25h2.25L8 3.5v9l-3.25-2.75H2.5z"/><path d="M10.5 5.75a3 3 0 0 1 0 4.5M12.25 4a5.5 5.5 0 0 1 0 8"/>'),
  elsewhere: svg('<path d="M9.5 2.5h4v4M13.25 2.75 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
};
const small = (body: string) =>
  `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
/** Stop ends the conversation (a hung-up receiver: not the task's Stop, and not Mute's crossed-out mic). */
const STOP_ICON = small('<path d="M1.9 9.6c3.4-3.3 8.8-3.3 12.2 0l-1.55 1.85-2.55-1.05V8.65a8 8 0 0 0-4 0v1.75l-2.55 1.05z"/>');
/** Mute shows what a press does: the mic, crossed out once pressed (muted: press to unmute). */
const MUTE_ICONS = { live: small(MIC_PATHS), muted: small(MIC_OFF_PATHS) };
/** The meter's bars: how much of the level each shows (the middle ones move most). */
const METER_BARS = [0.55, 0.85, 1, 0.8, 0.5];

export function initVoiceBar(bar: HTMLElement, actions: VoiceBarActions): VoiceBar {
  const icon = h("span.vb-icon", { "aria-hidden": "true" });
  const title = h("b.vb-title");
  const detail = h("span.vb-detail");
  const meter = h("span.vb-meter", { "aria-hidden": "true" }, ...METER_BARS.map((k) => h("i", { style: `--k: ${k}` })));
  const interrupt = h("button.vb-interrupt", { type: "button", title: "Stop talking (Esc)", "aria-label": "Interrupt: stop talking" }, h("span.vb-waves", { "aria-hidden": "true" }, h("i"), h("i"), h("i")), "Interrupt");
  const go = h("button.link.vb-go", { type: "button", title: "Show the tab hands-free listens in" }, "Go to tab");
  const use = h("button.link.vb-use", { type: "button", title: "Talk to this tab's chat instead" }, "Use voice here");
  const links = h("span.vb-links", null, go, use);
  const muteIcon = h("span.vb-mute-icon", { "aria-hidden": "true" });
  const muteText = h("span.vb-mute-text");
  const mute = h("button.vb-mute", { type: "button", "aria-pressed": "false" }, muteIcon, muteText);
  const key = h("kbd.vb-key", { "aria-hidden": "true" });
  const stop = h("button.vb-stop", { type: "button" });
  stop.innerHTML = STOP_ICON;
  stop.append("Stop");
  const live = h("span.sr-only.vb-live", { role: "status", "aria-live": "polite" });
  bar.append(icon, h("span.vb-text", null, title, detail, links), meter, interrupt, mute, h("span.vb-end", null, stop, key), live);

  stop.addEventListener("click", () => actions.stop());
  interrupt.addEventListener("click", () => actions.interrupt());
  mute.addEventListener("click", () => actions.mute());
  go.addEventListener("click", () => actions.goToTab());
  use.addEventListener("click", () => actions.useThisTab());

  let drawnState: VoiceBarState | null = null;
  let drawnMute: boolean | null = null;
  return {
    show(view) {
      bar.hidden = !view;
      if (!view) {
        drawnState = null;
        live.textContent = "";
        return;
      }
      bar.dataset.state = view.state;
      bar.dataset.meter = view.meter;
      if (view.muted) bar.dataset.muted = "true";
      else delete bar.dataset.muted;
      if (drawnState !== view.state) icon.innerHTML = ICONS[view.state];
      drawnState = view.state;
      title.textContent = view.title;
      title.title = view.title;
      detail.textContent = view.detail;
      detail.title = view.detail;
      detail.hidden = !view.detail;
      links.hidden = !view.elsewhere;
      meter.hidden = view.meter !== "mic";
      interrupt.hidden = !view.interrupt;
      mute.hidden = !view.mute;
      if (view.mute) {
        const pressed = view.mute.pressed;
        mute.setAttribute("aria-pressed", String(pressed));
        mute.title = view.mute.label;
        mute.setAttribute("aria-label", view.mute.label);
        if (drawnMute !== pressed) {
          muteIcon.innerHTML = pressed ? MUTE_ICONS.muted : MUTE_ICONS.live;
          muteText.textContent = pressed ? "Unmute" : "Mute";
        }
        drawnMute = pressed;
      }
      stop.title = view.stopLabel;
      stop.setAttribute("aria-label", view.stopLabel);
      key.textContent = view.shortcut ?? "";
      key.hidden = !view.shortcut;
      // Only a change is read out.
      if (live.textContent !== view.announce) live.textContent = view.announce;
    },
  };
}
