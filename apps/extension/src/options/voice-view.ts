/**
 * Pure logic of Settings > AI > Voice: the two hands-free engines with what
 * a minute of each costs in usage credit (the server's numbers), and whether
 * the plan includes voice. voice-section.ts renders it.
 */
import { plansWithText, type VoiceEngine, type VoiceEngineId } from "@browsertodo/shared";
import { voiceAllowed } from "../account/types.js";
import type { AccountView } from "../ui-protocol.js";
import { costPerMinuteText, ENGINE_NAMES } from "../voice/engine-choice.js";

export interface VoiceOption {
  id: VoiceEngineId;
  label: string;
  /** What it is, in one line. */
  detail: string;
  /** What a minute costs (or why that is not shown). */
  cost: string;
  /** The server's assumption behind the cost, for the tooltip. */
  title: string;
}

export interface VoiceView {
  options: VoiceOption[];
  selected: VoiceEngineId;
  /** Without a plan that includes voice: which plans do. */
  note: string | null;
}

const DETAILS: Record<VoiceEngineId, string> = {
  realtime: "A spoken conversation: it listens, talks back in its own words, and hands your requests to the agent.",
  standard: "Your words become text with Whisper; short summaries are read aloud by your browser.",
};

export function voiceView(input: { engines: readonly VoiceEngine[] | null | "loading"; selected: VoiceEngineId; account: AccountView | null | undefined }): VoiceView {
  const { engines } = input;
  const options = (["realtime", "standard"] as const).map((id): VoiceOption => {
    const e = engines === "loading" || !engines ? undefined : engines.find((x) => x.id === id);
    let cost: string;
    if (engines === "loading") cost = "Loading the price…";
    else if (!e) cost = "The price couldn't be loaded right now.";
    else if (!e.available) cost = "Not available on this server right now: Standard is used instead.";
    else cost = costPerMinuteText(e.approxCentsPerMinute);
    return { id, label: ENGINE_NAMES[id], detail: DETAILS[id], cost, title: e?.assumption ?? "" };
  });
  const allowed = !!input.account?.signedIn && voiceAllowed(input.account.plan);
  return { options, selected: input.selected, note: allowed ? null : `Voice needs ${plansWithText("voice")}` };
}
