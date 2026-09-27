/**
 * The background memory writer: once a conversation is over for now, a small model (memory-writer.ts in shared,
 * on the conversation's own brain: summarizers.ts) reads it and writes
 *
 * - its episode: a dated summary (what was asked, what was done, where, how it ended), one per conversation,
 *   rewritten when a later turn of the same chat is summarized again. Not noted in the chat.
 * - at most a few durable facts the agent did not save itself (preferences, accounts, people, site playbooks),
 *   each noted in the chat as a `memory` event with auto: true, whose Undo (MemoryService.undo) puts it back.
 *
 * When: a task run is written soon after it ends (EPISODE_TASK_DELAY_MS); a chat once it has been idle for
 * EPISODE_IDLE_MS after a turn (the next turn's end pushes it back). The MV3 service worker sleeps, so the queue
 * ({sessionId, dueAt}) is kept in chrome.storage.local and a chrome.alarms alarm (EPISODE_ALARM) set to the earliest
 * due time wakes the worker for it; background.ts calls onAlarm() from its top-level listener and resume() at every
 * worker start (alarms may not survive a browser restart). The writer never blocks a chat: it runs on the alarm,
 * failures are logged and retried at most MAX_EPISODE_ATTEMPTS times, then dropped.
 *
 * Nothing is written while memory is paused, when the conversation's memory is off, when the user turned Episodes
 * off (Settings > Memory: that stops the whole pass), for a brain without a writer, for a conversation too short to
 * matter (MIN_EPISODE_TRANSCRIPT_CHARS), or when nothing happened since it was last summarized. Facts obey their
 * own kinds' switches, and the same rules as remember: a playbook names its site, a secret is refused (the store).
 */
import {
  bareToolName,
  buildMemoryWriterPrompt,
  errorMessage,
  isMemoryRecord,
  MAX_MEMORY_SUBJECT_CHARS,
  MAX_WRITER_EXISTING_ENTRIES,
  MEMORY_WRITER_SYSTEM_PROMPT,
  memoryDomain,
  memoryTaskKey,
  MIN_EPISODE_TRANSCRIPT_CHARS,
  parseMemoryWriterAnswer,
  transcriptChars,
  WriterFactKind,
  writerFactKinds,
  type ExtensionSettings,
  type MemoryEntry,
  type MemorySource,
  type SessionInfo,
  type StampedAgentEvent,
  type TranscriptLine,
  type WriterFact,
} from "@browsertodo/shared";
import type { StorageLike } from "../engine/kv.js";
import type { Job } from "../engine/run/jobs.js";
import { MAX_SESSIONS, type SessionStore } from "../engine/sessions.js";
import { toolArgsSummary } from "../text.js";
import { MemoryRefusal, sameSlot, sameText, type MemoryStore, type NewMemory } from "./store.js";
import type { Summarize } from "./summarizers.js";

/** The chrome.alarms alarm that wakes the worker for the writer. */
export const EPISODE_ALARM = "memory-episodes";
/** Where the writer's queue is kept (chrome.storage.local). */
export const EPISODE_QUEUE_KEY = "memoryEpisodes";
/** A chat is summarized once it has been idle this long after a turn (a new turn pushes it back). */
export const EPISODE_IDLE_MS = 10 * 60_000;
/** A task run is summarized this soon after it ends (Chrome's shortest alarm delay). */
export const EPISODE_TASK_DELAY_MS = 30_000;
/** A failed summary is tried again after this, times the attempts so far. */
export const EPISODE_RETRY_MS = 5 * 60_000;
/** Tries per summary before it is dropped. */
export const MAX_EPISODE_ATTEMPTS = 3;
/** How long a tool call's arguments read in the transcript. */
const ACTION_ARGS_CHARS = 160;

/** When and how a conversation's turn ended, for its summary. */
export interface EpisodeTrigger {
  /** A task run ended: summarize soon. Otherwise a chat turn: once it has been idle. */
  soon: boolean;
  /** The conversation's task (a TODO or cloud task): its episode names it (taskKey, taskTitle). */
  task?: { instructions: string; account: string | null };
}

/** How a run's end triggers the writer (lifecycle.ts): a task's first run soon, every chat turn once idle. */
export function episodeTrigger(job: Job): EpisodeTrigger {
  switch (job.source) {
    case "local":
      return { soon: true, task: { instructions: job.task.instructions, account: job.task.account } };
    case "cloud":
      return { soon: true, task: { instructions: job.claim.task.instructions, account: job.claim.task.account } };
    case "adhoc":
      return { soon: false };
    case "turn":
      return { soon: false, ...(job.from.source === "adhoc" ? {} : { task: job.first }) };
  }
}

