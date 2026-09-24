import type { ExtensionSettings, HelperInfo } from "@browsertodo/shared";
import type { RunState } from "./coordinator.js";

/** Messages from the options page to the background (chrome.runtime.sendMessage). */
export type UiMessage =
  | { type: "runNow" }
  | { type: "status" }
  | { type: "connectHelper" }
  | { type: "getLog"; lines: number }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.list" }
  | { type: "vault.set"; site: string; username: string; password: string }
  | { type: "vault.delete"; site: string }
  | { type: "testApi" };

export type StatusResponse = RunState & { helper: HelperInfo | null };

export interface MessageDeps {
  runNow(): void;
  runState(): Promise<RunState>;
  helperInfo(): HelperInfo | null;
  connectHelper(): Promise<HelperInfo>;
  getLog(lines: number): Promise<{ text: string }>;
  vault: {
    unlock(passphrase: string): Promise<void>;
    lock(): Promise<void>;
    list(): Promise<{ locked: boolean; sites: string[] }>;
    set(site: string, username: string, password: string): Promise<void>;
    delete(site: string): Promise<void>;
  };
  testApi(settings: ExtensionSettings): Promise<{ ok: boolean; error?: string }>;
  loadSettings(): Promise<ExtensionSettings>;
}

/** Handles one options-page message. Errors come back as { error }. */
export async function handleUiMessage(msg: UiMessage, deps: MessageDeps): Promise<unknown> {
  try {
    switch (msg.type) {
      case "runNow":
        deps.runNow();
        return { ok: true };
      case "status":
        return { ...(await deps.runState()), helper: deps.helperInfo() } satisfies StatusResponse;
      case "connectHelper":
        return { ok: true, helper: await deps.connectHelper() };
      case "getLog":
        if (!deps.helperInfo()) return { text: "" };
        return await deps.getLog(Math.max(1, Math.min(2000, Math.trunc(msg.lines) || 200)));
      case "vault.unlock":
        await deps.vault.unlock(msg.passphrase);
        return { ok: true };
      case "vault.lock":
        await deps.vault.lock();
        return { ok: true };
      case "vault.list":
        return await deps.vault.list();
      case "vault.set":
        await deps.vault.set(msg.site, msg.username, msg.password);
        return { ok: true };
      case "vault.delete":
        await deps.vault.delete(msg.site);
        return { ok: true };
      case "testApi":
        return await deps.testApi(await deps.loadSettings());
      default:
        return { error: `Unknown message type: ${(msg as { type?: unknown }).type}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
