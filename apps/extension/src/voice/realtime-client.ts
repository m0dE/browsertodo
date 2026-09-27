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
 * its tools (send_to_agent, cancel_request, stop_task, use_this_tab,
 * end_voice), which the side panel runs. Notes also say which tab it works
 * in when the user looks at another one (it cannot see that tab).
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
  type TraceDraft,
} from "@browsertodo/shared";
import { bytesToBase64 } from "../base64.js";
import { REALTIME_NOT_AVAILABLE_NOTE } from "./engine-choice.js";
import { floor, isNoise, moreImportant, repeatsRequest, type ForwardedRequest, type ReplyKind, type SpokenKind } from "./narrator-policy.js";

/** PCM16 mono at this rate, both ways ("audio/pcm" is 24 kHz). */
export const REALTIME_SAMPLE_RATE = 24_000;

/** Quiet after speech that ends the user's turn (server VAD). */
const TURN_SILENCE_MS = 700;
/**
 * Whether OpenAI cancels the reply being made the moment the user starts talking (server VAD's
 * interrupt_response). Off: its cancel also cut off a send_to_agent call being written (measured 2026-09-26 on
 * gpt-realtime-2.1: the user talking on ~400 ms after their pause ended the call's arguments mid-string, and the
 * request never reached the agent). The client cancels instead (bargeIn), after any call it is writing.
 */
const SERVER_INTERRUPTS_REPLY = false;
/** The user's turn is in and its reply is expected this long; past it (no reply came) the floor is free again. */
const AWAIT_REPLY_MS = 5_000;

export const NARRATOR_INSTRUCTIONS = [
  "You are the voice of BrowserTODO, an assistant that works in the user's Chrome browser.",
  "A separate agent does all the work in the browser. You never do anything yourself: you listen, pass requests on, and tell the user what the agent is doing.",
  "When the user asks for something, call send_to_agent immediately, before saying anything. After it returns, say at most one short acknowledgement.",
  "Pass the request in the user's own words, keeping every detail (names, the text to post, times). A message for the running task (for example 'use the second draft') goes the same way.",
  "If right after that the user says 'cancel', 'never mind' or 'don't send it', call cancel_request: the request already went to the agent, and this stops its task.",
  "You get 'Agent update' messages about what the agent does. Speak only when you have news the user doesn't have: results, questions, blockers, errors. Never describe routine steps (opening, reading, clicking, still working), never repeat the user's request back to them, and never say again what you already said.",
  "When asked to reply to an update: one short sentence for progress; for a result, the actual answer in one to three short sentences. If an update came while the user was talking, include its news in your answer to them. Never read long text, lists, links, code or numbers of steps aloud. Never make up results: say only what the updates say.",
  "When the agent needs the user (a question, a login, a code), ask the user in your own words and pass their answer on with send_to_agent.",
  "If the user asks to stop the task, call stop_task. If they say goodbye or ask you to stop listening, call end_voice.",
  "When an update says an action needs the user's OK, ask them briefly; when they answer yes or no, call answer_approval (never send_to_agent for it).",
  "You and the agent work in one browser tab. A note says when the user looks at another tab; neither of you can see that tab. While they do, if they ask about what they see or 'this page', don't pass it on: say in a few words that you work in the tab the note names, and that they can say 'use this tab' or press Use voice here. When they ask to use this tab or to switch here, call use_this_tab and tell them what it answered.",
  "Be friendly and brief. Speak the user's language.",
].join("\n");

/** The one reply after send_to_agent, when the narrator did not speak before calling it. */
export const ACKNOWLEDGE_INSTRUCTIONS = "Say one very short acknowledgement, a few words such as 'On it.', and nothing else.";

