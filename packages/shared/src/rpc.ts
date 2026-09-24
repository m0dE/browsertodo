/**
 * Minimal bidirectional JSON RPC over any message transport. Used for
 * extension <-> helper (native messaging) and MCP server <-> helper (pipe).
 * Each side can both call and handle methods.
 */

export interface RpcMessage {
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

export type MethodMap = Record<string, { params: unknown; result: unknown }>;

type Handler = (params: any) => unknown | Promise<unknown>;

export class RpcError extends Error {}

export class RpcPeer<Outgoing extends MethodMap, Incoming extends MethodMap> {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly handlers = new Map<string, Handler>();
  private closed = false;

  constructor(
    private readonly send: (msg: RpcMessage) => void,
    private readonly idPrefix = "",
  ) {}

  handle<M extends keyof Incoming & string>(
    method: M,
    fn: (params: Incoming[M]["params"]) => Incoming[M]["result"] | Promise<Incoming[M]["result"]>,
  ): void {
    this.handlers.set(method, fn);
  }

  call<M extends keyof Outgoing & string>(
    method: M,
    params: Outgoing[M]["params"],
    opts: { timeoutMs?: number } = {},
  ): Promise<Outgoing[M]["result"]> {
    if (this.closed) return Promise.reject(new RpcError("RPC connection closed"));
    const id = `${this.idPrefix}${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = {
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(`${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new RpcError(String(err)));
      }
    });
  }

  /** Feed an incoming message from the transport. */
  async receive(msg: RpcMessage): Promise<void> {
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.safeSend({ id: msg.id, error: { message: `Unknown method: ${msg.method}` } });
        return;
      }
      try {
        const result = await handler(msg.params ?? {});
        this.safeSend({ id: msg.id, result: result ?? null });
      } catch (err) {
        this.safeSend({ id: msg.id, error: { message: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new RpcError(msg.error.message));
      else entry.resolve(msg.result);
    }
  }

  /** Reject every pending call. Further calls fail immediately. */
  close(reason = "RPC connection closed"): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new RpcError(reason));
      this.pending.delete(id);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private safeSend(msg: RpcMessage): void {
    if (this.closed) return;
    try {
      this.send(msg);
    } catch {
      /* transport gone; the close handler will clean up */
    }
  }
}
