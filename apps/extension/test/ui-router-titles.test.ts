import { beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@browsertodo/shared";
import { SessionStore } from "../src/engine/sessions.js";
import { UiRouter, type UiRouterDeps } from "../src/engine/ui-router.js";
import type { UiRequest, UiResponse } from "../src/ui-protocol.js";
import { MemoryKvDb } from "./memory-kv.js";

let sessions: SessionStore;
let shown: string[][];
let req: <T = any>(r: UiRequest) => Promise<T>;

const at = (min: number) => new Date(Date.parse("2026-09-27T10:00:00Z") + min * 60_000).toISOString();
function session(id: string, min: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId: id, source: "adhoc", title: `Title ${id}`, brain: "claude-api", jev: false, startedAt: at(min), endedAt: at(min + 1), outcome: "done", ...extra };
}

beforeEach(async () => {
  sessions = new SessionStore(new MemoryKvDb());
  shown = [];
  // Only what these requests use: the sessions and the titler.
  const deps = { sessions, titles: { shown: (list: readonly SessionInfo[]) => shown.push(list.map((s) => s.sessionId)) } } as unknown as UiRouterDeps;
  const router = new UiRouter(deps);
  req = async (r) => {
    const res = (await router.handle(r)) as UiResponse<any>;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  await sessions.create(session("chat-old", 0));
  await sessions.create(session("todo-run", 10, { source: "local", taskId: "t1", title: "Post the daily tip" }));
  await sessions.create(session("todo-chat", 20, { source: "local", taskId: "t2", turns: 2 }));
  await sessions.create(session("chat-new", 30));
});

describe("sessions.list for the new chat's recent chats", () => {
  it("chats: only conversations to go on with, newest first, and asks for their titles", async () => {
    const { sessions: list } = await req<{ sessions: SessionInfo[] }>({ type: "sessions.list", chats: true, limit: 2 });
    expect(list.map((s) => s.sessionId)).toEqual(["chat-new", "todo-chat"]);
    expect(shown).toEqual([["chat-new", "todo-chat"]]);
  });

  it("History's list (every run) also asks for its chats' titles", async () => {
    const { sessions: list } = await req<{ sessions: SessionInfo[] }>({ type: "sessions.list", limit: 10 });
    expect(list).toHaveLength(4);
    expect(shown[0]).toHaveLength(4);
  });
});

describe("session.rename", () => {
  it("keeps the user's name (cleaned) and marks it theirs", async () => {
    const { session: s } = await req<{ session: SessionInfo }>({ type: "session.rename", sessionId: "chat-new", title: "  Web Store \n emails " });
    expect(s).toMatchObject({ title: "Web Store emails", titleBy: "user" });
    expect(await sessions.get("chat-new")).toMatchObject({ title: "Web Store emails", titleBy: "user" });
  });

  it("refuses an empty name, a secret, a TODO run and an unknown chat", async () => {
    await expect(req({ type: "session.rename", sessionId: "chat-new", title: "  " })).rejects.toThrow(/Give the chat a name/);
    await expect(req({ type: "session.rename", sessionId: "chat-new", title: "password is hunter22" })).rejects.toThrow(/can't hold a password/);
    await expect(req({ type: "session.rename", sessionId: "todo-run", title: "Mine" })).rejects.toThrow(/named by its task/);
    await expect(req({ type: "session.rename", sessionId: "nope", title: "Mine" })).rejects.toThrow(/No session/);
    expect((await sessions.get("chat-new"))!.title).toBe("Title chat-new");
  });
});