/** The narrator's answer to a send_to_agent that passes on the request just sent again (repeatsRequest): it is not sent twice. */
export const ALREADY_SENT_OUTPUT = "Already sent to the agent: it was not sent again. Its updates will follow.";

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
    name: "answer_approval",
    description: "The user's answer to the action waiting for their OK: allow true for yes (it runs once), false for no (it is not done).",
    parameters: {
      type: "object",
      properties: { allow: { type: "boolean", description: "true: allow it once; false: deny it" } },
      required: ["allow"],
    },
  },
  {
    type: "function",
    name: "use_this_tab",
    description:
      "Move the conversation to the browser tab the user is looking at now (they said 'use this tab', 'switch here'): what they say then goes to that tab's chat. The answer says whether it moved.",
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
  /** The narrator's audio is still playing here (a new line waits for it). */
  playing?(): boolean;
  /** The reply being heard answers noise (an empty transcript of a short sound): its audio must stop. */
  onNoise?(): void;
  /**
   * Timing for the conversation's trace: "voice.connect" (the socket opening, the session ready, the model), one
   * "voice.narrator" per reply (what started it, the time to its first audio and to its end, tokens) and one
   * "voice.user_words" per input transcription. `inputId`: the user's input item it is about (null: none). The relay
   * does not report what a reply was charged (it meters on the server).
   */
  onTrace?(e: TraceDraft, inputId: string | null): void;
  log?(message: string): void;
}

/** When the user's input item ended (server VAD's speech_stopped) and was committed; epoch ms. */
interface InputTiming {
  speechEnd: number | null;
  committed: number;
}

/** Input items whose timing is remembered (their transcription may come after their reply). */
const MAX_INPUT_TIMINGS = 16;

/** A reply being made: what it answers (the user's input, else a request of ours), and its audio. */
interface Reply {
  inputId: string | null;
  /** Its answer to the user's speech, or what we asked it to say. */
  kind: ReplyKind;
  /** Bytes of audio (PCM16) it sent: its spoken length. */
  audioBytes: number;
  /** Epoch ms of what it answers: the end of the user's speech (else its commit), or our request. */
  from: number;
  created: number;
  firstAudio?: number;
  audioDeltas: number;
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
  /** A line waiting for the floor (the most important one asked for; see narrator-policy.ts floor()). */
  private wantReply: SpokenKind | null = null;
  /** What our last response.create asked for (the reply it makes is traced as that). */
  private askedKind: SpokenKind | null = null;
  /** The user is talking (speech_started .. speech_stopped). */
  private userSpeaking = false;
  /** When the user's latest turn was committed (its reply is expected, AWAIT_REPLY_MS at most). */
  private committedAt = -Infinity;
  /** The reply being made was talked over: its further audio is not played. */
  private replyStale = false;
  /** The reply being made is writing a tool call's arguments (its output item started, its arguments are not done). */
  private writingCall = false;
  /** The user talked over the reply while it wrote a tool call: it is cancelled once that call has run. */
  private cancelAfterCall = false;
  /** The reply being made answers noise (cancelled). */
  private noiseReply = false;
  /** News let go while the user's turn was in (their reply covers it): asked again if that turn was noise. */
  private droppedNews: SpokenKind | null = null;
  /** Input items that were noise: their reply is cancelled when it starts. */
  private readonly noise = new Set<string>();
  /** Server VAD's audio_start_ms / audio_end_ms of each input item (how long the user spoke). */
  private readonly vad = new Map<string, { start?: number; end?: number }>();
  /** The user's latest input item that no reply answered yet, and the one the current reply answers. */
  private unansweredInput: string | null = null;
  private replyInput: string | null = null;
  private lastError: RealtimeErrorCode | undefined;
  private narratorText = "";
  private ready = false;
  /** Timing (see RealtimeHandlers.onTrace). */
  private connectAt = 0;
  private openAt = 0;
  private speechEndAt: number | null = null;
  private askedAt: number | null = null;
  private reply: Reply | null = null;
  private readonly inputTimes = new Map<string, InputTiming>();
  /** The request last passed on (send_to_agent), answered to the narrator once `answered` settles. */
  private forwarded: (ForwardedRequest & { answered: Promise<void> }) | null = null;

  constructor(private readonly opts: RealtimeClientOptions) {}

