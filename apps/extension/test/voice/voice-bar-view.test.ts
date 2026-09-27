import { describe, expect, it } from "vitest";
import { elapsedText, HEARING, isMuteKey, MUTE_KEY, NOT_HERE_TEXT, remoteBarView, VoiceActivity, voiceBarView, type VoiceBarInput } from "../../src/voice/voice-bar-view.js";

const base: VoiceBarInput = { phase: "listening", hearing: false, muted: false, engine: "realtime", elapsedMs: 42_000, elsewhere: null, shortcut: "Ctrl+," };
const view = (patch: Partial<VoiceBarInput>) => voiceBarView({ ...base, ...patch });

describe("the voice bar", () => {
  it("each phase has its state word, line, meter and announcement", () => {
    const rows = (["starting", "listening", "sending", "working", "speaking"] as const).map((phase) => {
      const v = view({ phase });
      return [phase, v.state, v.title, v.detail, v.meter, v.announce, v.interrupt];
    });
    expect(rows).toEqual([
      ["starting", "starting", "Starting…", "Turning on the microphone", "none", "Hands-free: Starting…", false],
      ["listening", "listening", "Listening", "Realtime · 0:42 · Just talk · say “stop” to end", "mic", "Hands-free: Listening", false],
      ["sending", "sending", "Sending", "Realtime · 0:42 · Say “cancel” or press Esc to take it back", "mic", "Hands-free: Sending", false],
      ["working", "working", "Agent working", "Realtime · 0:42 · Still listening: talk to add to the task", "mic", "Hands-free: Agent working", false],
      ["speaking", "speaking", "Speaking", "Realtime · 0:42 · Tap Interrupt, or just talk", "speaker", "Hands-free: Speaking", true],
    ]);
  });

  it("a voice on the microphone reads Hearing you… while listening or working, but is announced as the state it is in", () => {
    const listening = view({ hearing: true });
    expect([listening.state, listening.title, listening.announce]).toEqual(["hearing", "Hearing you…", "Hands-free: Listening"]);
    const working = view({ phase: "working", hearing: true });
    expect([working.state, working.title, working.announce]).toEqual(["hearing", "Hearing you…", "Hands-free: Agent working"]);
    // While a line is said or a message waits, that is what the bar says.
    expect(view({ phase: "speaking", hearing: true }).state).toBe("speaking");
    expect(view({ phase: "sending", hearing: true }).state).toBe("sending");
  });

  it("names the engine (once chosen) and how long it has been on", () => {
    expect(view({ engine: "standard", elapsedMs: 5_400 }).detail).toMatch(/^Standard · 0:05 · /);
    expect(view({ engine: null }).detail).toMatch(/^0:42 · /);
  });

  it("on another tab it names the tab it listens in, with Go to tab and Use voice here, and no interrupt", () => {
    const v = view({ phase: "speaking", elsewhere: { title: "Inbox (3) - Gmail" } });
    expect(v).toMatchObject({ state: "elsewhere", title: "Voice is on in Inbox (3) - Gmail", detail: "Realtime · 0:42", elsewhere: true, interrupt: false, announce: "Voice is on in Inbox (3) - Gmail" });
    expect(view({ elsewhere: { title: null } }).title).toBe("Voice is on in another tab");
  });

  it("in another tab's panel: where voice is on, with Go to tab, Use voice here and Stop, and nothing live", () => {
    const v = remoteBarView({ title: "Shop A", engine: "standard" });
    expect(v).toEqual({
      state: "elsewhere",
      title: "Voice is on in Shop A",
      detail: `Standard · ${NOT_HERE_TEXT}`,
      meter: "none",
      announce: "Voice is on in Shop A",
      interrupt: false,
      elsewhere: true,
      stopLabel: "Stop voice in that tab",
      shortcut: null,
      muted: false,
      mute: null,
    });
    expect(remoteBarView({ title: null, engine: null })).toMatchObject({ title: "Voice is on in another tab", detail: NOT_HERE_TEXT });
  });

  it("Stop names the voice shortcut when there is one", () => {
    expect(view({}).stopLabel).toBe("Stop hands-free · Ctrl+,");
    expect(view({ shortcut: null }).stopLabel).toBe("Stop hands-free");
  });

  it("formats the time on", () => {
    expect([0, 999, 7_000, 754_000, 3_723_000, -5].map(elapsedText)).toEqual(["0:00", "0:00", "0:07", "12:34", "1:02:03", "0:00"]);
  });
});

