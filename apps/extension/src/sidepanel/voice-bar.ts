/**
 * The voice bar: a full-width bar in the live colour at the top of the side
 * panel, under the tabs, while a hands-free session is on (hands-free.ts
 * shows it; voice/voice-bar-view.ts decides what it says). It carries the
 * state word with its icon, the engine and the time on, the live meter (the
 * microphone's level, or the speaker while a line is said, with Interrupt),
 * and a big Stop with the voice shortcut. On another tab: where it listens,
 * with Go to tab and Use this tab.
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
  goToTab(): void;
  useThisTab(): void;
}

export interface VoiceBar {
  /** Shows the bar as `view` says (null: no session, hidden). */
  show(view: VoiceBarView | null): void;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const MIC = svg('<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.75a4.75 4.75 0 0 0 9.5 0M8 12.5v1.75"/>');
const ICONS: Record<VoiceBarState, string> = {
  starting: MIC,
  listening: MIC,
  hearing: MIC,
  sending: svg('<path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25"/>'),
  working: svg('<path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75"/>'),
  speaking: svg('<path d="M2.5 6.25h2.25L8 3.5v9l-3.25-2.75H2.5z"/><path d="M10.5 5.75a3 3 0 0 1 0 4.5M12.25 4a5.5 5.5 0 0 1 0 8"/>'),
  elsewhere: svg('<path d="M9.5 2.5h4v4M13.25 2.75 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
};
/** Stop turns the microphone off (a crossed-out mic: not the task's Stop). */
const STOP_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.25 6.5V4a2.25 2.25 0 0 0-4.4-.66M5.75 5.75v1.75a2.25 2.25 0 0 0 3.6 1.8M3.25 7.75a4.75 4.75 0 0 0 7.6 3.8M12.6 9.2c.1-.47.15-.95.15-1.45M8 12.5v1.75M2.25 2.25l11.5 11.5"/></svg>';
/** The meter's bars: how much of the level each shows (the middle ones move most). */
const METER_BARS = [0.55, 0.85, 1, 0.8, 0.5];

export function initVoiceBar(bar: HTMLElement, actions: VoiceBarActions): VoiceBar {
  const icon = h("span.vb-icon", { "aria-hidden": "true" });
  const title = h("b.vb-title");
  const detail = h("span.vb-detail");
  const meter = h("span.vb-meter", { "aria-hidden": "true" }, ...METER_BARS.map((k) => h("i", { style: `--k: ${k}` })));
  const interrupt = h("button.vb-interrupt", { type: "button", title: "Stop talking (Esc)", "aria-label": "Interrupt: stop talking" }, h("span.vb-waves", { "aria-hidden": "true" }, h("i"), h("i"), h("i")), "Interrupt");
  const go = h("button.link.vb-go", { type: "button", title: "Show the tab hands-free listens in" }, "Go to tab");
  const use = h("button.link.vb-use", { type: "button", title: "Listen for this tab's chat instead" }, "Use this tab");
  const links = h("span.vb-links", null, go, use);
  const key = h("kbd.vb-key", { "aria-hidden": "true" });
  const stop = h("button.vb-stop", { type: "button" });
  stop.innerHTML = STOP_ICON;
  stop.append("Stop");
  const live = h("span.sr-only.vb-live", { role: "status", "aria-live": "polite" });
  bar.append(icon, h("span.vb-text", null, title, detail, links), meter, interrupt, h("span.vb-end", null, stop, key), live);

  stop.addEventListener("click", () => actions.stop());
  interrupt.addEventListener("click", () => actions.interrupt());
  go.addEventListener("click", () => actions.goToTab());
  use.addEventListener("click", () => actions.useThisTab());

  let drawnState: VoiceBarState | null = null;
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
      stop.title = view.stopLabel;
      stop.setAttribute("aria-label", view.stopLabel);
      key.textContent = view.shortcut ?? "";
      key.hidden = !view.shortcut;
      // Only a change is read out.
      if (live.textContent !== view.announce) live.textContent = view.announce;
    },
  };
}
