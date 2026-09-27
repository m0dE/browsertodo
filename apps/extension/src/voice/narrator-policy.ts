/**
 * When the Realtime narrator may speak: the one policy for what the chat's
 * events may make it say (narrationOf) and when a line may start (floor).
 *
 * It speaks only with news the user does not have: the agent's result, its
 * question, a problem, and now and then a meaningful change (another site, an
 * account switch, a sign-in) on a long task. It never speaks for what merely
 * echoes the user's own request (their message, their transcribed words, the
 * agent restating the request, routine steps such as reading or clicking), and
 * one speaker talks at a time: the user first, then the narrator's reply to
 * them, then any news. Pure.
 */
import type { AgentEvent } from "@browsertodo/shared";
import { sharedWordShare } from "../text.js";
import { milestoneOf, siteName } from "./milestones.js";
import { endLine, errorLine } from "./spoken-line.js";

/** What a narrator reply is: its answer to the user's speech, or one it was asked for (see SpokenKind). */
export type ReplyKind = "speech" | SpokenKind;
/** A line the narrator is asked to say: the one acknowledgement of a request, a milestone, the result, the agent's question, a problem. */
export type SpokenKind = "ack" | "milestone" | "result" | "question" | "error";

/** A milestone is said at most this often, and never this soon after the narrator last spoke (the acknowledgement included). */
export const NARRATOR_MILESTONE_GAP_MS = 12_000;
/** Milestones said at most per request. */
export const MAX_MILESTONES_PER_REQUEST = 2;
/** A request sharing at least this share of its words with the one just sent is that request again (sent once). */
export const REPEATED_REQUEST_OVERLAP_MIN = 0.6;
/** An empty transcript of at most this much speech is noise (a cough, a door): no reply, no message. */
export const NOISE_MAX_SPEECH_MS = 2_500;

/** What the narrator has said for the request being worked on. */
export interface NarrationMemory {
  /** When it last spoke or was asked to (epoch ms). */
  lastSpokenAt: number;
  milestones: string[];
  /** The sites the request's task has been on (the first one is where it was asked to go: not news). */
  sites: string[];
  /** The last result or question said (never said twice). */
  lastLine: string | null;
}

export const freshMemory = (now = -Infinity): NarrationMemory => ({ lastSpokenAt: now, milestones: [], sites: [], lastLine: null });

/** A step is news only when it changes where the agent is or who it is: another site, an account, a sign-in. */
function meaningfulStep(ev: Extract<AgentEvent, { type: "tool_call" }>, memory: NarrationMemory): string | null {
  const line = milestoneOf(ev);
  if (!line) return null;
  if (/^Switching to |^Switching accounts|^Signing in/.test(line)) return memory.milestones.includes(line) ? null : line;
  if (!line.startsWith("Opening ")) return null; // reading, clicking, typing, scrolling, looking: routine
  const args = (ev.args ?? {}) as { url?: unknown; urls?: unknown };
  const site = siteName(args.url) ?? (Array.isArray(args.urls) && args.urls.length === 1 ? siteName(args.urls[0]) : null);
  if (!site || memory.sites.includes(site)) return null;
  const first = memory.sites.length === 0;
  memory.sites.push(site);
  // The first site is the one the user asked for: obvious.
  return first ? null : line;
}

/** Said once: false when the very same line was said last (dedupe by meaning). */
function news(line: string, memory: NarrationMemory, now: number): boolean {
  const key = line.trim().toLowerCase();
  if (memory.lastLine === key) return false;
  memory.lastLine = key;
  memory.lastSpokenAt = now;
  return true;
}

/**
 * What an event of the chat may make the narrator say, or null: nothing to say (it may still be passed on as a note
 * for context). Speaks for: the result (the agent's spoken line), its question, a problem, and a meaningful step now
 * and then (NARRATOR_MILESTONE_GAP_MS apart, MAX_MILESTONES_PER_REQUEST). Never for the user's message or words, the
 * agent's own text (it restates the request), routine steps or status lines. `line`: the words it is about.
 */
export function narrationOf(ev: AgentEvent, memory: NarrationMemory, now: number): { kind: SpokenKind; line: string } | null {
  switch (ev.type) {
    case "task_end": {
      const line = endLine(ev);
      // A reason without a spoken line is the agent's question as it wrote it.
      const kind = ev.outcome === "paused" && !ev.spoken && ev.reason ? "question" : "result";
      return news(line, memory, now) ? { kind, line } : null;
    }
    case "error": {
      const line = errorLine(ev.text);
      return news(line, memory, now) ? { kind: "error", line } : null;
    }
    case "tool_call": {
      const line = meaningfulStep(ev, memory);
      if (!line) return null;
      if (memory.milestones.length >= MAX_MILESTONES_PER_REQUEST || now - memory.lastSpokenAt < NARRATOR_MILESTONE_GAP_MS) return null;
      memory.milestones.push(line);
      memory.lastSpokenAt = now;
      return { kind: "milestone", line };
    }
    default:
      return null;
  }
}

