/**
 * Hands-free voice with a side panel per tab (the owner's report: voice started in one tab looked live in every
 * other, and the narrator answered questions about a tab it could not see). The panel running the session learns
 * from the background which tab the user looks at: the bar says where it listens, messages and the narrator get a
 * note naming both tabs, and "use this tab" moves it. Another tab's panel shows where voice is on, nothing live, and
 * Use voice here ends it where it runs before starting it there (one microphone).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, VoiceEngineId, VoiceEnginesResponse } from "@browsertodo/shared";
import { initHandsFree, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import type { HandsFreeLook } from "../../src/sidepanel/voice-input.js";
import type { EngineEvents, HandsFreeEngine } from "../../src/voice/engine.js";
import { lookingHomeNote } from "../../src/voice/hands-free-tab.js";
import type { VoiceSessionView } from "../../src/voice-session.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

class FakeEngine implements HandsFreeEngine {
  readonly halfDuplex: boolean;
  stopped = false;
  notes: string[] = [];
  spoken: string[] = [];
  /** Each setMuted call, in order. */
  mutes: boolean[] = [];
  constructor(
    readonly id: VoiceEngineId,
    readonly events: EngineEvents,
  ) {
    this.halfDuplex = id === "standard";
  }
  async start(): Promise<void> {}
  stop(): void {
    this.stopped = true;
  }
  speak(text: string): void {
    this.spoken.push(text);
  }
  hush(): void {}
  setTranscribing(): void {}
  setMuted(muted: boolean): void {
    this.mutes.push(muted);
  }
  agentEvent(): void {}
  note(text: string): void {
    this.notes.push(text);
  }
  tick(): void {}
}

const ENGINES: VoiceEnginesResponse = {
  default: "realtime",
  engines: [
    { id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6, assumption: "", available: true },
    { id: "standard", name: "Standard", model: "whisper", approxCentsPerMinute: 0.07, assumption: "", available: true },
  ],
};

const PAGES: Record<number, { title: string; url: string }> = {
  1: { title: "Inbox", url: "https://mail.example.com/" },
  2: { title: "Recipes", url: "https://recipes.example/b" },
};

