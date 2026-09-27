import { describe, expect, it } from "vitest";
import { leavingDocument, waitForUsablePage, type LoadProbe } from "../src/page-load.js";

const reading = (over: Partial<LoadProbe>): LoadProbe => ({ doc: 2, state: "interactive", controls: 40, text: 5000, foreignFrame: false, ...over });

/** Plays the readings in order (the last repeats) and counts the waits between them. */
function play(readings: (LoadProbe | null)[]) {
  let i = 0;
  let waits = 0;
  return {
    read: async () => readings[Math.min(i++, readings.length - 1)]!,
    sleep: async () => void waits++,
    get reads() {
      return i;
    },
    get waits() {
      return waits;
    },
  };
}

describe("waitForUsablePage", () => {
  it("does not wait for the load event of a heavy app: past DOMContentLoaded, three unchanged readings are enough", async () => {
    const p = play([
      null, // navigating
      reading({ state: "loading" }),
      reading({ controls: 30, text: 800 }), // the shell, "Loading…"
      reading({ controls: 30, text: 800 }),
      reading({ controls: 900, text: 40_000 }), // the list is drawn
      reading({ controls: 900, text: 40_020 }),
      reading({ controls: 900, text: 40_040 }),
      reading({ controls: 900, text: 40_040 }),
    ]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, leaving: 1 })).toMatchObject({ state: "interactive", controls: 900 });
    expect(p.reads).toBe(8);
  });

  it("a complete page needs one unchanged reading", async () => {
    const p = play([reading({ state: "complete" }), reading({ state: "complete" })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep })).toMatchObject({ state: "complete" });
    expect(p.waits).toBe(1);
  });

  it("ignores the document being left, and a blank page that is not complete", async () => {
    const p = play([reading({ doc: 1, state: "complete" }), reading({ doc: 1, state: "complete" }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ controls: 0, text: 0 }), reading({ state: "complete", controls: 0, text: 0 }), reading({ state: "complete", controls: 0, text: 0 })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, leaving: 1 })).toMatchObject({ doc: 2, state: "complete" });
    expect(p.reads).toBe(7);
  });

  it("gives up after the time limit; a reading that throws ends the wait", async () => {
    const p = play([reading({ state: "loading" })]);
    expect(await waitForUsablePage(p.read, { sleep: p.sleep, timeoutMs: 0 })).toBeNull();
    await expect(waitForUsablePage(async () => Promise.reject(new Error("blocked")), { sleep: p.sleep })).rejects.toThrow("blocked");
  });
});

describe("leavingDocument", () => {
  it("is the current document, unless only the #fragment changes", () => {
    expect(leavingDocument("https://mail.test/u/0/#inbox", "https://mail.test/u/2/#inbox", 7)).toBe(7);
    expect(leavingDocument("https://mail.test/u/0/#inbox", "https://mail.test/u/0/#sent", 7)).toBeNull();
    expect(leavingDocument("https://mail.test/u/0/", "https://mail.test/u/0/", 7)).toBe(7);
    expect(leavingDocument("https://mail.test/", "https://mail.test/x", null)).toBeNull();
  });
});
