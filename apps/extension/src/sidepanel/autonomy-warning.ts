/**
 * The side panel's warning while the chat agent has full autonomy (Settings >
 * Permission): one short line under the status, "Permission: Full autonomy",
 * for as long as it is on, with a link to change it. Its tooltip says what the
 * level lets the agent do. Nothing shows at the other levels.
 */
import { AUTOMATION_LEVELS, FULL_AUTONOMY_NAME, PERMISSION_TITLE, type ExtensionSettings } from "@browsertodo/shared";
import { $ } from "../ui/dom.js";
import { openSettings } from "./open-settings.js";

export const AUTONOMY_WARNING_TEXT = `${PERMISSION_TITLE}: ${FULL_AUTONOMY_NAME}`;

export function initAutonomyWarning(): { render(settings: Pick<ExtensionSettings, "automationLevel">): void } {
  const el = $("autonomy-warning");
  $("autonomy-warning-text").textContent = AUTONOMY_WARNING_TEXT;
  el.title = AUTOMATION_LEVELS.find((l) => l.id === "full")?.detail ?? "";
  $("autonomy-warning-change").addEventListener("click", () => void openSettings("permission"));
  return {
    render(settings) {
      el.hidden = settings.automationLevel !== "full";
    },
  };
}
