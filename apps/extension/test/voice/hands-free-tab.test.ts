import { describe, expect, it } from "vitest";
import { elsewhereLabel, endsWithTab, listensElsewhere, PILL_TITLE_CHARS, voiceKeyAction } from "../../src/voice/hands-free-tab.js";

const tabs = (...ids: number[]) => new Set(ids);

describe("hands-free voice belongs to the tab it started in", () => {
  it("the voice key starts a session when none is on, and ends the one that is on, wherever it listens", () => {
    expect(voiceKeyAction(false)).toBe("start");
    expect(voiceKeyAction(true)).toBe("stop");
  });

  it("a tab its chat lives in (the agent's own tab brought to the front) is the session's own", () => {
    expect(listensElsewhere(tabs(1, 7), 7)).toBe(false);
    expect(listensElsewhere(tabs(1, 7), 2)).toBe(true);
  });

  it("the pill says where it listens only on other tabs", () => {
    expect(listensElsewhere(tabs(1), 1)).toBe(false);
    expect(listensElsewhere(tabs(1), 2)).toBe(true);
    expect(listensElsewhere(tabs(), 2)).toBe(false);
    expect(listensElsewhere(tabs(1), null)).toBe(false);
  });

  it("closing the session's tab ends it; closing another tab does not", () => {
    expect(endsWithTab(1, 1)).toBe(true);
    expect(endsWithTab(1, 2)).toBe(false);
    expect(endsWithTab(null, 2)).toBe(false);
  });

  it("names the tab it listens in, cut short, or 'another tab' without a title", () => {
    expect(elsewhereLabel("Inbox (3) - Gmail")).toBe("Hands-free · listening in Inbox (3) - Gmail");
    const long = elsewhereLabel("Quarterly planning   doc — Google Docs — shared with the whole team");
    expect(long).toMatch(/^Hands-free · listening in Quarterly planning doc — G.*…$/);
    expect(long.length - "Hands-free · listening in ".length).toBeLessThanOrEqual(PILL_TITLE_CHARS);
    expect(elsewhereLabel(null)).toBe("Hands-free · listening in another tab");
    expect(elsewhereLabel("  ")).toBe("Hands-free · listening in another tab");
  });
});