/** Walks the bar for the element with this class. */
function find(el: MiniElement, cls: string): MiniElement | null {
  if (el.className.split(" ").includes(cls)) return el;
  for (const kid of el.childNodes) if (kid instanceof MiniElement) {
    const hit = find(kid, cls);
    if (hit) return hit;
  }
  return null;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** The side panel of tab `homeTab` (it shows that tab). */
function panel(homeTab: number, opts: { engine?: VoiceEngineId } = {}) {
  const engines: FakeEngine[] = [];
  const looks: (HandsFreeLook | null)[] = [];
  const reports: [boolean, number | null, VoiceEngineId | null][] = [];
  /** Whether each report said the microphone is muted. */
  const mutedReports: boolean[] = [];
  const sounds: string[] = [];
  const bar = new MiniElement("div");
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: (l) => void looks.push(l), setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: () => {},
    activeTab: () => homeTab,
    homeTab,
    chatOf: () => null,
    tabsOf: () => [],
    send: vi.fn(async () => "s-voice"),
    tabPage: async (id) => PAGES[id] ?? null,
    goToTab: vi.fn(),
    onSpeaking: () => {},
    keepSpoken: () => {},
    keepHeard: () => {},
    settings: () => ({ voiceEngine: opts.engine ?? "realtime", realtimeCostNoticed: true }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ENGINES,
    saveSettings: async () => {},
    createEngine: (id, events) => {
      const e = new FakeEngine(id, events);
      engines.push(e);
      return e;
    },
    stopTask: async () => "",
    answerApproval: async () => true,
    openBilling: () => {},
    signIn: () => {},
    onActive: (on, tab, engine, muted) => {
      reports.push([on, tab, engine]);
      mutedReports.push(muted);
    },
    stopRemote: vi.fn(),
    bar: bar as unknown as HTMLElement,
    earcons: { play: (kind) => void sounds.push(kind) },
  };
  const hf = initHandsFree(deps);
  const button = (cls: string) => find(bar, cls)!;
  return { hf, deps, engines, looks, reports, mutedReports, sounds, bar, button };
}

/** What the background says: the session runs in tab 1's panel, for tab 1, and the user looks at `viewing`. */
const inTab1 = (viewing: number, s: Partial<VoiceSessionView> = {}): VoiceSessionView => ({ tabId: 1, windowId: 5, host: 1, engine: "realtime", viewing, ...s });

describe("hands-free voice in the panel that runs it, while the user looks at another tab", () => {
  beforeAll(installMiniDom);

  it("the bar says where it listens; what is said carries a note naming both tabs; the narrator is told, and when the user is back", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    expect(t.reports.at(-1)).toEqual([true, 1, "realtime"]);
    t.hf.setSession(inTab1(1));
    await settle();
    expect(rt.notes).toEqual([]);
    expect(t.bar.dataset.state).toBe("listening");

    // The user switches to tab 2 (tab 1's panel is hidden now).
    t.hf.setSession(inTab1(2));
    await settle();
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(rt.notes).toEqual(["The user is looking at another tab: Recipes (recipes.example). You work in Inbox (mail.example.com)."]);
    // Still listening (it belongs to tab 1), and the box there is not written into.
    expect(t.hf.active).toBe(true);
    expect(t.looks.at(-1)).toMatchObject({ elsewhere: true, orb: false });

    rt.events.forward("What is on this page?");
    await settle();
    // The words as said; the note goes with them as the message's context (the agent gets it, the chat does not show it).
    expect(t.deps.send).toHaveBeenLastCalledWith(
      "What is on this page?",
      { tabId: 1, sessionId: null },
      { context: "The user is looking at another tab: Recipes (recipes.example). You work in Inbox (mail.example.com)." },
    );

    // Back on tab 1: the narrator hears so; messages go as said.
    t.hf.setSession(inTab1(1));
    await settle();
    expect(rt.notes.at(-1)).toBe(lookingHomeNote(PAGES[1]!));
    rt.events.forward("Reply to Sarah");
    await settle();
    expect(t.deps.send).toHaveBeenLastCalledWith("Reply to Sarah", { tabId: 1, sessionId: "s-voice" });
    expect(t.bar.dataset.state).not.toBe("elsewhere");
  });

  it("use_this_tab moves it to the tab the user looks at (its chat, its badge), or says why not", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    t.hf.setSession(inTab1(1));
    expect(await rt.events.useThisTab()).toBe("The user is already looking at the tab you work in.");
    t.hf.setSession(inTab1(3));
    expect(await rt.events.useThisTab()).toBe("That tab is gone: nothing moved.");
    t.hf.setSession(inTab1(2));
    await settle();
    expect(await rt.events.useThisTab()).toBe("Moved: you now work in Recipes (recipes.example); what the user says goes to that tab's chat.");
    expect(t.reports.at(-1)).toEqual([true, 2, "realtime"]);
    expect(t.hf.tab).toBe(2);
    t.hf.setSession(inTab1(2, { tabId: 2 }));
    expect(t.bar.dataset.state).not.toBe("elsewhere");
    rt.events.forward("What is on this page?");
    await settle();
    expect(t.deps.send).toHaveBeenLastCalledWith("What is on this page?", { tabId: 2, sessionId: null });
  });

  it("Standard: 'use this tab' said is not sent as a message; it moves the session and says so", async () => {
    const t = panel(1, { engine: "standard" });
    t.hf.toggle("button");
    await settle();
    const std = t.engines[0]!;
    expect(std.id).toBe("standard");
    t.hf.setSession(inTab1(2, { engine: "standard" }));
    std.events.heard("Use this tab.", true);
    await settle();
    await settle();
    expect(t.deps.send).not.toHaveBeenCalled();
    expect(t.hf.tab).toBe(2);
    expect(std.spoken).toEqual(["Now working in Recipes."]);
  });

  it("the background asks it to stop (Stop or Use voice here in another tab's panel): it ends and says so", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.stopHere();
    expect(t.hf.active).toBe(false);
    expect(t.engines[0]!.stopped).toBe(true);
    expect(t.reports.at(-1)).toEqual([false, null, null]);
  });
});