/** Who has the floor when the narrator is asked to say something. */
export interface Floor {
  /** The user is talking (server VAD: speech started, their turn not in yet). */
  userSpeaking: boolean;
  /** Their turn is in but the reply to it has not started. */
  awaitingReply: boolean;
  /** A reply is being made. */
  replying: boolean;
  /** The narrator's audio is still playing here. */
  playing: boolean;
}

/**
 * Whether a line of `kind` starts now, waits for the floor ("later"), or is let go ("drop").
 * - The user speaking, or their reply about to start: dropped. Their reply is made with every note so far (a result
 *   included), so it answers once, with the news in it.
 * - A reply being made or audio playing: a milestone is let go (old news by then); the acknowledgement, a result, a
 *   question and a problem wait their turn.
 */
export function floor(kind: SpokenKind, f: Floor): "now" | "later" | "drop" {
  if (f.userSpeaking || f.awaitingReply) return "drop";
  if (f.replying || f.playing) return kind === "milestone" ? "drop" : "later";
  return "now";
}

/** Replies waiting for the floor: the most important one is made (it covers the others, whose notes it sees). */
const RANK: Record<SpokenKind, number> = { milestone: 0, ack: 1, result: 2, error: 3, question: 4 };
export const moreImportant = (a: SpokenKind | null, b: SpokenKind): SpokenKind => (a && RANK[a] >= RANK[b] ? a : b);

/** An empty transcript is noise when the speech was short (or its length is unknown). */
export function isNoise(transcript: string, speechMs: number | null): boolean {
  return !transcript.trim() && (speechMs === null || speechMs <= NOISE_MAX_SPEECH_MS);
}

/** The request the narrator last passed on (send_to_agent), and the user's turn it answered (null: a reply we asked for). */
export interface ForwardedRequest {
  inputId: string | null;
  text: string;
}

/**
 * A send_to_agent that passes on `last` again: the same or nearly the same words, in the same user turn or in a reply
 * we asked for (no new words of the user's came with it). One request goes to the agent once; a new turn may ask
 * again.
 */
export function repeatsRequest(text: string, inputId: string | null, last: ForwardedRequest | null): boolean {
  if (!last || (inputId !== null && inputId !== last.inputId)) return false;
  return sharedWordShare(text, last.text) >= REPEATED_REQUEST_OVERLAP_MIN;
}

/**
 * What a user's turn is, by its words: small talk the narrator may answer by itself (a greeting, "can you hear me",
 * thanks, a filler, what the agent is doing now), or a request, which must go through one of its tools. Anything about
 * what the agent did, saw, knows or remembers, a follow-up or correction ("no, I meant yesterday"), a question for the
 * browser, a command: the narrator's own notes are not the truth about those (it once told a user "yesterday, I told
 * you..." of something said minutes earlier). Unknown words count as a request: the agent answering a greeting costs
 * a turn, the narrator answering a request makes things up.
 */
export type SpeechTurn = "small_talk" | "request";

/** Whole clauses that are small talk (lowercase, no punctuation). English and Korean, the languages voice is used in. */
const SMALL_TALK = new RegExp(
  "^(?:" +
    [
      "(?:hi|hello|hey|yo)(?: there)?(?: (?:jev|browsertodo))?",
      "good (?:morning|afternoon|evening)|morning",
      "(?:can|could|do) you (?:still )?hear me(?: now| okay| ok)?|you there|are you (?:still )?(?:there|listening|with me)",
      "testing(?: testing)*(?: one two(?: three)?)?|is (?:this|it) (?:working|on)",
      "(?:thanks|thank you)(?: (?:so|very) much| a lot)?|(?:ok|okay|cool|great|nice|perfect|awesome|alright|all right|good|sure|fine)(?: thanks| thank you)?|got it|sounds good",
      "um+|uh+|hmm+|wait|hold on|one sec(?:ond)?|just a sec(?:ond)?|let me think",
      "what are you (?:doing|working on)(?: (?:right )?now)?|how(?:'s| is) it going",
      "안녕(?:하세요)?|여보세요|(?:제 말 )?들려(?:요)?|들리(?:세요|나요|니)|고마워(?:요)?|감사합니다|알았어(?:요)?|알겠(?:어|어요|습니다)|오케이|좋아(?:요)?|잠깐(?:만)?(?:요)?",
    ].join("|") +
    ")$",
  "u",
);

export function speechTurnOf(words: string): SpeechTurn {
  const clauses = words
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[.,!?;:…]+/u)
    .map((c) => c.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return clauses.every((c) => SMALL_TALK.test(c)) ? "small_talk" : "request";
}