  connect(): void {
    const open = this.opts.open ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as RealtimeSocketLike);
    this.connectAt = Date.now();
    const ws = open(this.opts.url, [REALTIME_PROTOCOL, `${REALTIME_TOKEN_PROTOCOL_PREFIX}${this.opts.token}`]);
    this.socket = ws;
    ws.onopen = () => {
      this.opened = true;
      this.openAt = Date.now();
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

  /** Tells the narrator something (a system message); `speak`: and asks it to say it, when the floor allows (floor()). */
  note(text: string, speak: SpokenKind | null): void {
    if (!this.isOpen()) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    if (speak) this.requestReply(speak);
  }

  /** The narrator's audio finished playing here: a line waiting for the floor may start. */
  playbackIdle(): void {
    this.flush();
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
          turn_detection: { type: "server_vad", silence_duration_ms: TURN_SILENCE_MS, create_response: true, interrupt_response: SERVER_INTERRUPTS_REPLY },
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
   * Asks for a line when the floor allows it (narrator-policy.ts floor()): now, once the reply being made and the
   * audio playing are done, or not at all. An acknowledgement is only wanted when the reply that called
   * send_to_agent said nothing: it is dropped when that reply spoke, and a reply for the notes covers it.
   */
  private requestReply(kind: SpokenKind): void {
    const awaitingReply = this.unansweredInput !== null && Date.now() - this.committedAt < AWAIT_REPLY_MS;
    const decision = floor(kind, { userSpeaking: this.userSpeaking, awaitingReply, replying: this.responding, playing: this.opts.handlers.playing?.() ?? false });
    if (decision === "drop") {
      if ((this.userSpeaking || awaitingReply) && kind !== "milestone" && kind !== "ack") this.droppedNews = moreImportant(this.droppedNews, kind);
      return;
    }
    if (decision === "later") {
      this.wantReply = moreImportant(this.wantReply, kind);
      return;
    }
    if (kind === "ack" && this.spoke) return;
    this.askedAt = Date.now();
    this.askedKind = kind;
    // The acknowledgement only speaks: with tools off for it (tool_choice "none"), it cannot pass the request on again.
    this.send(kind === "ack" ? { type: "response.create", response: { instructions: ACKNOWLEDGE_INSTRUCTIONS, tool_choice: "none" } } : { type: "response.create" });
  }

  /** The line waiting for the floor, if the floor is free now. */
  private flush(): void {
    const kind = this.wantReply;
    if (!kind) return;
    this.wantReply = null;
    this.requestReply(kind);
  }

  private trace(e: TraceDraft, inputId: string | null = null): void {
    try {
      this.opts.handlers.onTrace?.(e, inputId);
    } catch {
      /* a listener must not break the session */
    }
  }

  /** A reply starts: to the user's input `inputId` (timed from the end of their speech), else to our request. */
  private newReply(inputId: string | null): Reply {
    const now = Date.now();
    const input = inputId ? this.inputTimes.get(inputId) : undefined;
    const from = input ? (input.speechEnd ?? input.committed) : (this.askedAt ?? now);
    const kind: ReplyKind = inputId ? "speech" : (this.askedKind ?? "result");
    this.askedAt = null;
    this.askedKind = null;
    return { inputId, kind, from, created: now, audioDeltas: 0, audioBytes: 0 };
  }

  /** The reply is done: what started it, the waits for it to start and for its first audio, and its usage. */
  private traceReply(ev: ServerEvent, inputId: string | null): void {
    const r = this.reply;
    this.reply = null;
    if (!r) return;
    const now = Date.now();
    const response = (ev.response ?? {}) as { status?: unknown; usage?: Record<string, unknown> };
    const u = response.usage ?? {};
    const inDetails = (u.input_token_details ?? {}) as Record<string, unknown>;
    const outDetails = (u.output_token_details ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = inputId ? this.inputTimes.get(inputId) : undefined;
    const firstAudioMs = r.firstAudio === undefined ? null : r.firstAudio - r.from;
    this.trace(
      {
        t: r.from,
        ms: now - r.from,
        cat: "voice",
        name: "voice.narrator",
        data: {
          trigger: inputId ? "speech" : "update",
          kind: r.kind,
          // PCM16 mono: two bytes a sample.
          spokenMs: Math.round((r.audioBytes / 2 / REALTIME_SAMPLE_RATE) * 1000),
          ...(input && input.speechEnd !== null ? { commitMs: input.committed - input.speechEnd } : {}),
          createdMs: r.created - r.from,
          firstAudioMs,
          // What the user waited for: the narrator's first audio (a silent reply: all of it).
          waitMs: firstAudioMs ?? now - r.from,
          audioDeltas: r.audioDeltas,
          status: typeof response.status === "string" ? response.status : null,
          inTokens: n(u.input_tokens),
          outTokens: n(u.output_tokens),
          inAudioTokens: n(inDetails.audio_tokens),
          cachedTokens: n(inDetails.cached_tokens),
          outAudioTokens: n(outDetails.audio_tokens),
        },
      },
      inputId,
    );
  }

  /** The user's words of input `inputId` are transcribed (or could not be): the time since the input was committed. */
  private traceWords(inputId: string, text: string, usage: unknown, failed = false, noise = false): void {
    const input = this.inputTimes.get(inputId);
    const now = Date.now();
    const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
    const data: NonNullable<TraceDraft["data"]> = { chars: text.length, model: REALTIME_INPUT_TRANSCRIPTION_MODEL };
    if (failed) data.failed = true;
    if (noise) data.noise = true;
    for (const [from, to] of [["input_tokens", "inTokens"], ["output_tokens", "outTokens"], ["seconds", "audioSeconds"]] as const) {
      if (typeof u[from] === "number") data[to] = u[from] as number;
    }
    const t = input ? input.committed : now;
    this.trace({ t, ms: now - t, cat: "voice", name: "voice.user_words", data }, inputId);
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
          const now = Date.now();
          const model = (ev.session as { model?: unknown } | undefined)?.model;
          this.trace({
            t: this.connectAt,
            ms: now - this.connectAt,
            cat: "voice",
            name: "voice.connect",
            data: { openMs: this.openAt ? this.openAt - this.connectAt : null, readyMs: now - (this.openAt || this.connectAt), model: typeof model === "string" ? model : null, waitMs: now - this.connectAt },
          });
          h.onReady?.();
        }
        break;
      case "response.created": {
        this.responding = true;
        this.spoke = false;
        this.replyStale = false;
        this.writingCall = false;
        this.cancelAfterCall = false;
        this.narratorText = "";
        this.replyInput = this.unansweredInput;
        this.unansweredInput = null;
        this.reply = this.newReply(this.replyInput);
        this.noiseReply = false;
        // The reply answers noise (its empty transcript came first): it is not said.
        if (this.replyInput && this.noise.has(this.replyInput)) this.dropNoiseReply();
        break;
      }
      case "response.done": {
        this.responding = false;
        this.writingCall = false;
        this.cancelAfterCall = false;
        const answered = this.replyInput;
        this.replyInput = null;
        this.traceReply(ev, answered);
        h.onReplyDone?.();
        if (answered) h.onTurnDone?.(answered);
        // The user's turn was answered, with the news let go meanwhile in it (not when it was noise).
        if (answered && !this.noiseReply) this.droppedNews = null;
        this.flush();
        break;
      }
      case "response.output_audio.delta":
        // A reply the user talked over (or noise's): the rest of it is not heard.
        if (this.replyStale) break;
        this.spoke = true;
        if (this.reply) {
          this.reply.firstAudio ??= Date.now();
          this.reply.audioDeltas++;
          this.reply.audioBytes += base64Bytes(str("delta"));
        }
        h.onAudio?.(str("delta"), str("item_id"));
        break;
      case "input_audio_buffer.speech_stopped":
        this.speechEndAt = Date.now();
        this.userSpeaking = false;
        this.vadTime(str("item_id"), "end", ev.audio_end_ms);
        break;
      case "input_audio_buffer.committed":
        // The user's turn is in: the reply the server makes next answers it.
        if (str("item_id")) {
          this.unansweredInput = str("item_id");
          this.committedAt = Date.now();
          this.userSpeaking = false;
          this.inputTimes.set(str("item_id"), { speechEnd: this.speechEndAt, committed: Date.now() });
          if (this.inputTimes.size > MAX_INPUT_TIMINGS) this.inputTimes.delete(this.inputTimes.keys().next().value!);
          this.speechEndAt = null;
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (str("item_id")) {
          const id = str("item_id");
          const text = str("transcript").trim();
          if (isNoise(text, this.speechMs(id, ev.usage))) {
            // Noise (a cough, a door): nothing is said for it and it is no message; the trace keeps it, marked.
            this.traceWords(id, text, ev.usage, false, true);
            this.onNoiseInput(id);
            break;
          }
          this.traceWords(id, text, ev.usage);
          h.onUserWords?.(id, text);
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.log("realtime: the user's words could not be transcribed");
        if (str("item_id")) {
          this.traceWords(str("item_id"), "", undefined, true);
          h.onUserWords?.(str("item_id"), "");
        }
        break;
      case "response.output_audio_transcript.delta":
        this.narratorText += str("delta");
        h.onNarratorText?.(this.narratorText);
        break;
      case "input_audio_buffer.speech_started":
        // The user's turn gets its own reply; ours would talk over it, and what waited for older turns is let go.
        this.wantReply = null;
        this.userSpeaking = true;
        if (this.responding) this.bargeIn();
        this.vadTime(str("item_id"), "start", ev.audio_start_ms);
        h.onUserSpeech?.();
        break;
      case "response.output_item.added":
        if ((ev.item as { type?: unknown } | undefined)?.type === "function_call") this.writingCall = true;
        break;
      case "response.function_call_arguments.done":
        this.writingCall = false;
        void this.runTool(str("call_id"), str("name"), str("arguments"), this.replyInput, this.reply?.kind ?? null);
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

  /** replyKind: what the reply making the call is (null: not known). */
  private async runTool(callId: string, name: string, rawArgs: string, inputId: string | null, replyKind: ReplyKind | null): Promise<void> {
    let args: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = null;
    }
    const request = name === "send_to_agent" && typeof args?.text === "string" ? args.text.trim() : "";
    const earlier = this.forwarded;
    if (request && earlier && repeatsRequest(request, inputId, earlier)) {
      // The same request again (one turn, or a reply of ours): not sent twice, nothing more said; answered after the first.
      await earlier.answered;
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: ALREADY_SENT_OUTPUT } });
      return;
    }
    let answered = () => {};
    // Held before the first await: a repeat in the same reply arrives while this one runs.
    if (request) this.forwarded = { inputId, text: request, answered: new Promise<void>((r) => (answered = r)) };
    let output: string;
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
    answered();
    // Talked over while it wrote the call: the call ran, the rest of the reply is not wanted (the user has the floor).
    if (this.cancelAfterCall && this.responding && !this.writingCall) {
      this.cancelAfterCall = false;
      this.send({ type: "response.cancel" });
    }
    // Tool first, then at most one short acknowledgement (none when the narrator already spoke in that reply, and
    // never for a call the acknowledgement itself made: that would acknowledge the acknowledgement).
    if (name !== "send_to_agent") this.requestReply("result");
    else if (replyKind !== "ack") this.requestReply("ack");
  }

  /**
   * The user started talking while a reply is being made: its further audio is not played, and the reply is
   * cancelled, but never while it writes a tool call (a send_to_agent cut off is a request lost): then right after
   * that call has run.
   */
  private bargeIn(): void {
    this.replyStale = true;
    if (this.writingCall) this.cancelAfterCall = true;
    else this.send({ type: "response.cancel" });
  }

  private vadTime(itemId: string, at: "start" | "end", ms: unknown): void {
    if (!itemId || typeof ms !== "number") return;
    const v = this.vad.get(itemId) ?? {};
    v[at] = ms;
    this.vad.set(itemId, v);
    if (this.vad.size > MAX_INPUT_TIMINGS) this.vad.delete(this.vad.keys().next().value!);
  }

  /** How long the user spoke in input item `itemId` (server VAD, else the transcription's billed seconds; null: unknown). */
  private speechMs(itemId: string, usage: unknown): number | null {
    const v = this.vad.get(itemId);
    if (v?.start !== undefined && v.end !== undefined) return v.end - v.start;
    const seconds = (usage as { seconds?: unknown } | undefined)?.seconds;
    return typeof seconds === "number" ? seconds * 1000 : null;
  }

  /** Input `itemId` was noise: its reply (being made, or when it starts) is cancelled and not heard. */
  private onNoiseInput(itemId: string): void {
    if (this.responding && this.replyInput === itemId) this.dropNoiseReply();
    else if (this.unansweredInput === itemId) this.noise.add(itemId);
    // News let go for that turn is said after all (no reply of it will carry it).
    const news = this.droppedNews;
    this.droppedNews = null;
    if (news) this.requestReply(news);
  }

  private dropNoiseReply(): void {
    this.replyStale = true;
    this.noiseReply = true;
    this.send({ type: "response.cancel" });
    if (this.replyInput) this.noise.delete(this.replyInput);
    this.opts.handlers.onNoise?.();
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

/** The bytes a base64 string decodes to. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