describe("hands-free voice seen from another tab's panel", () => {
  beforeAll(installMiniDom);

  it("says where voice is on, with Go to tab, Use voice here and Stop, and nothing live", async () => {
    const t = panel(2);
    t.hf.setSession(inTab1(2));
    await settle();
    expect(t.bar.hidden).toBe(false);
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(find(t.bar, "vb-title")!.textContent).toBe("Voice is on in Inbox");
    expect(find(t.bar, "vb-links")!.hidden).toBe(false);
    expect(find(t.bar, "vb-meter")!.hidden).toBe(true);
    expect(t.bar.dataset.phase).toBeUndefined();
    expect(t.hf.active).toBe(false);
    // The mic button and the box stay as they are when voice is off.
    expect(t.looks.every((l) => l === null)).toBe(true);
    expect(t.engines).toEqual([]);

    t.button("vb-go").click();
    expect(t.deps.goToTab).toHaveBeenCalledWith(1);
    t.button("vb-stop").click();
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    // It ended there: the notice goes.
    t.hf.setSession(null);
    expect(t.bar.hidden).toBe(true);
    expect(t.engines).toEqual([]);
  });

  it("Use voice here: ends it where it runs, then (once it ended) starts here on the same engine; never two at once", async () => {
    const t = panel(2);
    t.hf.setSession(inTab1(2, { engine: "standard" }));
    t.button("vb-use").click();
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    // Not before the other panel let go of the microphone.
    await settle();
    expect(t.engines).toEqual([]);
    expect(t.hf.active).toBe(false);
    // A second press meanwhile does nothing more.
    t.hf.toggle("button");
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    t.hf.setSession(null);
    await settle();
    // Settings say Realtime; the session goes on on Standard, as it ran.
    expect(t.engines.map((e) => e.id)).toEqual(["standard"]);
    expect(t.hf.active).toBe(true);
    expect(t.hf.tab).toBe(2);
    expect(t.reports.at(-1)).toEqual([true, 2, "standard"]);
  });

  it("the mic in that panel moves the session here too (it does not start a second one)", async () => {
    const t = panel(2);
    t.hf.setSession(inTab1(2));
    t.hf.toggle("button");
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    expect(t.engines).toEqual([]);
  });

  it("moved to this panel's tab by voice (the other panel still runs it): this panel takes it over", async () => {
    const t = panel(2);
    t.hf.setSession(inTab1(2, { tabId: 2 }));
    expect(t.deps.stopRemote).toHaveBeenCalledTimes(1);
    expect(t.bar.hidden).toBe(true);
    t.hf.setSession(null);
    await settle();
    expect(t.engines.map((e) => e.id)).toEqual(["realtime"]);
    expect(t.hf.tab).toBe(2);
  });
});