describe("the voice bar: muted", () => {
  const MUTE = { pressed: false, label: "Mute the microphone · Alt+M" };
  const UNMUTE = { pressed: true, label: "Unmute the microphone · Alt+M" };

  it("offers Mute (with its key) once the session runs, not while it starts", () => {
    expect(view({}).mute).toEqual(MUTE);
    expect(view({ phase: "speaking" }).mute).toEqual(MUTE);
    expect(view({ phase: "starting" }).mute).toBeNull();
    expect(view({ phase: "starting", muted: true })).toMatchObject({ state: "starting", mute: null, muted: true });
  });

  it("muted while listening or working: 'Muted', no meter, no 'Hearing you…', and the hint says updates still come", () => {
    const listening = view({ muted: true, hearing: true });
    expect(listening).toMatchObject({ state: "muted", title: "Muted", meter: "none", announce: "Hands-free: Muted", interrupt: false, muted: true, mute: UNMUTE });
    expect(listening.detail).toBe("Realtime · 0:42 · Microphone off · Unmute to talk");
    const working = view({ phase: "working", muted: true });
    expect(working).toMatchObject({ state: "muted", title: "Muted", meter: "none", announce: "Hands-free: Muted" });
    expect(working.detail).toBe("Realtime · 0:42 · Agent working · updates are still said");
  });

  it("muted while a line is said or a message waits: that state, its hint without talking", () => {
    const speaking = view({ phase: "speaking", muted: true });
    expect(speaking).toMatchObject({ state: "speaking", title: "Speaking", meter: "speaker", interrupt: true, muted: true, mute: UNMUTE });
    expect(speaking.detail).toBe("Realtime · 0:42 · Tap Interrupt · microphone muted");
    const sending = view({ phase: "sending", muted: true });
    expect(sending).toMatchObject({ state: "sending", meter: "none", muted: true });
    expect(sending.detail).toBe("Realtime · 0:42 · Press Esc to take it back");
  });

  it("on another tab: says it is muted, no meter, Mute still there", () => {
    const v = view({ muted: true, elsewhere: { title: "Shop A" } });
    expect(v).toMatchObject({ state: "elsewhere", detail: "Realtime · 0:42 · Muted", meter: "none", muted: true, mute: UNMUTE });
    expect(view({ elsewhere: { title: "Shop A" } }).mute).toEqual(MUTE);
  });

  it("in another tab's panel: says it is muted; no Mute there (that panel runs the microphone)", () => {
    expect(remoteBarView({ title: "Shop A", engine: "realtime", muted: true })).toMatchObject({ detail: `Realtime · Muted · ${NOT_HERE_TEXT}`, muted: true, mute: null });
  });

  it("Alt+M by the key's position (Alt on a Mac types µ), nothing else", () => {
    const key = (patch: Partial<Parameters<typeof isMuteKey>[0]>) => isMuteKey({ code: MUTE_KEY.code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...patch });
    expect(key({})).toBe(true);
    expect([key({ altKey: false }), key({ ctrlKey: true }), key({ metaKey: true }), key({ shiftKey: true }), key({ code: "KeyN" })]).toEqual([false, false, false, false, false]);
  });
});

describe("VoiceActivity", () => {
  it("hears a voice at the meter level for a little while after it, not the quiet in between", () => {
    const a = new VoiceActivity();
    expect(a.hearing(0)).toBe(false);
    a.push(HEARING.level - 0.1, 100);
    expect(a.hearing(100)).toBe(false);
    a.push(HEARING.level, 200);
    expect(a.hearing(200)).toBe(true);
    a.push(0.05, 300);
    expect(a.hearing(200 + HEARING.holdMs - 1)).toBe(true);
    expect(a.hearing(200 + HEARING.holdMs)).toBe(false);
    a.push(0.9, 1000);
    a.reset();
    expect(a.hearing(1000)).toBe(false);
  });
});
