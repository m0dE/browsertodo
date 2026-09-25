/** Open side panel ports and the UiPush messages sent to them. */
import type { SessionInfo, StampedAgentEvent } from "@browsertodo/shared";
import { UI_PORT_NAME, type UiPush, type UiState } from "../ui-protocol.js";

export interface PortLike {
  name: string;
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(fn: () => void): void };
}

/** Open UI ports and the pushes to them. State pushes are coalesced. */
export class UiHub {
  private readonly ports = new Set<PortLike>();
  private statePending = false;

  constructor(
    private readonly getState: () => Promise<UiState>,
    private readonly opts: { stateDelayMs?: number } = {},
  ) {}

  get size(): number {
    return this.ports.size;
  }

  /** chrome.runtime.onConnect handler. Ignores ports with other names. */
  attach(port: PortLike): boolean {
    if (port.name !== UI_PORT_NAME) return false;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    void this.getState()
      .then((state) => this.post(port, { type: "state", state }))
      .catch(() => {});
    return true;
  }

  push(msg: UiPush): void {
    for (const p of this.ports) this.post(p, msg);
  }

  event(event: StampedAgentEvent): void {
    this.push({ type: "event", event });
  }

  session(session: SessionInfo): void {
    this.push({ type: "session", session });
    this.pushState();
  }

  /** Pushes a fresh UiState soon (several calls in a row send one). */
  pushState(): void {
    if (this.statePending || this.ports.size === 0) return;
    this.statePending = true;
    setTimeout(() => {
      this.statePending = false;
      if (this.ports.size === 0) return;
      void this.getState()
        .then((state) => this.push({ type: "state", state }))
        .catch(() => {});
    }, this.opts.stateDelayMs ?? 50);
  }

  private post(port: PortLike, msg: UiPush): void {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }
}
