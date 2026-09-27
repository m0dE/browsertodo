/**
 * The Realtime voice transport: one WebSocket to the account server's relay
 * (REALTIME_PATH), which passes OpenAI Realtime events through verbatim and
 * adds its own `browsertodo.error` events and close codes (the contract is
 * in @browsertodo/shared voice.ts). Everything that depends on the wire
 * format is in this file.
 *
 * The Realtime model is the narrator, not the browser agent: it hears the
 * user (server VAD, with barge-in), says short lines, is told what the agent
 * does (note(), see realtime-feed.ts) and hands requests to the agent through
 * its tools (send_to_agent, cancel_request, stop_task, end_voice), which the
 * side panel runs.
 *
 * Input transcription is on (REALTIME_INPUT_TRANSCRIPTION_MODEL, which the
 * relay bills and the server's price includes): the user's own words, keyed
 * by their input item, are what the chat shows. The agent gets the request
 * the narrator forwards (send_to_agent) at once, without waiting for them.
 * "stop" and "cancel" are the narrator's tools rather than words matched here.
 *
 * OpenAI event names and shapes as documented (read 2026-09-26):
 * developers.openai.com/api/docs/guides/realtime-conversations,
 * /realtime-vad, /realtime-transcription, and the client/server event reference.
 */
import {
  PLAN_REQUIRED_MESSAGES,
  OUT_OF_CREDIT,
  REALTIME_CLOSE,
  REALTIME_ERROR_EVENT,
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  REALTIME_LIMITS,
  REALTIME_PATH,
  REALTIME_PROTOCOL,
  REALTIME_QUERY,
  REALTIME_TOKEN_PROTOCOL_PREFIX,
  RealtimeErrorEvent,
  clampSpeed,
  DEFAULT_REALTIME_VOICE,
  REALTIME_SPEED,
  type RealtimeErrorCode,
  type RealtimeVoiceId,
} from "@browsertodo/shared";
import { bytesToBase64 } from "../base64.js";
import { REALTIME_NOT_AVAILABLE_NOTE } from "./engine-choice.js";

/** PCM16 mono at this rate, both ways ("audio/pcm" is 24 kHz). */
export const REALTIME_SAMPLE_RATE = 24_000;

/** Quiet after speech that ends the user's turn (server VAD). */
const TURN_SILENCE_MS = 700;

export const NARRATOR_INSTRUCTIONS = [
  "You are the voice of BrowserTODO, an assistant that works in the user's Chrome browser.",
  "A separate agent does all the work in the browser. You never do anything yourself: you listen, pass requests on, and tell the user what the agent is doing.",
  "When the user asks for something, call send_to_agent immediately, before saying anything. After it returns, say at most one short acknowledgement.",
  "Pass the request in the user's own words, keeping every detail (names, the text to post, times). A message for the running task (for example 'use the second draft') goes the same way.",
  "If right after that the user says 'cancel', 'never mind' or 'don't send it', call cancel_request: the request already went to the agent, and this stops its task.",
  "You get 'Agent update' messages about what the agent does. When asked to reply, say it in one short sentence for progress, and one or two sentences for a result. Never read long text, lists, links, code or numbers of steps aloud. Never make up results: say only what the updates say.",
  "When the agent needs the user (a question, a login, a code), ask the user in your own words and pass their answer on with send_to_agent.",
  "If the user asks to stop the task, call stop_task. If they say goodbye or ask you to stop listening, call end_voice.",
  "Be friendly and brief. Speak the user's language.",
].join("\n");

/** The one reply after send_to_agent, when the narrator did not speak before calling it. */
export const ACKNOWLEDGE_INSTRUCTIONS = "Say one very short acknowledgement, a few words such as 'On it.', and nothing else.";

/** The narrator's tools (function tools only: the relay refuses others). */
export const NARRATOR_TOOLS = [
  {
    type: "function",
    name: "send_to_agent",
    description:
      "Give the browser agent a request from the user: a new task, or a message for the task it is running. It goes to the agent at once. Use the user's own words and keep every detail.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The request, in the user's words" } },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "cancel_request",
    description: "The user takes back the request just given to send_to_agent (cancel, never mind). It already went to the agent, so this stops the task it started.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "stop_task",
    description: "Stop the task the agent is running, when the user asks to stop it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_voice",
    description: "End the hands-free conversation (the microphone turns off), when the user says goodbye or asks you to stop listening.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export type NarratorTool = (typeof NARRATOR_TOOLS)[number]["name"];
