/**
 * A hands-free voice engine as the side panel drives it: Standard
 * (standard-engine.ts: speech detection, Whisper, the browser's speech) or
 * Realtime (realtime-engine.ts: the OpenAI narrator through the relay). The
 * panel runs the session's state machine (hands-free.ts) on what an engine
 * reports, and tells the engine what to do.
 */
import type { AgentEvent, VoiceEngineId } from "@browsertodo/shared";

export interface EngineEvents {
  /** The user started speaking (while a line is said: long enough to be a barge-in). */
  speech(): void;
  /** What the user said; forward: a message for the agent (Standard), else only checked for stop and cancel words. */
  heard(text: string, forward: boolean): void;
  /** The user's words so far. */
  partial(text: string): void;
  /** Microphone level, 0..1. */
  level(level: number): void;
  /** The narrator started talking by itself (Realtime). */
  narrating(): void;
  /** The line (or the narrator) is done. */
  said(): void;
  /** What the narrator is saying so far (Realtime). */
  narratorText(text: string): void;
  /** A request for the agent from the narrator (Realtime send_to_agent). */
  forward(text: string): void;
  /** The narrator takes the request back (cancel_request): true when it was still waiting to be sent. */
  cancelRequest(): boolean;
  /** The narrator asks to stop the running task; the answer goes back to it. */
  stopTask(): Promise<string>;
  /** The narrator ends the session (the user said goodbye). */
  endVoice(): void;
  /** The engine cannot go on (Realtime: a RealtimeFailure; Standard: a VoiceError). */
  failed(err: unknown): void;
}

export interface HandsFreeEngine {
  readonly id: VoiceEngineId;
  /** Nothing is transcribed while a line is said (it would hear itself). */
  readonly halfDuplex: boolean;
  /** Opens the microphone (and the connection). Rejects when it cannot start. */
  start(): Promise<void>;
  stop(): void;
  /** Says a line (Standard; the Realtime narrator speaks for itself). */
  speak(text: string): void;
  /** Stops talking now. */
  hush(): void;
  /** Half-duplex: stop or start turning speech into text. */
  setTranscribing(on: boolean): void;
  /** An event of the chat the session follows (Realtime tells the narrator). */
  agentEvent(ev: AgentEvent, now: number): void;
  /** A message waiting in the sending window was cancelled (Realtime tells the narrator). */
  cancelled(): void;
  tick(now: number): void;
}
