/**
 * The Realtime hands-free engine: the microphone streams to the narrator
 * (PCM16 at 24 kHz, about every 100 ms), its speech plays back (PcmPlayer),
 * the chat's events go to it as notes (NarratorFeed), and its tools reach
 * the panel (send_to_agent, stop_task, end_voice). Turn-taking and barge-in
 * are OpenAI's server VAD; local playback stops the moment the user speaks.
 */
import type { AgentEvent } from "@browsertodo/shared";
import type { AudioSource } from "./dictation.js";
import type { EngineEvents, HandsFreeEngine } from "./engine.js";
import { PcmPlayer } from "./pcm-player.js";
import { RealtimeClient, realtimeFailure, REALTIME_SAMPLE_RATE, type NarratorTool, type OpenSocket, type RealtimeFailure } from "./realtime-client.js";
import type { RealtimeTicket } from "./realtime-access.js";
import { NarratorFeed } from "./realtime-feed.js";
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
  log?(message: string): void;
  openSocket?: OpenSocket;
  player?: Pick<PcmPlayer, "play" | "stop" | "close" | "playing">;
}

export class RealtimeEngine implements HandsFreeEngine {
  readonly id = "realtime" as const;
  readonly halfDuplex = false;
  private client: RealtimeClient | null = null;
  private source: AudioSource | null = null;
  private readonly feed = new NarratorFeed();
  private readonly player: Pick<PcmPlayer, "play" | "stop" | "close" | "playing">;
  private chunks: Float32Array[] = [];
  private chunked = 0;
  private level = 0;
  private stopped = false;

  constructor(private readonly deps: RealtimeEngineDeps) {
    const ev = deps.events;
    this.player = deps.player ?? new PcmPlayer(REALTIME_SAMPLE_RATE, { onStart: () => ev.narrating(), onIdle: () => !this.stopped && ev.said() });
  }

  async start(): Promise<void> {
    const ticket = await this.deps.ticket();
    const ev = this.deps.events;
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
      this.client = new RealtimeClient({
        url: ticket.url,
        token: ticket.token,
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
          onTool: (name, args) => this.tool(name, args),
          onClose: (f) => f && fail(f),
          log: (m) => this.deps.log?.(m),
        },
      });
      this.client.connect();
    });
    if (this.stopped) return;
    const source = this.deps.createSource();
    this.source = source;
    await source.start((s) => this.onSamples(s));
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

  cancelled(): void {
    this.client?.note("Agent update: the user cancelled that request before it was sent; the agent did not get it.", false);
  }

  tick(now: number): void {
    for (const n of this.feed.tick(now)) this.client?.note(n.text, n.respond);
  }

  /** Stops local playback; the narrator's memory keeps only what was heard. */
  private cutOff(): void {
    const cut = this.player.stop();
    if (cut) this.client?.truncate(cut.itemId, cut.playedMs);
  }

  private async tool(name: NarratorTool, args: Record<string, unknown>): Promise<string> {
    const ev = this.deps.events;
    switch (name) {
      case "send_to_agent": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return "Error: say what to send (text).";
        ev.forward(text);
        return "Sent to the agent (the user can still cancel it in the next second). Its updates will follow.";
      }
      case "cancel_request":
        return ev.cancelRequest() ? "Cancelled: the agent did not get it." : "It was already sent. Call stop_task to stop the task.";
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
