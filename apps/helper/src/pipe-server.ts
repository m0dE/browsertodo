/**
 * Named pipe between the helper (server) and the per-task MCP server
 * processes (clients). Newline-delimited JSON carrying RpcPeer messages.
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcPeer, type PipeMethods, type RpcMessage } from "@browsertodo/shared";
import { encodeLine, LineDecoder } from "./line-framing.js";
import type { NoMethods, PipeMap } from "./rpc-types.js";

export function pipePathFor(pid: number): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\browsertodo-${pid}` : join(tmpdir(), `browsertodo-${pid}.sock`);
}

/** Connect an RpcPeer to a socket: line framing both ways, close on disconnect. */
function wire<O extends Record<string, { params: unknown; result: unknown }>, I extends Record<string, { params: unknown; result: unknown }>>(
  socket: Socket,
  idPrefix: string,
  onError?: (e: Error) => void,
): RpcPeer<O, I> {
  const peer = new RpcPeer<O, I>((msg: RpcMessage) => {
    if (socket.destroyed) throw new Error("pipe closed");
    socket.write(encodeLine(msg));
  }, idPrefix);
  const decoder = new LineDecoder();
  socket.on("data", (chunk: Buffer) => {
    let msgs: unknown[];
    try {
      msgs = decoder.push(chunk);
    } catch (e) {
      onError?.(e as Error);
      socket.destroy();
      return;
    }
    for (const m of msgs) void peer.receive(m as RpcMessage);
  });
  socket.on("close", () => peer.close("pipe closed"));
  socket.on("error", (e) => onError?.(e));
  return peer;
}

export interface PipeHandlers {
  toolCall: (params: PipeMethods["tool.call"]["params"]) => Promise<PipeMethods["tool.call"]["result"]>;
  toolList: (params: PipeMethods["tool.list"]["params"]) => PipeMethods["tool.list"]["result"];
}

export interface PipeServer {
  path: string;
  close(): Promise<void>;
}

export function startPipeServer(path: string, handlers: PipeHandlers, log?: (line: string) => void): Promise<PipeServer> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    log?.("pipe client connected");
    const peer = wire<NoMethods, PipeMap>(socket, "p", (e) => log?.(`pipe client error: ${e.message}`));
    peer.handle("tool.call", (p) => handlers.toolCall(p));
    peer.handle("tool.list", (p) => handlers.toolList(p));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", (e) => log?.(`pipe server error: ${e.message}`));
      resolve({
        path,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export interface PipeClient {
  peer: RpcPeer<PipeMap, NoMethods>;
  close(): void;
  closed: Promise<void>;
}

export function connectPipe(path: string): Promise<PipeClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      const peer = wire<PipeMap, NoMethods>(socket, "m");
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      resolve({ peer, close: () => socket.destroy(), closed });
    });
  });
}
