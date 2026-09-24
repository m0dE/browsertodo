import {
  NATIVE_HOST_NAME,
  RpcPeer,
  type BrowserMethods,
  type HelperInfo,
  type HelperMethods,
  type RpcMessage,
} from "@browsertodo/shared";

/**
 * HelperMethods and BrowserMethods are interfaces, which TypeScript does not
 * treat as assignable to RpcPeer's MethodMap index signature. A mapped copy is.
 */
type Methods<T> = { [K in keyof T]: T[K] };
export type HelperPeer = RpcPeer<Methods<HelperMethods>, Methods<BrowserMethods>>;

export interface HelperLinkOptions {
  /** Registers the browser.* and vault.* handlers on each new peer. */
  registerHandlers: (peer: HelperPeer) => void;
  hostName?: string;
}

/**
 * The native messaging connection to the local helper. One RpcPeer per port;
 * connect() opens a new port when the previous one is gone.
 */
export class HelperLink {
  private port: chrome.runtime.Port | null = null;
  private peer: HelperPeer | null = null;
  private helperInfo: HelperInfo | null = null;
  private connecting: Promise<HelperInfo> | null = null;
  private readonly listeners = new Set<(reason: string) => void>();

  constructor(private readonly opts: HelperLinkOptions) {}

  get connected(): boolean {
    return this.peer !== null && this.helperInfo !== null;
  }

  get info(): HelperInfo | null {
    return this.helperInfo;
  }

  /** Opens the port if needed and says hello. Resolves with the helper info. */
  connect(timeoutMs = 10_000): Promise<HelperInfo> {
    if (this.connected) return Promise.resolve(this.helperInfo!);
    if (!this.connecting) {
      this.connecting = this.open(timeoutMs).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  call<M extends keyof HelperMethods & string>(
    method: M,
    params: HelperMethods[M]["params"],
    opts: { timeoutMs?: number } = {},
  ): Promise<HelperMethods[M]["result"]> {
    if (!this.peer || !this.helperInfo) return Promise.reject(new Error("Helper not connected"));
    return this.peer.call(method, params, opts);
  }

  /** Subscribe to port loss. Returns an unsubscribe function. */
  onDisconnect(fn: (reason: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  disconnect(reason = "Helper disconnected"): void {
    const port = this.port;
    this.teardown(reason);
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private async open(timeoutMs: number): Promise<HelperInfo> {
    const hostName = this.opts.hostName ?? NATIVE_HOST_NAME;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(hostName);
    } catch (err) {
      throw new Error(`Cannot start helper: ${err instanceof Error ? err.message : String(err)}`);
    }
    const peer: HelperPeer = new RpcPeer<Methods<HelperMethods>, Methods<BrowserMethods>>((msg) => port.postMessage(msg), "e");
    this.opts.registerHandlers(peer);
    this.port = port;
    this.peer = peer;
    port.onMessage.addListener((m: unknown) => {
      void peer.receive(m as RpcMessage);
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? "Helper disconnected";
      if (this.port === port) this.teardown(reason);
      else peer.close(reason);
    });
    try {
      const info = await peer.call("helper.hello", {}, { timeoutMs });
      if (this.port !== port) throw new Error("Helper disconnected");
      this.helperInfo = info;
      return info;
    } catch (err) {
      if (this.port === port) this.disconnect(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private teardown(reason: string): void {
    const hadPeer = this.peer !== null;
    const wasConnected = this.helperInfo !== null;
    this.peer?.close(reason);
    this.port = null;
    this.peer = null;
    this.helperInfo = null;
    if (hadPeer && wasConnected) for (const fn of this.listeners) fn(reason);
  }
}
