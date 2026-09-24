import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_HOST_NAME, type RpcMessage } from "@browsertodo/shared";
import { installChromeFake, type ChromeFake, type FakePort } from "./chrome-fake.js";
import { HelperLink } from "../src/helper-link.js";

const INFO = { version: "0.1.0", jevAvailable: true, claudePath: "C:\\claude.exe", logDir: "C:\\logs" };

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Scripted host that answers helper.hello. */
function answerHello(port: FakePort) {
  const orig = port.postMessage;
  port.postMessage = (msg) => {
    orig(msg);
    const m = msg as RpcMessage;
    if (m.method === "helper.hello") queueMicrotask(() => port.deliver({ id: m.id, result: INFO }));
  };
}

describe("HelperLink", () => {
  it("connects to the native host and says hello", async () => {
    chrome.runtime.onConnectNative = answerHello;
    const link = new HelperLink({ registerHandlers: () => {} });
    expect(await link.connect()).toEqual(INFO);
    expect(chrome.runtime.ports[0]!.name).toBe(NATIVE_HOST_NAME);
    expect(link.info).toEqual(INFO);
    expect(link.connected).toBe(true);
    // A second connect reuses the port.
    await link.connect();
    expect(chrome.runtime.ports).toHaveLength(1);
  });

  it("rejects with Chrome's error when the host is missing", async () => {
    chrome.runtime.onConnectNative = (port) => queueMicrotask(() => port.hostDisconnect("Specified native messaging host not found."));
    const link = new HelperLink({ registerHandlers: () => {} });
    await expect(link.connect()).rejects.toThrow("Specified native messaging host not found.");
    expect(link.connected).toBe(false);
    expect(link.info).toBeNull();
  });

  it("times out when hello gets no answer", async () => {
    vi.useFakeTimers();
    const link = new HelperLink({ registerHandlers: () => {} });
    const p = link.connect(10_000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(link.connected).toBe(false);
  });

  it("serves browser.* calls from the helper with registered handlers", async () => {
    chrome.runtime.onConnectNative = answerHello;
    const link = new HelperLink({
      registerHandlers: (peer) => peer.handle("browser.currentUrl", async () => ({ url: "https://example.com/" })),
    });
    await link.connect();
    const port = chrome.runtime.ports[0]!;
    port.deliver({ id: "h1", method: "browser.currentUrl", params: {} });
    await vi.waitFor(() => expect(port.posted).toContainEqual({ id: "h1", result: { url: "https://example.com/" } }));
  });

  it("notifies listeners and fails pending calls on disconnect, then reconnects", async () => {
    chrome.runtime.onConnectNative = answerHello;
    const link = new HelperLink({ registerHandlers: () => {} });
    const onDisc = vi.fn();
    link.onDisconnect(onDisc);
    await link.connect();
    const pending = link.call("helper.runTask", {} as never);
    chrome.runtime.ports[0]!.hostDisconnect("Native host has exited.");
    await expect(pending).rejects.toThrow(/Native host has exited/);
    expect(onDisc).toHaveBeenCalledWith("Native host has exited.");
    expect(link.connected).toBe(false);
    expect(link.info).toBeNull();

    await link.connect();
    expect(chrome.runtime.ports).toHaveLength(2);
    expect(link.connected).toBe(true);
  });

  it("call() fails fast when not connected", async () => {
    const link = new HelperLink({ registerHandlers: () => {} });
    await expect(link.call("helper.getLog", { lines: 10 })).rejects.toThrow(/not connected/i);
  });
});
