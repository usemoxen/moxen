/**
 * Serve a `ClientApi` over the local endpoint: one process owns the store,
 * the drivers and every live provider session, and any number of clients
 * (TUI, CLI invocations) talk to it.
 *
 * That ownership is the point. In-process, each client held its own
 * drivers, so a turn could only be steered, answered or even seen live
 * from the process that started it; here there is exactly one owner.
 *
 * Each socket must open with `hello` (protocol version check) before any
 * other request. Subscriptions belong to the socket that opened them and
 * end with it.
 *
 * A client that pings (`./remote.ts`'s heartbeat) has promised to be heard
 * from: once it has pinged, a socket silent past `CLIENT_SILENCE_MS` is
 * taken for a dead peer (a machine asleep, a dropped network) and closed,
 * releasing its subscriptions. A client that never pings is never timed out.
 */
import { rm } from "node:fs/promises";
import net from "node:net";

import { CliError } from "../../core/errors.js";
import type { ClientApi } from "../api.js";
import { isNamedPipe, probe } from "./endpoint.js";
import {
  encode,
  LineReader,
  parseLine,
  PROTOCOL_VERSION,
  toWireError,
  type HelloResult,
  type ServerMessage,
} from "./wire.js";

/** Three missed heartbeats (`./remote.ts` pings every 2.5s when quiet). */
export const CLIENT_SILENCE_MS = 30_000;

export interface ServerHandle {
  readonly endpoint: string;
  /** Resolves once the server has stopped (after `close`, or a client's `shutdown`). */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface ServeOptions {
  readonly endpoint: string;
  readonly api: ClientApi;
  /** Runs once the listener has stopped — the owner releases drivers here. */
  readonly onClose?: () => Promise<void>;
  /** Added to every local socket's hello result (the server's config file). */
  readonly greeting?: Partial<HelloResult>;
}

export async function serve(options: ServeOptions): Promise<ServerHandle> {
  const { endpoint, api } = options;
  // Listening twice on a live named pipe does not fail cleanly, and on
  // unix a live socket file would be clobbered: ask first.
  if (await probe(endpoint)) {
    throw new CliError("SERVER_RUNNING", `A moxen server is already listening at ${endpoint}.`, {
      details: { endpoint },
    });
  }
  // Unix only: a socket file left by a crashed server refuses connections
  // (the probe above) but still blocks `listen`. Named pipes vanish with
  // their process, so there is nothing to reclaim on Windows.
  if (!isNamedPipe(endpoint)) await rm(endpoint, { force: true }).catch(() => undefined);

  const sockets = new Set<net.Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | null = null;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    handleSocket(socket, api, { remote: false, shutdown: () => void close(), ...(options.greeting ? { greeting: options.greeting } : {}) });
    socket.once("close", () => sockets.delete(socket));
  });

  const close = (): Promise<void> => {
    closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      await options.onClose?.().catch(() => undefined);
      resolveClosed();
    })();
    return closing;
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { endpoint, closed, close };
}

/** How one socket is served: where it came from, and what it may do. */
export interface SocketContext {
  /** Accepted by the remote listener (`./remoteaccess.ts`) rather than the local endpoint. */
  readonly remote: boolean;
  /** Stop the server. Never offered to a remote socket. */
  readonly shutdown: () => void;
  /**
   * Remote sockets only: vets the `hello` params (a pairing code, or a
   * device's id and token) before the socket is greeted, throwing to
   * refuse. What it returns is added to the hello result. Without it every
   * remote hello is refused.
   */
  readonly admit?: (params: Record<string, unknown>, socket: net.Socket) => Promise<Partial<HelloResult>> | Partial<HelloResult>;
  /** How long a client that pings may go unheard before it is dropped (default `CLIENT_SILENCE_MS`). */
  readonly silenceMs?: number;
  /** Added to the hello result. */
  readonly greeting?: Partial<HelloResult>;
}

