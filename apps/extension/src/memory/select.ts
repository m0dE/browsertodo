/**
 * Which memory the agent is given at the start of a turn, and what recall
 * finds. Deterministic and cheap (no model call, no index): this task's
 * records whose key the turn names (the request, the user's tab), within
 * their own MEMORY_RECORD_TOKEN_BUDGET, then the task's run notes, then
 * entries for the sites the turn involves (the user's tab, sites named in the
 * request), then entries sharing words with the request, then the user's
 * preferences, until MEMORY_TOKEN_BUDGET is spent. Pure.
 */
import {
  isMemoryRecord,
  keyTokens,
  MAX_INJECTED_TASK_NOTES,
  MAX_RECALL_RESULTS,
  MEMORY_CHARS_PER_TOKEN,
  MEMORY_KIND_TEXT,
  MEMORY_RECORD_TOKEN_BUDGET,
  MEMORY_TOKEN_BUDGET,
  memoryDomain,
  memoryLine,
  memoryRecordKey,
  onDomain,
  type MemoryEntry,
  type MemoryKind,
} from "@browsertodo/shared";

export interface MemoryContext {
  /** The repeating task the run belongs to: its run notes come first. */
  taskKey?: string | null;
  /** Sites the turn involves (hosts): the user's tab, and those named in the request (hostsIn). */
  hosts: readonly string[];
  /** The request (instructions or message), for matching words. */
  text: string;
  /** The user's tab (its address and title): the task's records whose key it names are given too. */
  pageText?: string;
}

export interface MemorySelection {
  /** In the order the agent reads them. */
  entries: MemoryEntry[];
  /** The block for the prompt; "" when nothing was picked. */
  text: string;
  /** Its estimated cost. */
  tokens: number;
}

/** The heading of a task's records in the block (records are task history filed by key). */
export const RECORDS_LABEL = "Task records (by key)";

/** The block's first line: what these are, and that they may be out of date. */
export const MEMORY_HEADER =
  "Memory from earlier chats and runs (ids in brackets). Use it before exploring; it may be out of date: when an entry proves wrong, remember the corrected fact with the same kind and subject, or forget it by id.";

/** Words too common to tell entries apart. */
const STOPWORDS = new Set(
  "the and for with that this from what when where which who whom your you are was were will would can could should have has had not but all any its into out our about then than them they there their these those some just also only very more most such each other over under after before again once here how why get got make made use used new one two per via off yes please thanks check open go do does did done let may might must shall".split(
    " ",
  ),
);

/** Estimated tokens of a prompt text. */
export const tokensOf = (text: string): number => Math.ceil(text.length / MEMORY_CHARS_PER_TOKEN);

/** Hosts named in a text: URLs and bare domains ("x.com", "mail.google.com/mail/u/2"). */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  // Full addresses first: they name hosts without a dot too (http://localhost:4777/...).
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)"'<>]+/gi)) {
    const host = memoryDomain(m[0]);
    if (host) out.add(host);
  }
  for (const m of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\/:?#\s)"',]|$)/gi)) {
    // An email address names a mailbox, not a site.
    if (m.index !== undefined && text[m.index - 1] === "@") continue;
    const host = memoryDomain(m[1]!);
    if (host) out.add(host);
  }
  return [...out];
}

/** The words of a text that can match an entry: lower case, 3+ characters, not common words; emails and @handles whole. */
export function keywordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[@\p{L}\p{N}][\p{L}\p{N}@._-]*/gu) ?? []) {
    const word = raw.replace(/[._-]+$/, "");
    if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word);
    // "admin@runhq.io" also matches "runhq", "mail.google.com" also "google" (not "com": every site has one).
    const parts = word.split(/[@._-]+/);
    if (word.includes(".")) parts.pop();
    for (const part of parts) if (part.length >= 3 && !STOPWORDS.has(part)) out.add(part);
  }
  return out;
}

/** How many of `words` the entry has in its subject, site or key (strong) and in its text and notes (weak). */
function matches(e: MemoryEntry, words: ReadonlySet<string>): { strong: number; weak: number } {
  if (!words.size) return { strong: 0, weak: 0 };
  const named = keywordsOf(`${e.subject} ${e.domain ?? ""} ${e.key ?? ""}`);
  let strong = 0;
  let weak = 0;
  for (const w of named) if (words.has(w)) strong++;
  for (const w of keywordsOf([e.text, ...(e.notes ?? []).map((n) => n.text)].join(" "))) if (words.has(w) && !named.has(w)) weak++;
  return { strong, weak };
}

/**
 * How well the entry matches `words` (0: not at all). Its subject and site count double. A site's entry matches
 * only by its subject or site: a playbook for x.com is not for "post a tip on LinkedIn" because its text says "Post".
 */
function score(e: MemoryEntry, words: ReadonlySet<string>): number {
  const m = matches(e, words);
  if (e.scope === "domain" && !m.strong) return 0;
  return 2 * m.strong + m.weak;
}

const newestUse = (a: MemoryEntry, b: MemoryEntry) => (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt);

/**
 * The task's records whose key `text` names, in the order the text names them: the key's words (keyTokens) appear
 * together, whole and in order ("48213" in "no. #48213", not in "148213"; "ada@x.io" whole, not "x.io").
 */
export function recordsNamedIn(records: readonly MemoryEntry[], text: string): MemoryEntry[] {
  const words = keyTokens(text);
  if (!words.length) return [];
  const at = new Map<string, number[]>();
  words.forEach((w, i) => {
    const of = at.get(w);
    if (of) of.push(i);
    else at.set(w, [i]);
  });
  const found: { e: MemoryEntry; i: number }[] = [];
  for (const e of records) {
    if (!e.key) continue;
    const key = e.key.split(" ");
    const i = at.get(key[0]!)?.find((start) => key.every((k, j) => words[start + j] === k));
    if (i !== undefined) found.push({ e, i });
  }
  return found.sort((a, b) => a.i - b.i).map((x) => x.e);
}

