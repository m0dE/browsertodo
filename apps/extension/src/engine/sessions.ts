/**
 * Session history: one SessionInfo per agent run plus its event stream, in
 * IndexedDB. New events and session changes are pushed live to listeners
 * (the UI ports).
 */
import { MAX_ASSISTANT_TEXT, MAX_EVENT_TEXT, clipEventText, type AgentEvent, type SessionInfo, type StampedAgentEvent } from "@browsertodo/shared";
import { Listeners } from "../listeners.js";
import type { KvDb, KvStore } from "./kv.js";

export const MAX_SESSIONS = 200;
export const MAX_EVENTS_PER_SESSION = 2000;
/** Thumbnails bigger than this (base64 chars) are dropped from stored events. */
const MAX_THUMBNAIL_CHARS = 200_000;

export interface SessionListener {
  onEvent?(e: StampedAgentEvent): void;
  onSession?(s: SessionInfo): void;
}

function seqKey(sessionId: string, seq: number): string {
  return `${sessionId}:${String(seq).padStart(8, "0")}`;
}

/** Bounds the text fields of an event so storage stays small. */
function clipEvent(e: AgentEvent): AgentEvent {
  switch (e.type) {
    case "assistant_text":
      return { ...e, text: clipEventText(e.text, MAX_ASSISTANT_TEXT) };
    case "task_end":
      return e.summary && e.summary.length > MAX_ASSISTANT_TEXT ? { ...e, summary: clipEventText(e.summary, MAX_ASSISTANT_TEXT) } : e;
    case "status":
    case "user_message":
    case "spoken":
    case "error":
      return { ...e, text: clipEventText(e.text) };
    case "tool_result": {
      const out = { ...e };
      if (out.text !== undefined) out.text = clipEventText(out.text);
      if (out.thumbnail && out.thumbnail.length > MAX_THUMBNAIL_CHARS) delete out.thumbnail;
      return out;
    }
    case "tool_call": {
      const json = JSON.stringify(e.args ?? null);
      return json && json.length > MAX_EVENT_TEXT ? { ...e, args: clipEventText(json) } : e;
    }
    default:
      return e;
  }
}

export class SessionStore {
  private readonly sessions: KvStore<SessionInfo>;
  private readonly events: KvStore<StampedAgentEvent>;
  private readonly listeners = new Listeners<[{ event: StampedAgentEvent } | { session: SessionInfo }]>();
  /** Next sequence number per live session. */
  private readonly seq = new Map<string, number>();
  private readonly now: () => Date;
  /** Serializes writes so events keep their order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(db: KvDb, opts: { now?: () => Date } = {}) {
    this.sessions = db.store<SessionInfo>("sessions");
    this.events = db.store<StampedAgentEvent>("events");
    this.now = opts.now ?? (() => new Date());
  }

  subscribe(l: SessionListener): () => void {
    return this.listeners.add((change) => ("event" in change ? l.onEvent?.(change.event) : l.onSession?.(change.session)));
  }

  async create(info: SessionInfo): Promise<SessionInfo> {
    this.seq.set(info.sessionId, 0);
    await this.enqueue(async () => {
      await this.sessions.put(info.sessionId, info);
      await this.prune();
    });
    this.emitSession(info);
    return info;
  }

  /**
   * Stamps, stores and pushes one event. Never throws. Live text deltas
   * (assistant_text_delta) are only pushed: the final assistant_text is
   * what is kept.
   */
  append(sessionId: string, event: AgentEvent): StampedAgentEvent {
    if (event.type === "assistant_text_delta") {
      const live = { ...event, ts: this.now().toISOString(), sessionId } as StampedAgentEvent;
      this.listeners.emit({ event: live });
      return live;
    }
    const stamped = { ...clipEvent(event), ts: this.now().toISOString(), sessionId } as StampedAgentEvent;
    const n = this.seq.get(sessionId) ?? 0;
    this.seq.set(sessionId, n + 1);
    void this.enqueue(async () => {
      await this.events.put(seqKey(sessionId, n), stamped);
      if (n >= MAX_EVENTS_PER_SESSION) await this.events.delete(seqKey(sessionId, n - MAX_EVENTS_PER_SESSION));
    }).catch(() => {});
    this.listeners.emit({ event: stamped });
    return stamped;
  }