const TOOL_NAMES = new Set<string>(NARRATOR_TOOLS.map((t) => t.name));

/** The relay's address for an account server: wss://<host>/v1/ai/realtime (ws:// for a local http one). */
export function realtimeUrl(apiBase: string, sessionId?: string): string {
  const u = new URL(REALTIME_PATH, apiBase.replace(/\/+$/, "") + "/");
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  if (sessionId) u.searchParams.set(REALTIME_QUERY.session, sessionId);
  return u.toString();
}

// ---------------------------------------------------------------- failures

export type RealtimeFailureKind = "auth" | "credit" | "plan" | "idle" | "limit" | "busy" | "unavailable" | "upstream" | "protocol" | "network";

export interface RealtimeFailure {
  kind: RealtimeFailureKind;
  /** One line for the panel; auth, credit and plan use the texts error-help.ts knows (its fix buttons). */
  message: string;
  /** Standard voice can take over (Realtime could not, but voice as such can). */
  fallback: boolean;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

const FAILURES: Record<RealtimeFailureKind, RealtimeFailure> = {
  auth: { kind: "auth", message: "Not signed in: log in again to use voice.", fallback: false },
  credit: { kind: "credit", message: `${OUT_OF_CREDIT}: top up to keep using voice.`, fallback: false },
  plan: { kind: "plan", message: PLAN_REQUIRED_MESSAGES.voice, fallback: false },
  idle: { kind: "idle", message: `Hands-free stopped after ${minutes(REALTIME_LIMITS.idleMs)} minutes without activity.`, fallback: false },
  limit: { kind: "limit", message: `Hands-free stopped: a Realtime session lasts up to ${minutes(REALTIME_LIMITS.maxSessionMs)} minutes.`, fallback: false },
  busy: { kind: "busy", message: "Realtime voice is open in another window. Using Standard.", fallback: true },
  unavailable: { kind: "unavailable", message: REALTIME_NOT_AVAILABLE_NOTE, fallback: true },
  upstream: { kind: "upstream", message: REALTIME_NOT_AVAILABLE_NOTE, fallback: true },
  protocol: { kind: "protocol", message: REALTIME_NOT_AVAILABLE_NOTE, fallback: true },
  network: { kind: "network", message: REALTIME_NOT_AVAILABLE_NOTE, fallback: true },
};

const KIND_OF_ERROR: Partial<Record<RealtimeErrorCode, RealtimeFailureKind>> = {
  unauthorized: "auth",
  plan_required: "plan",
  out_of_credit: "credit",
  realtime_unavailable: "unavailable",
  session_open: "busy",
  idle_timeout: "idle",
  session_limit: "limit",
  message_too_big: "protocol",
  upstream_error: "upstream",
};

const KIND_OF_CLOSE: Record<number, RealtimeFailureKind> = {
  [REALTIME_CLOSE.auth]: "auth",
  [REALTIME_CLOSE.credit]: "credit",
  [REALTIME_CLOSE.plan]: "plan",
  [REALTIME_CLOSE.idle]: "idle",
  [REALTIME_CLOSE.concurrent]: "busy",
  [REALTIME_CLOSE.sessionLimit]: "limit",
  [REALTIME_CLOSE.upstream]: "upstream",
  [REALTIME_CLOSE.unavailable]: "unavailable",
  [REALTIME_CLOSE.tooBig]: "protocol",
};

/** Why a session ended that we did not end: the server's error code first, then the close code. */
export function realtimeFailure(input: { closeCode: number; error?: RealtimeErrorCode; opened: boolean }): RealtimeFailure {
  const kind = (input.error && KIND_OF_ERROR[input.error]) || KIND_OF_CLOSE[input.closeCode] || (input.opened ? "upstream" : "network");
  return FAILURES[kind];
}

// ---------------------------------------------------------------- the client

/** The WebSocket as the client uses it (a fake in tests). */
export interface RealtimeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type OpenSocket = (url: string, protocols: string[]) => RealtimeSocketLike;

const OPEN = 1;

export interface RealtimeHandlers {
  /** The session is configured (session.updated). */
  onReady?(): void;
  /** A chunk of the narrator's speech: base64 PCM16 at REALTIME_SAMPLE_RATE, of item `itemId`. */
  onAudio?(base64: string, itemId: string): void;
  /** What the narrator is saying so far. */
  onNarratorText?(text: string): void;
  /** A reply is complete (all its audio arrived). */
  onReplyDone?(): void;
  /** The user started talking (server VAD): the narrator stops; local playback must too. */
  onUserSpeech?(): void;
  /**
   * A narrator tool call; the answer goes back to the narrator (a throw is answered as an error).
   * inputId: the user's input item the reply making the call answers (null: a reply we asked for).
   */
  onTool?(name: NarratorTool, args: Record<string, unknown>, inputId: string | null): Promise<string> | string;
  /** The user's words of input item `inputId`, word for word ("" when they could not be transcribed). */
  onUserWords?(inputId: string, text: string): void;
  /** The reply to input item `inputId` is done (its tool calls, if any, came before). */
  onTurnDone?(inputId: string): void;
  /** The session ended: null when we closed it, else why. */
  onClose?(failure: RealtimeFailure | null): void;
  log?(message: string): void;
}

export interface RealtimeClientOptions {
  url: string;
  token: string;
  handlers: RealtimeHandlers;
  instructions?: string;
  /** The narrator's voice and speaking speed (Settings; the voice is fixed once it spoke). */
  voice?: RealtimeVoiceId;
  speed?: number;
  open?: OpenSocket;
}

type ServerEvent = { type?: unknown; [k: string]: unknown };

export class RealtimeClient {
  private socket: RealtimeSocketLike | null = null;
  private opened = false;
  private closing = false;
  private ended = false;
  /** A reply is being made (response.created .. response.done). */
  private responding = false;
  /** The current (or last) reply has audio: the narrator spoke in it. */
  private spoke = false;
  /** A reply to ask for once the current one is done: one for the notes, or only the acknowledgement of a request. */
  private wantReply: "reply" | "acknowledge" | null = null;
  /** The user's latest input item that no reply answered yet, and the one the current reply answers. */
  private unansweredInput: string | null = null;
  private replyInput: string | null = null;
  private lastError: RealtimeErrorCode | undefined;
  private narratorText = "";
  private ready = false;

