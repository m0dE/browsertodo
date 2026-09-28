import { describe, expect, it } from "vitest";
import { applySettingsPatch } from "../../src/settings-store.js";
import { DEFAULT_SETTINGS, parseSettings } from "@browsertodo/shared";
import { automationView, FULL_AUTONOMY_WARNING, needsConfirmation } from "../../src/options/automation-view.js";
import { SECTIONS } from "../../src/options/settings-view.js";
import { AUTONOMY_WARNING_TEXT } from "../../src/sidepanel/autonomy-warning.js";

describe("Settings > Permission", () => {
  it("defaults: ask before posting, sending or paying; scheduled tasks do what they say", () => {
    expect(DEFAULT_SETTINGS.automationLevel).toBe("ask_consequential");
    expect(DEFAULT_SETTINGS.scheduledAutomation).toBe("full_within_task");
    const v = automationView(DEFAULT_SETTINGS);
    expect(v.levels.map((l) => [l.label, l.checked])).toEqual([
      ["Ask before every action", false],
      ["Ask before posting, sending or paying", true],
      ["Full autonomy (dangerous)", false],
    ]);
    expect(v.scheduled.find((c) => c.checked)?.id).toBe("full_within_task");
    expect(v.warning).toBeNull();
  });

  it("full autonomy: marked dangerous, needs a confirmation to turn on, and warns while on", () => {
    expect(needsConfirmation("full", "ask_consequential")).toBe(true);
    expect(needsConfirmation("full", "full")).toBe(false);
    expect(needsConfirmation("ask_all", "full")).toBe(false);
    const v = automationView({ automationLevel: "full", scheduledAutomation: "full_within_task" });
    expect(v.levels.find((l) => l.checked)).toMatchObject({ id: "full", dangerous: true });
    expect(v.warning).toBe(FULL_AUTONOMY_WARNING);
  });

  it("the side panel's banner is short and names the section and the level as Settings shows them", () => {
    expect(AUTONOMY_WARNING_TEXT).toBe("Permission: Full autonomy");
    expect(AUTONOMY_WARNING_TEXT.startsWith(`${SECTIONS.find((t) => t.id === "permission")!.label}: `)).toBe(true);
    expect(automationView({ automationLevel: "full", scheduledAutomation: "full_within_task" }).levels.find((l) => l.id === "full")!.label).toBe("Full autonomy (dangerous)");
  });

  it("stored values: an unknown level falls back to the default; a patch saves a valid one", () => {
    expect(parseSettings({ automationLevel: "yolo" }).automationLevel).toBe("ask_consequential");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { automationLevel: "ask_all" }).automationLevel).toBe("ask_all");
    expect(applySettingsPatch(DEFAULT_SETTINGS, { scheduledAutomation: "nope" as never }).scheduledAutomation).toBe("full_within_task");
  });
});
