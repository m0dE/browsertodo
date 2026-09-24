import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@browsertodo/shared";
import { handleUiMessage, type MessageDeps } from "../src/messages.js";

function deps(overrides: Partial<MessageDeps> = {}): MessageDeps {
  return {
    runNow: vi.fn(),
    runState: async () => ({ running: false, currentTaskId: null, lastRunAt: null, lastError: null }),
    helperInfo: () => null,
    connectHelper: async () => ({ version: "1", jevAvailable: false, claudePath: null, logDir: "" }),
    getLog: async (lines) => ({ text: `last ${lines}` }),
    vault: {
      unlock: async () => {
        throw new Error("Wrong passphrase");
      },
      lock: async () => {},
      list: async () => ({ locked: true, sites: [] }),
      set: async () => {},
      delete: async () => {},
    },
    testApi: async () => ({ ok: true }),
    loadSettings: async () => DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe("handleUiMessage", () => {
  it("status merges run state and helper info", async () => {
    const info = { version: "1", jevAvailable: true, claudePath: "c", logDir: "l" };
    expect(await handleUiMessage({ type: "status" }, deps({ helperInfo: () => info }))).toEqual({
      running: false,
      currentTaskId: null,
      lastRunAt: null,
      lastError: null,
      helper: info,
    });
  });

  it("runNow starts a run without waiting for it", async () => {
    const d = deps();
    expect(await handleUiMessage({ type: "runNow" }, d)).toEqual({ ok: true });
    expect(d.runNow).toHaveBeenCalled();
  });

  it("getLog returns empty text while the helper is not connected", async () => {
    expect(await handleUiMessage({ type: "getLog", lines: 50 }, deps())).toEqual({ text: "" });
    const connected = deps({ helperInfo: () => ({ version: "1", jevAvailable: false, claudePath: null, logDir: "" }) });
    expect(await handleUiMessage({ type: "getLog", lines: 50 }, connected)).toEqual({ text: "last 50" });
  });

  it("maps thrown errors to { ok: false, error }", async () => {
    expect(await handleUiMessage({ type: "vault.unlock", passphrase: "x" }, deps())).toEqual({ ok: false, error: "Wrong passphrase" });
  });

  it("rejects unknown message types", async () => {
    expect(await handleUiMessage({ type: "nope" } as never, deps())).toEqual({ error: "Unknown message type: nope" });
  });
});