describe("hands-free voice muted", () => {
  beforeAll(installMiniDom);

  it("Mute on the bar: the engine stops taking the microphone, the bar goes 'Muted', the badge is told, a soft sound; Unmute undoes it", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    const mute = t.button("vb-mute");
    expect(mute.hidden).toBe(false);
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(mute.getAttribute("aria-label")).toBe("Mute the microphone · Alt+M");
    mute.click();
    expect(t.hf.muted).toBe(true);
    expect(rt.mutes).toEqual([true]);
    expect(t.bar.dataset.state).toBe("muted");
    expect(t.bar.dataset.muted).toBe("true");
    expect(find(t.bar, "vb-title")!.textContent).toBe("Muted");
    expect(find(t.bar, "vb-meter")!.hidden).toBe(true);
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.getAttribute("aria-label")).toBe("Unmute the microphone · Alt+M");
    expect(t.reports.at(-1)).toEqual([true, 1, "realtime"]);
    expect(t.mutedReports.at(-1)).toBe(true);
    expect(t.looks.at(-1)).toMatchObject({ muted: true });
    expect(t.sounds).toEqual(["start", "mute"]);
    // Still on: the narrator speaking shows as speaking, the Mute still pressed.
    rt.events.narrating();
    expect(t.bar.dataset.state).toBe("speaking");
    expect(t.bar.dataset.muted).toBe("true");
    rt.events.said();
    t.hf.toggleMute();
    expect(rt.mutes).toEqual([true, false]);
    expect(t.bar.dataset.state).toBe("listening");
    expect(t.bar.dataset.muted).toBeUndefined();
    expect(t.mutedReports.at(-1)).toBe(false);
    expect(t.looks.at(-1)).toMatchObject({ muted: false });
    expect(t.sounds).toEqual(["start", "mute", "unmute"]);
  });

  it("no Mute while it starts or when voice is off; toggling then does nothing", async () => {
    const t = panel(1);
    t.hf.toggleMute();
    expect(t.hf.muted).toBe(false);
    t.hf.toggle("button");
    expect(t.button("vb-mute").hidden).toBe(true);
    await settle();
    expect(t.button("vb-mute").hidden).toBe(false);
  });

  it("the session ending unmutes: the next one starts with the microphone on", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.toggleMute();
    t.hf.toggle("button");
    expect(t.hf.active).toBe(false);
    expect(t.hf.muted).toBe(false);
    expect(t.reports.at(-1)).toEqual([false, null, null]);
    expect(t.mutedReports.at(-1)).toBe(false);
    t.hf.toggle("button");
    await settle();
    expect(t.hf.muted).toBe(false);
    expect(t.engines[1]!.mutes).toEqual([]);
  });

  it("moved to another tab it stays muted (a move never turns the microphone on)", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    const rt = t.engines[0]!;
    t.hf.toggleMute();
    t.hf.setSession(inTab1(2, { muted: true }));
    await settle();
    expect(t.bar.dataset.state).toBe("elsewhere");
    expect(find(t.bar, "vb-detail")!.textContent).toMatch(/ · Muted$/);
    // Mute is still there, looking at another tab.
    expect(t.button("vb-mute").hidden).toBe(false);
    expect(await rt.events.useThisTab()).toMatch(/^Moved/);
    expect(t.hf.tab).toBe(2);
    expect(t.hf.muted).toBe(true);
    expect(rt.mutes).toEqual([true]);
    expect(t.mutedReports.at(-1)).toBe(true);
  });

  it("Use voice here in another tab's panel: the session starts there muted, as it was", async () => {
    const t = panel(2);
    t.hf.setSession(inTab1(2, { muted: true }));
    expect(find(t.bar, "vb-detail")!.textContent).toBe("Realtime · Muted · Not listening in this tab");
    expect(t.button("vb-mute").hidden).toBe(true);
    t.button("vb-use").click();
    t.hf.setSession(null);
    await settle();
    const rt = t.engines[0]!;
    // Muted before it opened the microphone: nothing was heard in between.
    expect(rt.mutes[0]).toBe(true);
    expect(t.hf.muted).toBe(true);
    expect(t.bar.dataset.state).toBe("muted");
    expect(t.mutedReports.at(-1)).toBe(true);
  });

  it("Realtime failing over to Standard keeps the microphone muted", async () => {
    const t = panel(1);
    t.hf.toggle("button");
    await settle();
    t.hf.toggleMute();
    t.engines[0]!.events.failed({ kind: "unavailable", fallback: true, message: "Realtime is unavailable; using Standard." });
    await settle();
    const std = t.engines[1]!;
    expect(std.id).toBe("standard");
    expect(std.mutes).toEqual([true]);
    expect(t.hf.muted).toBe(true);
    expect(t.bar.dataset.state).toBe("muted");
  });
});