interface EpisodeJob {
  sessionId: string;
  dueAt: number;
  attempts: number;
  task?: { instructions: string; account: string | null };
}

interface WriterState {
  queue: EpisodeJob[];
  /** Each conversation's last event already summarized (its time), oldest first; at most MAX_SESSIONS. */
  written: Record<string, string>;
}

export interface EpisodeWriterDeps {
  store: Pick<MemoryStore, "list" | "put" | "putEpisode">;
  sessions: Pick<SessionStore, "get" | "eventsOf" | "note">;
  settings(): Promise<Pick<ExtensionSettings, "memoryPaused" | "memoryKindsOff">>;
  /** The writer's call for a conversation on this brain (null: that brain has none). */
  summarizer(brain: SessionInfo["brain"]): Summarize | null;
  /** The EPISODE_ALARM alarm: set to fire at `when` (epoch ms), or cleared. */
  alarms: { set(when: number): Promise<void>; clear(): Promise<void> };
  /** Default chrome.storage.local (looked up lazily). */
  storage?: StorageLike;
  now?(): number;
  newChangeId?(): string;
  log(message: string): void;
}

/** What one pass over a conversation came to: written, nothing to write (dropped), not yet (the chat runs), or failed. */
type Outcome = { kind: "done" | "skip"; why: string } | { kind: "wait" } | { kind: "fail"; why: string };

/** The events that are the conversation itself (not status lines, memory notes or voice). */
const CONTENT = new Set<StampedAgentEvent["type"]>(["user_message", "assistant_text", "tool_call", "tool_result", "task_end"]);

