/**
 * Scheduled tasks run on their own ("Do what the task says without asking"),
 * except for a consequential action the task's written instructions do not
 * ask for: liking posts when the task only says to post, sending an email
 * when it only says to read the inbox. The rule: the instructions must name
 * the action's family of verbs ("post", "tweet", "reply" for a Post click),
 * and must not forbid it ("don't post"). Coarse by design: a family named
 * anywhere in the task counts; see the measured limits in
 * test/approval/consequence.test.ts. Pure.
 */
import type { ConsequenceKind } from "@browsertodo/shared";
import { hasPhrase, labelOf, words, type GateAction } from "./consequence.js";

/** Word starts in the instructions that ask for each family of actions ("post" also matches "posts", "posting"). */
export const TASK_FAMILIES = {
  post: ["post", "tweet", "publish", "share", "thread", "reply", "replies", "respond", "comment", "quote", "announce", "caption"],
  like: ["like", "heart", "favorite", "favourite", "fav"],
  repost: ["repost", "retweet", "share", "boost"],
  follow: ["follow", "unfollow"],
  moderate: ["block", "report", "mute", "spam"],
  send: ["send", "email", "e mail", "mail", "message", "reply", "replies", "respond", "answer", "forward", "invite", "dm", "write to", "text", "tell"],
  pay: ["pay", "buy", "purchase", "order", "renew", "subscribe", "checkout", "check out", "donate", "transfer", "book", "top up", "upgrade", "tip"],
  delete: ["delete", "remove", "clean", "clear", "trash", "purge", "unsubscribe", "empty", "discard", "get rid"],
  submit: ["submit", "sign", "apply", "register", "subscribe", "book", "reserve", "rsvp", "confirm", "accept", "agree", "vote", "fill", "enrol", "enroll", "join", "create", "complete"],
  account: ["password", "security", "setting", "account", "two factor", "2fa", "unsubscribe", "profile", "email address"],
  upload: ["upload", "photo", "image", "picture", "video", "file", "attach", "media", "pdf", "document", "screenshot", "gif"],
} as const satisfies Record<string, readonly string[]>;
export type TaskFamily = keyof typeof TASK_FAMILIES;

/** Words just before a verb that forbid it: "don't post", "without posting", "never reply". */
const NEGATIONS = ["not", "dont", "don t", "never", "without", "no", "nor", "avoid"];
/** How many words before a verb a negation still applies to ("do not ever post"). */
const NEGATION_REACH = 3;

/** The family an action belongs to: a publish click by its own word (Like, Follow, Repost), otherwise by its kind. */
export function familyOf(kind: ConsequenceKind, action: GateAction): TaskFamily {
  if (kind !== "publish") return kind === "upload" ? "upload" : kind;
  const label = action.element ? labelOf(action.element) : "";
  if (hasPhrase(label, ["like", "unlike", "upvote", "downvote"])) return "like";
  if (hasPhrase(label, ["repost", "retweet", "retweet confirm"])) return "repost";
  if (hasPhrase(label, ["follow", "unfollow"])) return "follow";
  if (hasPhrase(label, ["block", "report", "mute"])) return "moderate";
  return "post";
}

/** Where the family's words occur in the instructions: asked (not negated) and forbidden (negated). */
function mentions(instructions: string, family: TaskFamily): { asked: boolean; forbidden: boolean } {
  const tokens = words(instructions).split(" ");
  let asked = false;
  let forbidden = false;
  for (let i = 0; i < tokens.length; i++) {
    const rest = tokens.slice(i).join(" ");
    if (!TASK_FAMILIES[family].some((w) => rest === w || rest.startsWith(w))) continue;
    // "e mail" / "top up": the family word may span tokens; only its first token is checked for a negation.
    const before = tokens.slice(Math.max(0, i - NEGATION_REACH), i).join(" ");
    if (NEGATIONS.some((n) => ` ${before} `.includes(` ${n} `))) forbidden = true;
    else asked = true;
  }
  return { asked, forbidden };
}

/** Whether a scheduled task's instructions ask for this consequential action (and do not forbid it). */
export function withinInstructions(kind: ConsequenceKind, action: GateAction, instructions: string): boolean {
  const { asked, forbidden } = mentions(instructions, familyOf(kind, action));
  return asked && !forbidden;
}
