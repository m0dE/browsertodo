/**
 * The Realtime hands-free engine: the microphone streams to the narrator
 * (PCM16 at 24 kHz, about every 100 ms), its speech plays back (PcmPlayer),
 * the chat's events go to it as notes (NarratorFeed), and its tools reach
 * the panel (send_to_agent at once, stop_task and cancel_request, end_voice).
 * Each turn's own words (the input transcription) reach the panel paired with
 * the request sent for them (RealtimeTurns). Turn-taking and barge-in are
 * OpenAI's server VAD; local playback stops the moment the user speaks.
 */
import { traceStart, type AgentEvent, type RealtimeVoiceId } from "@browsertodo/shared";
import type { VoiceTracer } from "../trace/panel-trace.js";
import type { AudioSource } from "./dictation.js";
import type { EngineEvents, HandsFreeEngine } from "./engine.js";
import { PcmPlayer } from "./pcm-player.js";
import { RealtimeClient, realtimeFailure, REALTIME_SAMPLE_RATE, type NarratorTool, type OpenSocket, type RealtimeFailure } from "./realtime-client.js";
import type { RealtimeTicket } from "./realtime-access.js";
import { NarratorFeed } from "./realtime-feed.js";
import { RealtimeTurns } from "./realtime-turns.js";
import { meterLevel, rms } from "./speech.js";
import { toInt16 } from "./wav.js";

/** Microphone audio is sent in chunks of about this long. */
const SEND_EVERY_MS = 100;
/** Starting may take this long (the relay, OpenAI's session) before it counts as failed. */
const START_TIMEOUT_MS = 15_000;

export interface RealtimeEngineDeps {
  /** Where to connect, with the session token. Rejects with the reason it cannot. */
  ticket(): Promise<RealtimeTicket>;
  /** The microphone at REALTIME_SAMPLE_RATE. */
  createSource(): AudioSource;
  events: EngineEvents;
  /** The narrator's voice and speaking speed (Settings). */
  voice?: { voice: RealtimeVoiceId; speed: number };
  log?(message: string): void;
  openSocket?: OpenSocket;
  player?: Pick<PcmPlayer, "play" | "stop" | "close" | "playing">;
  /** The conversation's trace: the relay's check (ticket), connecting, each narrator reply, its tool calls. */
  trace?: VoiceTracer;
}

export class RealtimeEngine implements HandsFreeEngine {
  readonly id = "realtime" as const;
  readonly halfDuplex = false;
  private client: RealtimeClient | null = null;
  private source: AudioSource | null = null;
  private readonly feed = new NarratorFeed();
  private readonly turns: RealtimeTurns;
  private readonly player: Pick<PcmPlayer, "play" | "stop" | "close" | "playing">;
  private chunks: Float32Array[] = [];
  private chunked = 0;
  private level = 0;
  private stopped = false;

  constructor(private readonly deps: RealtimeEngineDeps) {
    const ev = deps.events;
    this.player = deps.player ?? new PcmPlayer(REALTIME_SAMPLE_RATE, { onStart: () => ev.narrating(), onIdle: () => !this.stopped && ev.said() });
    this.turns = new RealtimeTurns((words, sent) => !this.stopped && ev.userWords(words, sent));
  }