  async update(sessionId: string, patch: Partial<SessionInfo>): Promise<SessionInfo | null> {
    const s = await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur) return null;
      const next: SessionInfo = { ...cur, ...patch, sessionId };
      await this.sessions.put(sessionId, next);
      return next;
    });
    if (s) this.emitSession(s);
    if (s?.endedAt) this.seq.delete(sessionId);
    return s;
  }

  /**
   * Starts the next turn of an ended conversation: its events keep appending
   * after the stored ones, and the latest-turn fields (endedAt, outcome,
   * summary, url, reason, suggestion) are cleared, then `patch` applied. Null
   * when unknown.
   */
  async reopen(sessionId: string, patch: Partial<SessionInfo> = {}): Promise<SessionInfo | null> {
    const s = await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur) return null;
      const { endedAt: _e, outcome: _o, summary: _s, url: _u, reason: _r, suggestion: _g, ...rest } = cur;
      const next: SessionInfo = { ...rest, ...patch, sessionId };
      await this.sessions.put(sessionId, next);
      this.seq.set(sessionId, Math.max(await this.storedSeq(sessionId), this.seq.get(sessionId) ?? 0));
      return next;
    });
    if (s) this.emitSession(s);
    return s;
  }

  /**
   * Adds an event to a stored conversation from outside its turns (hands-free
   * voice's spoken lines): while it runs, or after it ended (also after the
   * service worker restarted). Null when there is no such session.
   */
  async note(sessionId: string, event: AgentEvent): Promise<StampedAgentEvent | null> {
    const known = this.seq.has(sessionId) || (await this.enqueue(async () => {
      if (this.seq.has(sessionId)) return true;
      if (!(await this.sessions.get(sessionId))) return false;
      this.seq.set(sessionId, await this.storedSeq(sessionId));
      return true;
    }));
    return known ? this.append(sessionId, event) : null;
  }

  async get(sessionId: string): Promise<SessionInfo | null> {
    await this.chain.catch(() => {});
    return (await this.sessions.get(sessionId)) ?? null;
  }

  /** Newest first; with taskId, only that task's runs. */
  async list(limit = 50, taskId?: string): Promise<SessionInfo[]> {
    await this.chain.catch(() => {});
    const all = (await this.sessions.list()).map((e) => e.value).filter((s) => taskId === undefined || s.taskId === taskId);
    all.sort((a, b) => byStart(b, a));
    return all.slice(0, Math.max(1, Math.min(MAX_SESSIONS, limit)));
  }

  async eventsOf(sessionId: string): Promise<StampedAgentEvent[]> {
    await this.chain.catch(() => {});
    return (await this.events.list(`${sessionId}:`)).map((e) => e.value);
  }

  /** Waits for queued writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.chain.catch(() => {});
  }

  /** The sequence number after the session's last stored event. */
  private async storedSeq(sessionId: string): Promise<number> {
    const last = (await this.events.keys(`${sessionId}:`)).at(-1);
    return last ? Number(last.slice(sessionId.length + 1)) + 1 : 0;
  }

  private async prune(): Promise<void> {
    const all = (await this.sessions.list()).map((e) => e.value);
    if (all.length <= MAX_SESSIONS) return;
    all.sort(byStart);
    for (const s of all.slice(0, all.length - MAX_SESSIONS)) {
      await this.sessions.delete(s.sessionId);
      await this.events.deletePrefix(`${s.sessionId}:`);
    }
  }

  private emitSession(s: SessionInfo): void {
    this.listeners.emit({ session: s });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

/** Oldest first (ISO timestamps compare as text). */
function byStart(a: SessionInfo, b: SessionInfo): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}
