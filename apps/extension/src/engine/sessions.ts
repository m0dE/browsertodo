/**
 * Session history: one SessionInfo per agent run plus its event stream, in
 * IndexedDB. New events and session changes are pushed live to listeners
 * (the UI ports).
 */
import { clipEventText, type AgentEvent, type SessionInfo, type StampedAgentEvent } from "@browsertodo/shared";
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
export function clipEvent(e: AgentEvent): AgentEvent {
  switch (e.type) {
    case "status":
    case "assistant_text":
    case "user_message":
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
      return json && json.length > 4000 ? { ...e, args: clipEventText(json) } : e;
    }
    default:
      return e;
  }
}

export class SessionStore {
  private readonly sessions: KvStore<SessionInfo>;
  private readonly events: KvStore<StampedAgentEvent>;
  private readonly listeners = new Set<SessionListener>();
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
    this.listeners.add(l);
    return () => this.listeners.delete(l);
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

  /** Stamps, stores and pushes one event. Never throws. */
  append(sessionId: string, event: AgentEvent): StampedAgentEvent {
    const stamped = { ...clipEvent(event), ts: this.now().toISOString(), sessionId } as StampedAgentEvent;
    const n = this.seq.get(sessionId) ?? 0;
    this.seq.set(sessionId, n + 1);
    void this.enqueue(async () => {
      await this.events.put(seqKey(sessionId, n), stamped);
      if (n >= MAX_EVENTS_PER_SESSION) await this.events.delete(seqKey(sessionId, n - MAX_EVENTS_PER_SESSION));
    }).catch(() => {});
    for (const l of this.listeners) safe(() => l.onEvent?.(stamped));
    return stamped;
  }

  async update(sessionId: string, patch: Partial<SessionInfo>): Promise<SessionInfo | null> {
    let out: SessionInfo | null = null;
    await this.enqueue(async () => {
      const cur = await this.sessions.get(sessionId);
      if (!cur) return;
      out = { ...cur, ...patch, sessionId };
      await this.sessions.put(sessionId, out);
    });
    const s = out as SessionInfo | null;
    if (s) this.emitSession(s);
    if (s?.endedAt) this.seq.delete(sessionId);
    return s;
  }

  async get(sessionId: string): Promise<SessionInfo | null> {
    await this.chain.catch(() => {});
    return (await this.sessions.get(sessionId)) ?? null;
  }

  /** Newest first. */
  async list(limit = 50): Promise<SessionInfo[]> {
    await this.chain.catch(() => {});
    const all = (await this.sessions.list()).map((e) => e.value);
    all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
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

  private async prune(): Promise<void> {
    const all = (await this.sessions.list()).map((e) => e.value);
    if (all.length <= MAX_SESSIONS) return;
    all.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    for (const s of all.slice(0, all.length - MAX_SESSIONS)) {
      await this.sessions.delete(s.sessionId);
      await this.events.deletePrefix(`${s.sessionId}:`);
    }
  }

  private emitSession(s: SessionInfo): void {
    for (const l of this.listeners) safe(() => l.onSession?.(s));
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a listener must not break the store */
  }
}
