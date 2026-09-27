/**
 * The side panel's warning while the chat agent has full autonomy (Settings >
 * AI > Automation): one line under the status, for as long as it is on, with
 * a link to change it. Nothing shows at the other levels.
 */
import type { ExtensionSettings } from "@browsertodo/shared";
import { $ } from "../ui/dom.js";
import { openSettings } from "./open-settings.js";

export const AUTONOMY_WARNING_TEXT = "Full autonomy: the agent posts, sends, pays and deletes without asking.";

export function initAutonomyWarning(): { render(settings: Pick<ExtensionSettings, "automationLevel">): void } {
  const el = $("autonomy-warning");
  $("autonomy-warning-text").textContent = AUTONOMY_WARNING_TEXT;
  $("autonomy-warning-change").addEventListener("click", () => void openSettings("automation"));
  return {
    render(settings) {
      el.hidden = settings.automationLevel !== "full";
    },
  };
}