export class EpisodeWriter {
  private lock: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: EpisodeWriterDeps) {}

  /** A conversation's turn ended: queue its summary (soon for a task run, after idle for a chat). Never throws. */
  async ended(sessionId: string, trigger: EpisodeTrigger): Promise<void> {
    try {
      await this.mutate((s) => {
        const was = s.queue.find((j) => j.sessionId === sessionId);
        const task = trigger.task ?? was?.task;
        const job: EpisodeJob = { sessionId, dueAt: this.now() + (trigger.soon ? EPISODE_TASK_DELAY_MS : EPISODE_IDLE_MS), attempts: 0, ...(task ? { task } : {}) };
        s.queue = [...s.queue.filter((j) => j.sessionId !== sessionId), job];
      });
      await this.schedule();
    } catch (err) {
      this.deps.log(`episode for ${sessionId} not queued: ${errorMessage(err)}`);
    }
  }

  /** chrome.alarms.onAlarm: true when the alarm was the writer's (it then writes what is due). */
  onAlarm(name: string): boolean {
    if (name !== EPISODE_ALARM) return false;
    void this.runDue();
    return true;
  }

  /** A worker start: the alarm is set again for what is queued (alarms may not survive a browser restart). */
  async resume(): Promise<void> {
    await this.schedule().catch((err: unknown) => this.deps.log(`episode alarm not set: ${errorMessage(err)}`));
  }

  /** Writes every summary that is due, one at a time, then sets the alarm for the next. One pass at a time. */
  runDue(): Promise<void> {
    this.running ??= this.drain().finally(() => (this.running = null));
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const job = (await this.state()).queue.filter((j) => j.dueAt <= this.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!job) break;
        let outcome: Outcome;
        try {
          outcome = await this.write(job);
        } catch (err) {
          outcome = { kind: "fail", why: errorMessage(err) };
        }
        await this.settle(job, outcome);
      }
    } catch (err) {
      this.deps.log(`episodes: ${errorMessage(err)}`);
    }
    await this.resume();
  }

  /** The job's queue entry after a pass (unless a later turn queued it again meanwhile). */
  private async settle(job: EpisodeJob, outcome: Outcome): Promise<void> {
    const id = job.sessionId;
    if (outcome.kind === "done" || outcome.kind === "skip") this.deps.log(`episode for ${id}: ${outcome.kind === "done" ? "" : "skipped, "}${outcome.why}`);
    const retry = outcome.kind === "fail" && job.attempts + 1 < MAX_EPISODE_ATTEMPTS;
    if (outcome.kind === "fail") this.deps.log(`episode for ${id} failed (attempt ${job.attempts + 1} of ${MAX_EPISODE_ATTEMPTS}${retry ? "" : ", dropped"}): ${outcome.why}`);
    await this.mutate((s) => {
      const now = s.queue.find((j) => j.sessionId === id);
      // A later turn queued it again while this pass ran: that entry stands.
      if (!now || now.dueAt !== job.dueAt) return;
      const rest = s.queue.filter((j) => j.sessionId !== id);
      if (outcome.kind === "wait") s.queue = [...rest, { ...now, dueAt: this.now() + EPISODE_IDLE_MS }];
      else if (retry) s.queue = [...rest, { ...now, attempts: job.attempts + 1, dueAt: this.now() + EPISODE_RETRY_MS * (job.attempts + 1) }];
      else s.queue = rest;
    });
  }

  /** One conversation's pass: the checks, the model call, and what it saves. */
  private async write(job: EpisodeJob): Promise<Outcome> {
    const id = job.sessionId;
    const off = await this.offReason(id);
    if (off) return { kind: "skip", why: off };
    const session = (await this.deps.sessions.get(id))!;
    if (!session.endedAt) return { kind: "wait" };
    const summarize = this.deps.summarizer(session.brain);
    if (!summarize) return { kind: "skip", why: `no memory writer for the ${session.brain} brain` };
    const events = await this.deps.sessions.eventsOf(id);
    const lastAt = events.filter((e) => CONTENT.has(e.type)).at(-1)?.ts ?? session.endedAt;
    const written = (await this.state()).written[id];
    if (written && written >= lastAt) return { kind: "skip", why: "nothing new since its last summary" };
    const lines = transcriptLines(session, events, job.task);
    if (transcriptChars(lines) < MIN_EPISODE_TRANSCRIPT_CHARS) return { kind: "skip", why: "too short to summarize" };

    const entries = await this.deps.store.list();
    const prompt = buildMemoryWriterPrompt({
      kind: session.source === "adhoc" ? "chat" : "task",
      title: session.title,
      startedAt: session.firstStartedAt ?? session.startedAt,
      endedAt: session.endedAt,
      lines,
      existing: entriesToShow(entries, id, lines),
    });
    const reply = await summarize({ system: MEMORY_WRITER_SYSTEM_PROMPT, prompt, sessionId: id });
    const answer = parseMemoryWriterAnswer(reply.text);
    const cost = reply.costUsd === undefined ? "" : ` ($${reply.costUsd.toFixed(4)})`;

    // Settings may have changed while the model wrote.
    const offNow = await this.offReason(id);
    if (offNow) return { kind: "skip", why: offNow };
    const source: MemorySource = { kind: session.source === "adhoc" ? "chat" : "task", sessionId: id, title: session.title };
    let episode = "no episode";
    if (answer.episode) {
      const task = job.task ? { taskKey: memoryTaskKey(job.task.instructions, job.task.account), taskTitle: firstLine(job.task.instructions) } : {};
      try {
        const change = await this.deps.store.putEpisode({ ...answer.episode, at: session.firstStartedAt ?? session.startedAt, ...task }, source);
        episode = `episode [${change.after!.id}] ${change.before ? "rewritten" : "written"}`;
      } catch (err) {
        if (!(err instanceof MemoryRefusal)) throw err;
        episode = `episode refused (${err.message})`;
      }
    }
    const saved = await this.saveFacts(id, answer.facts, entries, source);
    await this.mutate((s) => {
      delete s.written[id];
      s.written[id] = lastAt;
      const ids = Object.keys(s.written);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete s.written[old];
    });
    return { kind: "done", why: `${episode}, ${saved} fact(s) saved${cost}` };
  }

  /** Saves the facts whose kinds are on, each noted in the chat (auto) for Undo; returns how many were saved. */
  private async saveFacts(sessionId: string, facts: readonly WriterFact[], entries: readonly MemoryEntry[], source: MemorySource): Promise<number> {
    const kinds = writerFactKinds((await this.deps.settings()).memoryKindsOff);
    let saved = 0;
    for (const f of facts) {
      if (!kinds.includes(f.kind)) continue;
      const m = settleFact(f);
      if (!m || entries.some((e) => sameSlot(e, m) && sameText(e.text, m.text))) continue;
      const replaces = f.replaces && replaceable(entries, f.replaces.replace(/^\[|\]$/g, ""), m);
      try {
        const change = await this.deps.store.put(m, source, replaces ? { replaces } : {});
        const changeId = this.deps.newChangeId?.() ?? crypto.randomUUID();
        await this.deps.sessions.note(sessionId, { type: "memory", changeId, before: change.before, after: change.after, ...(change.replaced ? { replaced: change.replaced } : {}), auto: true });
        saved++;
      } catch (err) {
        if (!(err instanceof MemoryRefusal)) throw err;
        this.deps.log(`fact "${m.subject}" from ${sessionId} refused: ${err.message}`);
      }
    }
    return saved;
  }

  /** Why nothing may be written for this conversation now, or null. */
  private async offReason(sessionId: string): Promise<string | null> {
    const settings = await this.deps.settings();
    if (settings.memoryPaused) return "memory is paused";
    if (settings.memoryKindsOff.includes("episode")) return "episodes are off in Settings";
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return "the conversation is gone";
    return session.memoryOff ? "memory is off in this chat" : null;
  }

  private async schedule(): Promise<void> {
    const due = (await this.state()).queue.map((j) => j.dueAt);
    if (due.length) await this.deps.alarms.set(Math.min(...due));
    else await this.deps.alarms.clear();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private async state(): Promise<WriterState> {
    const got = (await this.storage().get(EPISODE_QUEUE_KEY))[EPISODE_QUEUE_KEY] as Partial<WriterState> | undefined;
    return {
      queue: Array.isArray(got?.queue) ? got.queue.filter((j) => typeof j?.sessionId === "string" && typeof j.dueAt === "number") : [],
      written: got?.written && typeof got.written === "object" ? { ...got.written } : {},
    };
  }

  /** Serialized read-modify-write of the queue. */
  private async mutate(fn: (s: WriterState) => void): Promise<void> {
    const run = this.lock.then(async () => {
      const s = await this.state();
      fn(s);
      await this.storage().set({ [EPISODE_QUEUE_KEY]: s });
    });
    this.lock = run.catch(() => {});
    await run;
  }
}

