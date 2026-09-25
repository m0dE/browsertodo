import {
  NATIVE_HOST_NAME,
  RpcPeer,
  type BrowserMethods,
  type HelperInfo,
  type HelperMethods,
  type HelperNotifications,
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

/** helper.hello may run the Claude Code self-test (up to 60 s) before answering. */
export const HELLO_TIMEOUT_MS = 75_000;

type NotificationName = keyof HelperNotifications & string;

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
  private readonly infoListeners = new Set<(info: HelperInfo | null) => void>();
  private readonly notificationListeners = new Map<string, Set<(params: any) => void>>();
  private lastErrorText: string | null = null;

  constructor(private readonly opts: HelperLinkOptions) {}

  get connected(): boolean {
    return this.peer !== null && this.helperInfo !== null;
  }

  get info(): HelperInfo | null {
    return this.helperInfo;
  }

  /** Why the last connect failed or the port closed; null while connected. */
  get lastError(): string | null {
    return this.lastErrorText;
  }

  /**
   * Opens the port if needed and says hello. Resolves with the helper info.
   * selfTest: ask the helper to (re-)run its Claude Code self-test, also on
   * an existing connection.
   */
  connect(timeoutMs = HELLO_TIMEOUT_MS, opts: { selfTest?: boolean } = {}): Promise<HelperInfo> {
    if (this.connected && !opts.selfTest) return Promise.resolve(this.helperInfo!);
    if (this.connected && opts.selfTest) return this.rehello(timeoutMs);
    if (!this.connecting) {
      this.connecting = this.open(timeoutMs, !!opts.selfTest).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Subscribe to a helper notification (survives reconnects). Returns an unsubscribe function. */
  onNotification<N extends NotificationName>(method: N, fn: (params: HelperNotifications[N]) => void): () => void {
    let set = this.notificationListeners.get(method);
    if (!set) this.notificationListeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Called with the new info after every hello and with null on disconnect. */
  onInfo(fn: (info: HelperInfo | null) => void): () => void {
    this.infoListeners.add(fn);
    return () => this.infoListeners.delete(fn);
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

  private async rehello(timeoutMs: number): Promise<HelperInfo> {
    const peer = this.peer!;
    const info = await peer.call("helper.hello", { selfTest: true }, { timeoutMs });
    if (this.peer === peer) this.setInfo(info);
    return info;
  }

  private setInfo(info: HelperInfo | null): void {
    this.helperInfo = info;
    for (const fn of this.infoListeners) {
      try {
        fn(info);
      } catch {
        /* listener errors are not the link's problem */
      }
    }
  }

  private async open(timeoutMs: number, selfTest: boolean): Promise<HelperInfo> {
    const hostName = this.opts.hostName ?? NATIVE_HOST_NAME;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(hostName);
    } catch (err) {
      this.lastErrorText = `Cannot start helper: ${err instanceof Error ? err.message : String(err)}`;
      throw new Error(this.lastErrorText);
    }
    const peer: HelperPeer = new RpcPeer<Methods<HelperMethods>, Methods<BrowserMethods>>((msg) => port.postMessage(msg), "e");
    this.opts.registerHandlers(peer);
    for (const method of ["helper.event", "helper.terminal.opened", "helper.terminal.data", "helper.terminal.exit"] as const) {
      peer.onNotification(method, (params) => {
        for (const fn of this.notificationListeners.get(method) ?? []) {
          try {
            fn(params);
          } catch {
            /* keep delivering to the others */
          }
        }
      });
    }
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
      const info = await peer.call("helper.hello", selfTest ? { selfTest: true } : {}, { timeoutMs });
      if (this.port !== port) throw new Error(this.lastErrorText ?? "Helper disconnected");
      this.lastErrorText = null;
      this.setInfo(info);
      return info;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.port === port) this.disconnect(msg);
      this.lastErrorText = msg;
      throw err;
    }
  }

  private teardown(reason: string): void {
    const hadPeer = this.peer !== null;
    const wasConnected = this.helperInfo !== null;
    this.peer?.close(reason);
    this.port = null;
    this.peer = null;
    this.lastErrorText = reason;
    if (wasConnected) this.setInfo(null);
    else this.helperInfo = null;
    if (hadPeer && wasConnected) for (const fn of this.listeners) fn(reason);
  }
}
