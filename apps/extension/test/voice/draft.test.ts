import { describe, expect, it } from "vitest";
import { VoiceDraft } from "../../src/voice/draft.js";

describe("VoiceDraft", () => {
  it("fills an empty input with the voice text, rewriting it as it improves", () => {
    const d = new VoiceDraft("");
    let v = d.update("", "Open");
    expect(v).toBe("Open");
    v = d.update(v, "Open Gmail and");
    expect(v).toBe("Open Gmail and");
    expect(d.update(v, "Open Gmail and reply.")).toBe("Open Gmail and reply.");
  });

  it("keeps what was typed before and puts the voice text after it", () => {
    const d = new VoiceDraft("On LinkedIn:");
    const v = d.update("On LinkedIn:", "post good morning");
    expect(v).toBe("On LinkedIn: post good morning");
    expect(new VoiceDraft("Hi ").update("Hi ", "there")).toBe("Hi there");
  });

  it("keeps an edit made while listening and continues after it without repeating words", () => {
    const d = new VoiceDraft("");
    let v = d.update("", "Open Gmail");
    // The user fixes a word while still talking.
    v = "Open Outlook";
    v = d.update(v, "Open Gmail and reply to Sarah");
    expect(v).toBe("Open Outlook and reply to Sarah");
    v = d.update(v, "Open Gmail and reply to Sarah now.");
    expect(v).toBe("Open Outlook and reply to Sarah now.");
  });

  it("Esc removes only the voice text", () => {
    const d = new VoiceDraft("Draft:");
    const v = d.update("Draft:", "something said");
    expect(d.discard(v)).toBe("Draft:");
    // After the user's own edit, their text stays as it is.
    const d2 = new VoiceDraft("");
    d2.update("", "hello");
    expect(d2.discard("hello world")).toBe("hello world");
  });
});
