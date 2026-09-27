/**
 * The user's own words for each Realtime turn, paired with what the narrator
 * sent the agent in that turn. Both are keyed by the turn's input item: the
 * transcription of the user's audio and the narrator's send_to_agent arrive
 * in either order, and a turn with no request is only known to have none once
 * its reply is done. A settled turn stays known (as done) for the rest of the
 * session, so a late event of it does not start it again: one entry per turn.
 */

interface Turn {
  words?: string;
  sent?: string;
  replied?: boolean;
}

export class RealtimeTurns {
  private readonly turns = new Map<string, Turn | "done">();

  /** `words`: the user's words (never empty); `sent`: the narrator's request for them, or null. */
  constructor(private readonly onWords: (words: string, sent: string | null) => void) {}

  /** The narrator sent `text` to the agent while answering input item `inputId` (null: not answering one). */
  sent(inputId: string | null, text: string): void {
    if (inputId === null) return;
    const t = this.turn(inputId);
    if (!t) return;
    t.sent = t.sent ? `${t.sent} ${text}` : text;
    this.settle(inputId, t);
  }

  /** The user's words of input item `inputId` ("" when they could not be transcribed). */
  words(inputId: string, text: string): void {
    const t = this.turn(inputId);
    if (!t) return;
    t.words = text;
    this.settle(inputId, t);
  }

  /** The reply to input item `inputId` is done: no request comes for it any more. */
  replied(inputId: string): void {
    const t = this.turn(inputId);
    if (!t) return;
    t.replied = true;
    this.settle(inputId, t);
  }

  /** The turn still being put together (null: it is settled). */
  private turn(inputId: string): Turn | null {
    const t = this.turns.get(inputId);
    if (t === "done") return null;
    if (t) return t;
    const fresh: Turn = {};
    this.turns.set(inputId, fresh);
    return fresh;
  }

  private settle(inputId: string, t: Turn): void {
    if (t.words === undefined || (t.sent === undefined && !t.replied)) return;
    this.turns.set(inputId, "done");
    if (t.words) this.onWords(t.words, t.sent ?? null);
  }
}
