/**
 * The model chip in the composer ("Sonnet 5 · Jev") and its popover menu:
 * pick the model, switch Jev, or open the settings. With the hosted
 * browsertodo AI it offers the hosted models and shows the credit left. Choices are saved with
 * settings.save; the chip then follows the state the background returns.
 */
import type { ExtensionSettings } from "@browsertodo/shared";
import { uiRequest, type UiState } from "../ui-protocol.js";
import { $, errorText, h } from "./dom.js";
import { KNOWN_MODELS, modelChip, modelLabel, type ModelChipInfo } from "./format.js";

export interface ModelPicker {
  setState(state: UiState): void;
  setRunning(running: boolean): void;
}

const CHECK_PATH = "M3.5 8.5 6.5 11.5 12.5 4.5";

function check(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "mm-check");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", CHECK_PATH);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export function initModelPicker(opts: {
  onState(state: UiState): void;
  onError(text: string): void;
  /** Opens the account's top-up page. */
  onTopup?(): void;
}): ModelPicker {
  const chip = $<HTMLButtonElement>("now-model");
  const label = $("now-model-label");
  const menu = $("model-menu");
  let info: ModelChipInfo | null = null;
  let running = false;

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];

  const renderChip = () => {
    if (!info) return;
    label.textContent = info.label;
    const what = `${info.hosted ? "browsertodo AI · " : ""}${info.model}${info.jevActive ? " with Jev" : ""}`;
    chip.title = info.outOfCredit
      ? "Out of AI credit: top up or subscribe to keep using browsertodo AI"
      : running
        ? `This task runs on ${what}. Changes apply to the next task.`
        : `Model for new tasks: ${what}${info.credit ? ` (${info.credit})` : ""}`;
    chip.dataset.tone = info.outOfCredit ? "warn" : "";
    chip.setAttribute("aria-label", `Model: ${info.label}`);
  };

  const save = async (patch: Partial<ExtensionSettings>) => {
    close(true);
    try {
      opts.onState(await uiRequest({ type: "settings.save", settings: patch }));
    } catch (err) {
      opts.onError(errorText(err));
    }
  };

  const renderMenu = () => {
    if (!info) return;
    const current = info.model;
    // The hosted AI runs only the models it prices; your own key or Claude Code can run any id.
    const models =
      info.hosted || KNOWN_MODELS.some((m) => m.id === current) || !current ? KNOWN_MODELS : [...KNOWN_MODELS, { id: current, label: modelLabel(current) }];
    const rows: Node[] = [h("div.mm-head", { role: "presentation" }, info.hosted ? "browsertodo AI model" : "Model")];
    for (const m of models) {
      const on = m.id === current;
      rows.push(
        h(
          "button.mm-item",
          { type: "button", role: "menuitemradio", "aria-checked": String(on), tabindex: "-1", title: m.id, onclick: () => void (on ? close(true) : save({ anthropicModel: m.id })) },
          h("span.mm-label", null, m.label),
          on ? check() : null,
        ),
      );
    }
    if (info.hosted && (info.credit || info.outOfCredit)) {
      rows.push(h("div.mm-sep", { role: "separator" }));
      rows.push(
        h(
          "div.mm-credit",
          { role: "presentation", "data-tone": info.outOfCredit ? "warn" : "" },
          info.outOfCredit ? "Out of AI credit" : (info.credit ?? ""),
        ),
      );
      rows.push(
        h(
          "button.mm-item",
          {
            type: "button",
            role: "menuitem",
            tabindex: "-1",
            onclick: () => {
              close(false);
              opts.onTopup?.();
            },
          },
          h("span.mm-label", null, "Top up…"),
        ),
      );
    }
    rows.push(h("div.mm-sep", { role: "separator" }));
    const jevOn = info.jevPossible && info.jevEnabled;
    rows.push(
      h(
        "button.mm-item.mm-jev",
        {
          type: "button",
          role: "menuitemcheckbox",
          "aria-checked": String(jevOn),
          tabindex: "-1",
          disabled: !info.jevPossible,
          onclick: () => void save({ jevEnabled: !info!.jevEnabled }),
        },
        h(
          "span.mm-text",
          null,
          h("span.mm-label", null, "Jev"),
          h("span.mm-hint", null, info.hosted ? "Faster clicks and typing, included" : info.jevPossible ? "Faster clicks and typing" : "Add a Jev key in settings"),
        ),
        h("span.mm-switch", { "aria-hidden": "true", "data-on": String(jevOn) }),
      ),
    );
    rows.push(h("div.mm-sep", { role: "separator" }));
    rows.push(
      h(
        "button.mm-item",
        {
          type: "button",
          role: "menuitem",
          tabindex: "-1",
          onclick: () => {
            close(false);
            void chrome.runtime.openOptionsPage();
          },
        },
        h("span.mm-label", null, "More settings…"),
      ),
    );
    menu.replaceChildren(...rows);
  };

  const open = (focus: "checked" | "first" | "last") => {
    if (running || !info) return;
    renderMenu();
    menu.hidden = false;
    chip.setAttribute("aria-expanded", "true");
    const list = items();
    const checked = list.find((b) => b.getAttribute("role") === "menuitemradio" && b.getAttribute("aria-checked") === "true");
    const target = focus === "checked" ? (checked ?? list[0]) : focus === "first" ? list[0] : list[list.length - 1];
    target?.focus();
  };

  function close(refocus: boolean): void {
    if (menu.hidden) return;
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    if (refocus) chip.focus();
  }

  chip.addEventListener("click", () => (menu.hidden ? open("checked") : close(false)));
  chip.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      open(e.key === "ArrowUp" ? "last" : "first");
    } else if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault();
      close(true);
    }
  });
  menu.addEventListener("keydown", (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(i < 0 ? list.length - 1 : i - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(list.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  });
  // Click outside, or focus leaving the picker, closes the menu.
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !chip.parentElement!.contains(e.target as Node)) close(false);
  });
  menu.addEventListener("focusout", (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && !chip.parentElement!.contains(next)) close(false);
  });

  return {
    setState(state) {
      info = modelChip(state);
      renderChip();
      if (!menu.hidden) {
        const focused = document.activeElement;
        const idx = items().indexOf(focused as HTMLButtonElement);
        renderMenu();
        if (idx >= 0) items()[idx]?.focus();
      }
    },
    setRunning(next) {
      running = next;
      chip.disabled = running;
      if (running) close(false);
      renderChip();
    },
  };
}
