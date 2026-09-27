/**
 * The user's words in a Realtime chat, end to end in the side panel (the real RealtimeEngine and RealtimeClient over
 * a fake OpenAI socket, the chat's events as the background keeps them, rendered as the chat pairs them): each input
 * item's words show once, and the request the narrator passed on shows under the words it came from ("sent"),
 * never as a user message of its own. Reported (build 81df820): while the user looked at another tab, the
 * narrator's condensed request showed as a second user bubble after their words ("transcribed twice").
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ExtensionSettings, VoiceEnginesResponse } from "@browsertodo/shared";
import { initHandsFree, type HandsFreeDeps } from "../../src/sidepanel/hands-free.js";
import { describeEvent, pairHeard } from "../../src/sidepanel/event-format.js";
import type { RealtimeSocketLike } from "../../src/voice/realtime-client.js";
import { RealtimeEngine } from "../../src/voice/realtime-engine.js";
import type { VoiceSessionView } from "../../src/voice-session.js";
import { installMiniDom, MiniElement } from "../ui/mini-dom.js";

class FakeOpenAi implements RealtimeSocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  private n = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    const e = JSON.parse(data);
    this.sent.push(e);
    // A reply we ask for (the acknowledgement): "On it."
    if (e.type === "response.create") {
      const id = `ours_${++this.n}`;
      setTimeout(() => {
        this.event({ type: "response.created", response: { id } });
        this.event({ type: "response.output_audio.delta", item_id: `a_${id}`, delta: "AAAA" });
        this.event({ type: "response.done", response: { id, status: "completed", output: [] } });
      }, 5);
    }
  }
  close(code = 1000): void {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" }));
  }
  event(e: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

// The report's words (gpt-transcribe) and the narrator's send_to_agent text.
const W1 = "Herring's Landing. Give me one second here. Let me take a look.";
const W2 = "So the ticket here says, one sec, view task.";
const W3 =
  "Yeah, so take a look at the ticket that I'm showing you right now. So they were experiencing this issue a few days, or this was a while ago, actually. Maybe this is not relevant. You know what? Forget this for now, and I want you to look at something else. I want you to look at, let's look at the intercom and see if there are any other tickets from REN from Heron's Landing, either from REN or the property.";
const REQUEST = "Forget that for now. I want you to look at Intercom and see if there are any other tickets from Ren from Herons Landing, either from Ren or the property.";

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The session in tab 1 (Intercom, chat s1); `viewing`: the tab the user looks at. The chat's events as kept. */
async function session(viewing: number) {
  const socket = new FakeOpenAi();
  const chat: AgentEvent[] = [];
  const deps: HandsFreeDeps = {
    voice: { state: "idle", attachHandsFree: () => {}, showHandsFree: () => {}, setLevel: () => {}, showTip: () => {}, ensureMic: async () => true, shortcutLabel: null },
    composer: { draft: () => "", setDraft: () => {} },
    notify: () => {},
    activeTab: () => 1,
    chatOf: () => "s1",
    tabsOf: () => [1],
    // The background keeps the message as it was sent (runner deliver / lifecycle: user_message, voice).
    send: vi.fn(async (text: string) => {
      chat.push({ type: "user_message", text, voice: true });
      return "s1";
    }),
    homeTab: 1,
    tabPage: async (id) => (id === 1 ? { title: "Intercom", url: "https://app.intercom.com/" } : { title: "Ticket", url: "https://tickets.example/" }),
    goToTab: () => {},
    onSpeaking: () => {},
    keepSpoken: () => {},
    // voice.heard: kept as a heard event.
    keepHeard: (_s, text, sent) => void chat.push(sent ? { type: "heard", text, sent } : { type: "heard", text }),
    settings: () => ({ voiceEngine: "realtime", realtimeCostNoticed: true }) as ExtensionSettings,
    account: () => undefined,
    engines: async () => ({ default: "realtime", engines: [{ id: "realtime", name: "Realtime", model: "gpt-realtime-2.1", approxCentsPerMinute: 6, assumption: "", available: true }] }) as VoiceEnginesResponse,
    saveSettings: async () => {},
    createEngine: (_id, events) =>
      new RealtimeEngine({
        ticket: async () => ({ url: "wss://x/v1/ai/realtime", token: "t" }),
        createSource: () => ({ start: async () => {}, stop: () => {} }),
        events,
        openSocket: () => {
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.onopen?.({});
            socket.event({ type: "session.created", session: {} });
          });
          return socket;
        },
        player: { play: () => {}, stop: () => null, close: () => {}, playing: false },
      }),
    stopTask: async () => "",
    answerApproval: async () => true,
    openBilling: () => {},
    signIn: () => {},
    onActive: () => {},
    stopRemote: () => {},
    bar: new MiniElement("div") as unknown as HTMLElement,
    earcons: { play: () => {} },
  };
  const hf = initHandsFree(deps);
  hf.toggle("button");
  await settle();
  hf.setSession({ tabId: 1, windowId: 5, host: 1, engine: "realtime", viewing } satisfies VoiceSessionView);
  await settle();
  return { socket, chat, deps };
}