  /** Resolves once the narrator listens; stopped meanwhile (stop()), it closes what it opened and resolves. */
  async start(): Promise<void> {
    const trace = this.deps.trace;
    const asking = traceStart();
    const ticket = await this.deps.ticket();
    // The background asks the account server first (signed in, plan, credit): the relay's pre-check.
    trace?.record({ t: asking.t, ms: asking.elapsed(), cat: "voice", name: "voice.ticket", data: { waitMs: asking.elapsed() } });
    if (this.stopped) return;
    const ev = this.deps.events;
    let client!: RealtimeClient;
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => fail(realtimeFailure({ closeCode: 1006, opened: false })), START_TIMEOUT_MS);
      const fail = (f: RealtimeFailure) => {
        clearTimeout(timer);
        if (!started) {
          started = true;
          this.client?.close();
          reject(f);
        } else if (!this.stopped) ev.failed(f);
      };
      client = this.client = new RealtimeClient({
        url: ticket.url,
        token: ticket.token,
        ...(this.deps.voice ? { voice: this.deps.voice.voice, speed: this.deps.voice.speed } : {}),
        ...(this.deps.openSocket ? { open: this.deps.openSocket } : {}),
        handlers: {
          onReady: () => {
            if (started) return;
            started = true;
            clearTimeout(timer);
            resolve();
          },
          onAudio: (b64, itemId) => this.player.play(b64, itemId),
          onNarratorText: (t) => ev.narratorText(t),
          onUserSpeech: () => {
            this.cutOff();
            ev.speech();
          },
          onTool: (name, args, inputId) => this.tool(name, args, inputId),
          onUserWords: (inputId, text) => this.turns.words(inputId, text),
          onTurnDone: (inputId) => {
            this.turns.replied(inputId);
            // A turn that sent nothing: its timings stay with the session's chat.
            trace?.endUtterance(inputCid(inputId));
          },
          onClose: (f) => {
            if (f) return fail(f);
            // We closed it before it was ready (stop() while connecting): starting is over.
            if (started) return;
            started = true;
            clearTimeout(timer);
            resolve();
          },
          // Timings of the user's turn join the message it led to (by its input item).
          ...(trace ? { onTrace: (e, inputId) => trace.record(inputId ? { ...e, cid: inputCid(inputId) } : e) } : {}),
          log: (m) => this.deps.log?.(m),
        },
      });
      client.connect();
    });
    if (this.stopped) {
      // stop() came while connecting: nothing of this session may stay open.
      client.close();
      this.client = null;
      return;
    }
    const source = this.deps.createSource();
    this.source = source;
    await source.start((s) => this.onSamples(s));
    if (this.stopped) source.stop();
  }

  stop(): void {
    this.stopped = true;
    this.source?.stop();
    this.source = null;
    this.player.close();
    this.client?.close();
    this.client = null;
  }

  speak(_text: string): void {
    // The narrator says things in its own words (see the feed).
  }

  hush(): void {
    this.cutOff();
    this.client?.cancelResponse();
  }

  setTranscribing(_on: boolean): void {
    // Not half-duplex: OpenAI's turn detection hears the user over the narrator.
  }

  agentEvent(ev: AgentEvent, now: number): void {
    for (const n of this.feed.push(ev, now)) this.client?.note(n.text, n.respond);
  }

  tick(now: number): void {
    for (const n of this.feed.tick(now)) this.client?.note(n.text, n.respond);
  }

  /** Stops local playback; the narrator's memory keeps only what was heard. */
  private cutOff(): void {
    const cut = this.player.stop();
    if (cut) this.client?.truncate(cut.itemId, cut.playedMs);
  }

  private async tool(name: NarratorTool, args: Record<string, unknown>, inputId: string | null): Promise<string> {
    const ev = this.deps.events;
    const trace = this.deps.trace;
    // The request goes out as the utterance of the turn that called it (its message carries that id).
    const cid = inputId ? inputCid(inputId) : undefined;
    if (trace && cid && name === "send_to_agent") trace.useUtterance(cid);
    trace?.record({ t: Date.now(), cat: "voice", name: `voice.tool.${name}`, ...(cid ? { cid } : {}) });
    switch (name) {
      case "send_to_agent": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return "Error: say what to send (text).";
        ev.forward(text);
        this.turns.sent(inputId, text);
        return "Sent to the agent. Its updates will follow.";
      }
      // The request already went out: taking it back stops its task.
      case "cancel_request":
      case "stop_task":
        return ev.stopTask();
      case "end_voice":
        // After this reply: the narrator may say goodbye first.
        setTimeout(() => ev.endVoice(), 0);
        return "Ending the hands-free conversation.";
    }
  }

  private onSamples(s: Float32Array): void {
    this.chunks.push(s);
    this.chunked += s.length;
    this.level += (meterLevel(rms(s)) - this.level) * 0.35;
    this.deps.events.level(this.level);
    if (this.chunked < (REALTIME_SAMPLE_RATE * SEND_EVERY_MS) / 1000) return;
    const all = new Float32Array(this.chunked);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.chunked = 0;
    this.client?.appendAudio(toInt16(all));
  }
}

/** The trace's correlation id of the user's input item `inputId` (a turn of theirs). */
export function inputCid(inputId: string): string {
  return `rt-${inputId.replace(/[^\w-]/g, "").slice(0, 60)}`;
}
