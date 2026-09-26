/** The panel's keyboard shortcut: declared once in the manifest, shown as Chrome assigned it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../static/manifest.json";
import { isMac, OPEN_CHAT_COMMAND, readShortcut, shortcutLabel } from "../src/shortcut.js";

const command = (manifest.commands as Record<string, { suggested_key: { default: string; mac: string }; global?: boolean }>)[OPEN_CHAT_COMMAND]!;
const suggested = command.suggested_key;

describe("the manifest's command", () => {
  it("is the one the background handles, with a key for Windows/Linux and Mac that Chrome accepts", () => {
    expect(Object.keys(manifest.commands)).toEqual([OPEN_CHAT_COMMAND]);
    // Chrome: Ctrl or Alt required, never Ctrl+Alt; Command on a Mac.
    expect(suggested.default).toMatch(/^(Ctrl|Alt)\+/);
    expect(suggested.default).not.toMatch(/Ctrl\+Alt|Alt\+Ctrl/);
    expect(suggested.mac).toMatch(/^Command\+/);
    // Not a "global" command: those only take Ctrl+Shift+[0-9], and a side panel needs a focused Chrome window anyway.
    expect(command.global).toBeUndefined();
  });
});

describe("shortcutLabel", () => {
  it("as written elsewhere, as symbols on a Mac (either way Chrome reports it)", () => {
    expect(shortcutLabel("Ctrl+Shift+K", false)).toBe("Ctrl+Shift+K");
    // Chrome names punctuation keys in words: they read as the character.
    expect(shortcutLabel("Ctrl+Period", false)).toBe("Ctrl+.");
    expect(shortcutLabel("Command+Period", true)).toBe("⌘.");
    expect(shortcutLabel("Ctrl+Period", true)).toBe("⌘.");
    expect(shortcutLabel("⌘.", true)).toBe("⌘.");
    expect(shortcutLabel("Alt+Shift+Comma", false)).toBe("Alt+Shift+,");
    expect(shortcutLabel("Command+Shift+K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("⇧⌘K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("Ctrl+Shift+K", true)).toBe("⌘⇧K");
    expect(shortcutLabel("MacCtrl+Alt+J", true)).toBe("⌃⌥J");
    expect(shortcutLabel("", true)).toBe("");
  });

  it("isMac reads the platform", () => {
    expect(isMac({ platform: "MacIntel" })).toBe(true);
    expect(isMac({ userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMac({ platform: "Win32" })).toBe(false);
  });
});

describe("readShortcut", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (commands: unknown, platform = "Win32") => {
    vi.stubGlobal("navigator", { platform });
    vi.stubGlobal("chrome", { commands, runtime: { getManifest: () => manifest } });
  };

  it("what Chrome assigned; null when it assigned nothing (the key was taken)", async () => {
    stub({ getAll: async () => [{ name: OPEN_CHAT_COMMAND, shortcut: "Alt+Shift+B" }] });
    expect(await readShortcut()).toBe("Alt+Shift+B");
    stub({ getAll: async () => [{ name: OPEN_CHAT_COMMAND, shortcut: "" }] });
    expect(await readShortcut()).toBeNull();
  });

  it("without chrome.commands: the manifest's suggestion, per platform", async () => {
    stub(undefined);
    expect(await readShortcut()).toBe(shortcutLabel(suggested.default, false));
    stub(undefined, "MacIntel");
    expect(await readShortcut()).toBe(shortcutLabel(suggested.mac, true));
  });
});