/**
 * The conversation as the writer reads it: its first request, the user's messages, the agent's replies, its tool
 * calls in brief (errors marked), and how each turn ended. The task's own end calls are left out (the outcome says it).
 */
export function transcriptLines(session: SessionInfo, events: readonly StampedAgentEvent[], task?: { instructions: string }): TranscriptLine[] {
  const errors = new Map<string, string>();
  for (const e of events) if (e.type === "tool_result" && e.isError) errors.set(e.id, (e.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "failed");
  const lines: TranscriptLine[] = [{ who: "user", text: task?.instructions ?? session.instructions ?? session.title }];
  for (const e of events) {
    if (e.type === "user_message") lines.push({ who: "user", text: e.text });
    else if (e.type === "assistant_text") lines.push({ who: "agent", text: e.text });
    else if (e.type === "tool_call") {
      const name = bareToolName(e.name);
      if (name.startsWith("task_")) continue;
      const args = toolArgsSummary(name, e.args, ACTION_ARGS_CHARS);
      const error = errors.get(e.id);
      lines.push({ who: "action", text: `${name}${args ? ` ${args}` : ""}${error ? ` (error: ${error})` : ""}` });
    } else if (e.type === "task_end") {
      const parts = [e.outcome, e.summary ? `: ${e.summary}` : "", e.reason ? ` (${e.reason})` : "", e.url ? ` ${e.url}` : ""];
      lines.push({ who: "outcome", text: parts.join("") });
    }
  }
  return lines;
}

/** The fact as memory keeps it (remember's rules: a site's host for a domain, a playbook needs one), or null. */
function settleFact(f: WriterFact): NewMemory | null {
  const domain = f.domain === undefined ? undefined : (memoryDomain(f.domain) ?? undefined);
  if (f.kind === "playbook" && !domain) return null;
  return { kind: f.kind, subject: f.subject, text: f.text, ...(domain ? { scope: "domain" as const, domain } : { scope: "global" as const }) };
}

/** `id` when it names a fact the writer may replace (a writer kind, not the fact's own slot), else undefined. */
function replaceable(entries: readonly MemoryEntry[], id: string, m: NewMemory): string | undefined {
  const e = entries.find((x) => x.id === id);
  const kinds: readonly string[] = WriterFactKind.options;
  return e && !isMemoryRecord(e) && kinds.includes(e.kind) && !sameSlot(e, m) ? id : undefined;
}

/**
 * The entries the writer is shown so it does not repeat them: facts of the kinds it writes, those saved in this
 * conversation first, then those the conversation mentions (subject or site), then the most recently changed.
 */
function entriesToShow(entries: readonly MemoryEntry[], sessionId: string, lines: readonly TranscriptLine[]): MemoryEntry[] {
  const text = lines.map((l) => l.text).join("\n").toLowerCase();
  const kinds: readonly string[] = WriterFactKind.options;
  const score = (e: MemoryEntry) => (e.source.sessionId === sessionId ? 2 : 0) + (text.includes(e.subject.toLowerCase()) || (e.domain && text.includes(e.domain)) ? 1 : 0);
  return entries
    .filter((e) => !isMemoryRecord(e) && kinds.includes(e.kind))
    .map((e) => ({ e, s: score(e) }))
    .sort((a, b) => b.s - a.s || b.e.updatedAt.localeCompare(a.e.updatedAt))
    .slice(0, MAX_WRITER_EXISTING_ENTRIES)
    .map((x) => x.e);
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, MAX_MEMORY_SUBJECT_CHARS);
}