/** One user turn (input item `id`): its reply speaks, or calls send_to_agent with `request`; its words before or after. */
async function turn(s: FakeOpenAi, id: string, words: string, request: string | null, wordsLate: boolean): Promise<void> {
  const transcribed = () => s.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, content_index: 0, transcript: words });
  s.event({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
  s.event({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 3000 });
  s.event({ type: "input_audio_buffer.committed", item_id: id });
  s.event({ type: "response.created", response: { id: `r_${id}` } });
  if (!wordsLate) transcribed();
  if (request) {
    s.event({ type: "response.output_item.added", item: { type: "function_call", name: "send_to_agent" } });
    s.event({ type: "response.function_call_arguments.done", call_id: `c_${id}`, name: "send_to_agent", arguments: JSON.stringify({ text: request }) });
  } else s.event({ type: "response.output_audio.delta", item_id: `a_${id}`, delta: "AAAA" });
  s.event({ type: "response.done", response: { id: `r_${id}`, status: "completed", output: [] } });
  if (wordsLate) transcribed();
  await settle(30);
}

/** What the chat shows for the user: each bubble's text, and its "sent" line (the chat's own pairing, as in chat.ts). */
function userBubbles(events: readonly AgentEvent[]): { text: string; sent?: string }[] {
  const pairs = pairHeard(events, null);
  const out: { text: string; sent?: string }[] = [];
  events.forEach((ev, i) => {
    if (pairs.placed.has(i)) return;
    const shown = pairs.messages.has(i) ? events[pairs.messages.get(i)!]! : ev;
    const v = describeEvent(shown);
    if (v.kind === "user") out.push({ text: v.text, ...(v.sent ? { sent: v.sent } : {}) });
  });
  return out;
}

describe("Realtime: the user's words show once, the request under them", () => {
  beforeAll(installMiniDom);

  for (const viewing of [1, 2]) {
    for (const wordsLate of [false, true]) {
      it(`looking at ${viewing === 1 ? "the session's tab" : "another tab"}, words ${wordsLate ? "after" : "before"} the call: the request is a "sent" line under its words, never its own bubble`, async () => {
        const t = await session(viewing);
        await turn(t.socket, "in1", W1, null, wordsLate);
        await turn(t.socket, "in2", W2, null, wordsLate);
        await turn(t.socket, "in3", W3, REQUEST, wordsLate);
        // Late or repeated transcription events of settled items add nothing.
        t.socket.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "in3", content_index: 0, transcript: W3 });
        t.socket.event({ type: "conversation.item.input_audio_transcription.failed", item_id: "in3", error: { message: "x" } });
        await settle(30);
        // The agent got the narrator's request only (with the note on the tab the user looks at, when away).
        expect(t.deps.send).toHaveBeenCalledTimes(1);
        expect((t.deps.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/^Forget that for now\. I want you to look at Intercom/);
        const bubbles = userBubbles(t.chat);
        // Each input item's words once.
        expect(bubbles.filter((b) => b.text === W3)).toHaveLength(1);
        expect(bubbles.find((b) => b.text === W3)).toMatchObject({ sent: REQUEST });
        // The request is never a user bubble of its own.
        expect(bubbles.filter((b) => b.text.startsWith("Forget that for now"))).toEqual([]);
      });
    }
  }
});