/** Entries that may be given in this context: not turned off, and not another task's notes or records. */
function candidates(entries: readonly MemoryEntry[], ctx: MemoryContext, kindsOff: ReadonlySet<MemoryKind>): MemoryEntry[] {
  return entries.filter((e) => !kindsOff.has(e.kind) && (e.scope !== "task" || (!!ctx.taskKey && e.taskKey === ctx.taskKey)));
}

/** The entries to give the agent, most relevant first, within `budget` tokens, and the block that says them. */
export function selectMemory(
  entries: readonly MemoryEntry[],
  ctx: MemoryContext,
  opts: { kindsOff?: readonly MemoryKind[]; budget?: number } = {},
): MemorySelection {
  const pool = candidates(entries, ctx, new Set(opts.kindsOff ?? []));
  const words = keywordsOf(ctx.text);
  const hosts = ctx.hosts.map((h) => memoryDomain(h)).filter((h): h is string => !!h);

  const named = recordsNamedIn(pool.filter(isMemoryRecord), `${ctx.text}\n${ctx.pageText ?? ""}`);
  const notes = pool
    .filter((e) => e.scope === "task" && !isMemoryRecord(e))
    .sort((a, b) => b.learnedAt.localeCompare(a.learnedAt))
    .slice(0, MAX_INJECTED_TASK_NOTES);
  const rest = pool.filter((e) => e.scope !== "task");
  const onSite = rest.filter((e) => !!e.domain && hosts.some((h) => onDomain(h, e.domain!))).sort(newestUse);
  const scored = rest.map((e) => ({ e, s: score(e, words) })).filter((x) => x.s > 0);
  const matched = scored.sort((a, b) => b.s - a.s || newestUse(a.e, b.e)).map((x) => x.e);
  // A site's playbook is only for that site; other kinds without a site apply anywhere.
  const preferences = rest.filter((e) => e.kind === "preference" && !e.domain).sort(newestUse);

  const budget = opts.budget ?? MEMORY_TOKEN_BUDGET;
  let spent = tokensOf(MEMORY_HEADER);
  let spentOnRecords = 0;
  const picked = new Map<string, MemoryEntry>();
  const groups = new Set<string>();
  for (const e of [...named, ...notes, ...onSite, ...matched, ...preferences]) {
    if (picked.has(e.id)) continue;
    const group = groupOf(e);
    const cost = tokensOf(memoryLine(e)) + 1 + (groups.has(group) ? 0 : tokensOf(group) + 1);
    if (spent + cost > budget) continue;
    if (isMemoryRecord(e) && spentOnRecords + cost > MEMORY_RECORD_TOKEN_BUDGET) continue;
    spent += cost;
    if (isMemoryRecord(e)) spentOnRecords += cost;
    picked.set(e.id, e);
    groups.add(group);
  }
  if (!picked.size) return { entries: [], text: "", tokens: 0 };
  const chosen = [...picked.values()];
  const text = memoryBlock(chosen);
  return { entries: chosen, text, tokens: tokensOf(text) };
}

/** The heading an entry goes under in the block: its kind's label, or RECORDS_LABEL for a record. */
const groupOf = (e: MemoryEntry): string => (isMemoryRecord(e) ? RECORDS_LABEL : MEMORY_KIND_TEXT[e.kind].label);

/** The block the agent reads: the header, then the entries under their heading (task records, task history, playbooks, accounts, people, preferences). */
export function memoryBlock(entries: readonly MemoryEntry[]): string {
  const lines = [MEMORY_HEADER];
  const order = [RECORDS_LABEL, ...(Object.keys(MEMORY_KIND_TEXT) as MemoryKind[]).map((k) => MEMORY_KIND_TEXT[k].label)];
  for (const group of order) {
    const of = entries.filter((e) => groupOf(e) === group);
    if (of.length) lines.push(`${group}:`, ...of.map((e) => `- ${memoryLine(e)}`));
  }
  return lines.join("\n");
}

/** The record `taskKey` keeps for `key` (as the agent wrote it: memoryRecordKey normalizes it), or null. */
export function recordFor(entries: readonly MemoryEntry[], taskKey: string, key: string): MemoryEntry | null {
  const k = memoryRecordKey(key);
  return (k && entries.find((e) => e.taskKey === taskKey && e.key === k)) || null;
}

/**
 * recall: the entries that best match `query` (words, or a site), whichever task or site they belong to; of records,
 * only those of `taskKey` (the turn's task), the one whose key is the query itself first.
 */
export function recallMemory(
  entries: readonly MemoryEntry[],
  query: string,
  opts: { kindsOff?: readonly MemoryKind[]; max?: number; taskKey?: string | null } = {},
): MemoryEntry[] {
  const off = new Set(opts.kindsOff ?? []);
  const words = keywordsOf(query);
  const hosts = hostsIn(query);
  const exact = memoryRecordKey(query);
  const siteScore = (e: MemoryEntry) => (e.domain && hosts.some((h) => onDomain(h, e.domain!) || onDomain(e.domain!, h)) ? 3 : 0);
  return entries
    .filter((e) => !off.has(e.kind) && (!isMemoryRecord(e) || (!!opts.taskKey && e.taskKey === opts.taskKey)))
    .map((e) => ({ e, s: (isMemoryRecord(e) && e.key === exact ? 1000 : 0) + score(e, words) + siteScore(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || newestUse(a.e, b.e))
    .slice(0, opts.max ?? MAX_RECALL_RESULTS)
    .map((x) => x.e);
}