  constructor(private readonly opts: RealtimeClientOptions) {}

  connect(): void {
    const open = this.opts.open ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as RealtimeSocketLike);
    const ws = open(this.opts.url, [REALTIME_PROTOCOL, `${REALTIME_TOKEN_PROTOCOL_PREFIX}${this.opts.token}`]);
    this.socket = ws;
    ws.onopen = () => {
      this.opened = true;
      this.send({ type: "session.update", session: this.sessionConfig() });
    };
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onerror = () => this.log("realtime socket error");
    ws.onclose = (e) => this.onClosed(e.code);
  }

  /** Microphone audio (PCM16 at REALTIME_SAMPLE_RATE). */
  appendAudio(pcm: Int16Array): void {
    this.send({ type: "input_audio_buffer.append", audio: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) });
  }

  /** Tells the narrator something (a system message); `respond`: and asks it to reply (once no reply is being made). */
  note(text: string, respond: boolean): void {
    if (!this.isOpen()) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    if (respond) this.requestReply();
  }

  /** Stops the reply being made (the user pressed Esc or the shortcut while it spoke). */
  cancelResponse(): void {
    this.wantReply = null;
    if (this.responding) this.send({ type: "response.cancel" });
  }

  /** The user heard only `audioEndMs` of item `itemId` (it was cut off): the narrator's memory is trimmed to match. */
  truncate(itemId: string, audioEndMs: number): void {
    this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) });
  }

  close(): void {
    this.closing = true;
    if (!this.socket || this.socket.readyState > OPEN) return this.finish(null);
    this.socket.close(REALTIME_CLOSE.normal, "done");
  }

  private sessionConfig(): Record<string, unknown> {
    const format = { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE };
    return {
      type: "realtime",
      instructions: this.opts.instructions ?? NARRATOR_INSTRUCTIONS,
      tools: NARRATOR_TOOLS,
      tool_choice: "auto",
      audio: {
        input: {
          format,
          transcription: { model: REALTIME_INPUT_TRANSCRIPTION_MODEL },
          turn_detection: { type: "server_vad", silence_duration_ms: TURN_SILENCE_MS, create_response: true, interrupt_response: true },
        },
        output: { format, voice: this.opts.voice ?? DEFAULT_REALTIME_VOICE, speed: clampSpeed(this.opts.speed ?? REALTIME_SPEED.default, REALTIME_SPEED) },
      },
    };
  }

  private isOpen(): boolean {
    return !!this.socket && this.socket.readyState === OPEN && !this.closing;
  }

  private send(event: Record<string, unknown>): void {
    if (this.isOpen()) this.socket!.send(JSON.stringify(event));
  }

  /**
   * Asks for a reply now, or once the one being made is done. An acknowledgement is only wanted when the reply that
   * called send_to_agent said nothing: it is dropped when that reply spoke, and a reply for the notes covers it.
   */
  private requestReply(kind: "reply" | "acknowledge" = "reply"): void {
    if (this.responding) {
      if (this.wantReply !== "reply") this.wantReply = kind;
      return;
    }
    this.wantReply = null;
    if (kind === "acknowledge" && this.spoke) return;
    this.send(kind === "acknowledge" ? { type: "response.create", response: { instructions: ACKNOWLEDGE_INSTRUCTIONS } } : { type: "response.create" });
  }

  private onMessage(data: unknown): void {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(String(data)) as ServerEvent;
    } catch {
      return this.log("realtime: an event that is not JSON");
    }
    const h = this.opts.handlers;
    const str = (k: string) => (typeof ev[k] === "string" ? (ev[k] as string) : "");
    switch (ev.type) {
      // OpenAI's first event is session.created; our session.update went before any audio, so either means ready.
      case "session.created":
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          h.onReady?.();
        }
        break;
      case "response.created":
        this.responding = true;
        this.spoke = false;
        this.narratorText = "";
        this.replyInput = this.unansweredInput;
        this.unansweredInput = null;
        break;
      case "response.done": {
        this.responding = false;
        const answered = this.replyInput;
        this.replyInput = null;
        h.onReplyDone?.();
        if (answered) h.onTurnDone?.(answered);
        if (this.wantReply) this.requestReply(this.wantReply);
        break;
      }
      case "response.output_audio.delta":
        this.spoke = true;
        h.onAudio?.(str("delta"), str("item_id"));
        break;
      case "input_audio_buffer.committed":
        // The user's turn is in: the reply the server makes next answers it.
        if (str("item_id")) this.unansweredInput = str("item_id");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (str("item_id")) h.onUserWords?.(str("item_id"), str("transcript").trim());
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.log("realtime: the user's words could not be transcribed");
        if (str("item_id")) h.onUserWords?.(str("item_id"), "");
        break;
      case "response.output_audio_transcript.delta":
        this.narratorText += str("delta");
        h.onNarratorText?.(this.narratorText);
        break;
      case "input_audio_buffer.speech_started":
        // The user's turn gets its own reply; ours would talk over it.
        this.wantReply = null;
        h.onUserSpeech?.();
        break;
      case "response.function_call_arguments.done":
        void this.runTool(str("call_id"), str("name"), str("arguments"), this.replyInput);
        break;
      case REALTIME_ERROR_EVENT: {
        const parsed = RealtimeErrorEvent.safeParse(ev);
        if (!parsed.success) return this.log(`realtime: unreadable ${REALTIME_ERROR_EVENT}`);
        if (parsed.data.error === "denied") return this.log(`realtime denied: ${parsed.data.message}`);
        this.lastError = parsed.data.error;
        this.log(`realtime ${parsed.data.error}: ${parsed.data.message}`);
        break;
      }
      case "error": {
        const e = (ev.error ?? {}) as { code?: unknown; message?: unknown };
        this.log(`realtime error: ${String(e.code ?? "")}: ${String(e.message ?? "")}`);
        break;
      }
    }
  }

  private async runTool(callId: string, name: string, rawArgs: string, inputId: string | null): Promise<void> {
    let output: string;
    let args: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = null;
    }
    if (!TOOL_NAMES.has(name)) output = `Error: unknown tool ${name}`;
    else if (!args) output = "Error: the arguments are not valid JSON";
    else {
      try {
        output = (await this.opts.handlers.onTool?.(name as NarratorTool, args, inputId)) ?? "Done.";
      } catch (err) {
        output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    // Tool first, then at most one short acknowledgement (none when the narrator already spoke in that reply).
    this.requestReply(name === "send_to_agent" ? "acknowledge" : "reply");
  }

  private onClosed(code: number): void {
    const ours = this.closing && (code === REALTIME_CLOSE.normal || code === 1005);
    this.finish(ours ? null : realtimeFailure({ closeCode: code, error: this.lastError, opened: this.opened }));
  }

  private finish(failure: RealtimeFailure | null): void {
    if (this.ended) return;
    this.ended = true;
    this.responding = false;
    this.wantReply = null;
    this.opts.handlers.onClose?.(failure);
  }

  private log(message: string): void {
    this.opts.handlers.log?.(message);
  }
}