export function handleSocket(socket: net.Socket, api: ClientApi, context: SocketContext): void {
  socket.setEncoding("utf8");
  const reader = new LineReader();
  const subscriptions = new Map<number, () => void>();
  let greeted = false;
  let lastHeard = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const silenceMs = context.silenceMs ?? CLIENT_SILENCE_MS;
  /** Armed by the first ping: from then on this client has said it will keep being heard from. */
  const watch = (): void => {
    if (watchdog !== null) return;
    watchdog = setInterval(() => {
      if (Date.now() - lastHeard > silenceMs) socket.destroy();
    }, Math.max(10, silenceMs / 3));
    watchdog.unref();
  };

  const send = (message: ServerMessage): void => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  const reply = (id: number, run: () => Promise<unknown> | unknown, settled?: () => void): void => {
    void (async () => {
      try {
        send({ id, result: (await run()) ?? null });
      } catch (cause) {
        send({ id, error: toWireError(cause) });
      } finally {
        settled?.();
      }
    })();
  };

  // Messages are taken in order. Only `hello` holds the line, until it
  // settles: a remote one is checked asynchronously (device tokens are in
  // the keychain), and a request pipelined behind it must not race it and
  // be refused as un-greeted. Every other reply is sent whenever it is ready.
  let queue: Promise<void> = Promise.resolve();

  socket.on("data", (chunk: string) => {
    lastHeard = Date.now();
    for (const line of reader.push(chunk)) {
      const message = parseLine(line);
      queue = queue.then(() => handle(message));
    }
  });

  const handle = (message: Record<string, unknown> | null): Promise<void> | undefined => {
    const id = typeof message?.id === "number" ? message.id : null;
    const method = typeof message?.method === "string" ? message.method : null;
    if (message === null || id === null || method === null) return undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;

    if (method === "hello") {
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      reply(id, async () => {
        if (params.protocol !== PROTOCOL_VERSION) {
          throw new CliError(
            "PROTOCOL_MISMATCH",
            `This moxen server speaks protocol ${PROTOCOL_VERSION}; the client speaks ${String(params.protocol)}. Restart the server so both run the same version.`,
            { details: { server: PROTOCOL_VERSION, client: params.protocol } },
          );
        }
        let admitted: Partial<HelloResult> = context.greeting ?? {};
        if (context.remote) {
          if (!context.admit) throw new CliError("REMOTE_NOT_PAIRED", "This moxen server does not accept remote clients.");
          admitted = await context.admit(params, socket);
        }
        greeted = true;
        const hello: HelloResult = { ...admitted, protocol: PROTOCOL_VERSION, server: "moxen", pid: process.pid };
        return hello;
      }, settle);
      return settled;
    }
    if (!greeted) {
      send({ id, error: toWireError(new CliError("PROTOCOL_HELLO_REQUIRED", "Send hello before any request.")) });
      return undefined;
    }

    switch (method) {
      case "dispatch":
        reply(id, () => api.dispatch(message.params as never));
        break;
      case "query":
        reply(id, () => api.query(message.params as never));
        break;
      case "getConfig":
        reply(id, () => api.getConfig());
        break;
      case "turnDiff":
        reply(id, () => api.turnDiff(String(params.threadId), Number(params.toTurnCount)));
        break;
      case "subscribeShell":
      case "subscribeThread": {
        const options = typeof params.afterSequence === "number" ? { afterSequence: params.afterSequence } : {};
        const onItem = (item: unknown): void => send({ subscription: id, item });
        const onError = (error: unknown): void => send({ subscription: id, error: toWireError(error) });
        // Acknowledge first: an implementation may emit its first frame
        // synchronously, and the client must know the id by then.
        send({ id, result: { subscription: id } });
        try {
          const unsubscribe =
            method === "subscribeShell"
              ? api.subscribeShell(options, onItem, onError)
              : api.subscribeThread(String(params.threadId), options, onItem, onError);
          subscriptions.set(id, unsubscribe);
        } catch (cause) {
          onError(cause);
        }
        break;
      }
      case "unsubscribe": {
        const subscription = Number(params.subscription);
        subscriptions.get(subscription)?.();
        subscriptions.delete(subscription);
        send({ id, result: null });
        break;
      }
      case "ping":
        watch();
        send({ id, result: null });
        break;
      case "shutdown":
        if (context.remote) {
          send({ id, error: toWireError(new CliError("REMOTE_SHUTDOWN_REFUSED", "A remote client cannot stop the moxen server; stop it on its own machine.")) });
          break;
        }
        send({ id, result: null });
        context.shutdown();
        break;
      default:
        send({ id, error: toWireError(new CliError("UNKNOWN_METHOD", `Unknown method ${method}.`)) });
    }
    return undefined;
  };

  socket.once("close", () => {
    if (watchdog !== null) clearInterval(watchdog);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
  socket.on("error", () => undefined);
}
