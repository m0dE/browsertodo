/**
 * The input's text while dictating: whatever the user had typed, then the
 * voice text, which re-transcription keeps rewriting. The user may type or
 * edit meanwhile; their edit is kept as it is and the voice text continues
 * after it (the words it already showed are not repeated). No DOM.
 */

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** `voice` without its first `n` words. */
function dropWords(voice: string, n: number): string {
  return n ? words(voice).slice(n).join(" ") : voice.trim();
}

function append(base: string, text: string): string {
  if (!text) return base;
  if (!base) return text;
  return /\s$/.test(base) ? base + text : `${base} ${text}`;
}

export class VoiceDraft {
  /** The user's part: the text before dictation, and any edit made since. */
  private base: string;
  /** Voice words already in `base` (shown before the user's last edit). */
  private skip = 0;
  /** The voice text of the last update, and the input value it produced. */
  private lastVoice = "";
  private lastValue: string;

  constructor(initial: string) {
    this.base = initial;
    this.lastValue = initial;
  }

  /** The input value for the new voice text, given what the input holds now. */
  update(current: string, voice: string): string {
    if (current !== this.lastValue) {
      // The user typed or edited: their text stays; the voice text goes on after it.
      this.base = current;
      this.skip = words(this.lastVoice).length;
    }
    this.lastVoice = voice;
    this.lastValue = append(this.base, dropWords(voice, this.skip));
    return this.lastValue;
  }

  /** The input value without the voice text (Esc): what the user had, including their edits. */
  discard(current: string): string {
    return current === this.lastValue ? this.base : current;
  }
}
