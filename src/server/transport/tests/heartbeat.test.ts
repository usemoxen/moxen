import { rm } from "node:fs/promises";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../../../core/errors.js";
import type { ClientApi } from "../../api.js";
import { RemoteConnection, type LinkState } from "../remote.js";
import { handleSocket } from "../serve.js";
import { encode, LineReader, PROTOCOL_VERSION } from "../wire.js";
import { testEndpoint } from "./endpoint.js";

const teardown: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined);
});

async function waitFor(label: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A server that answers hello, ping and subscribeShell while `muted` is
 * false, and says nothing at all while it is true — a frozen process whose
 * sockets stay open.
 */
async function fakeServer(): Promise<{ endpoint: string; muted: boolean; connections: number }> {
  const endpoint = testEndpoint();
  const state = { endpoint, muted: false, connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    const reader = new LineReader();
    socket.on("data", (chunk: string) => {
      for (const line of reader.push(chunk)) {
        if (state.muted) continue;
        const message = JSON.parse(line) as { id: number; method: string };
        if (message.method === "hello") socket.write(encode({ id: message.id, result: { protocol: PROTOCOL_VERSION, server: "moxen", pid: 1 } }));
        else if (message.method === "ping") socket.write(encode({ id: message.id, result: null }));
        else if (message.method === "subscribeShell") {
          socket.write(encode({ id: message.id, result: { subscription: message.id } }));
          socket.write(encode({ subscription: message.id, item: { kind: "snapshot" } }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  teardown.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") await rm(endpoint, { force: true });
  });
  return state;
}

const FAST = { heartbeat: { intervalMs: 100, timeoutMs: 300 }, connectTimeoutMs: 300 } as const;

describe("heartbeat", () => {
  it("drops a server that stops answering, fails what was in flight, and reconnects once it answers again", async () => {
    const server = await fakeServer();
    const client = await RemoteConnection.connect(server.endpoint, FAST);
    teardown.push(() => client.close());
    const states: LinkState[] = [];
    client.onLinkState((state) => states.push(state));
    const items: unknown[] = [];
    client.subscribeShell({}, (item) => items.push(item), () => undefined);
    await waitFor("the snapshot", () => items.length === 1);

    server.muted = true;
    const inFlight = client.getConfig().catch((error: unknown) => error);
    await waitFor("reconnecting", () => client.linkState.status === "reconnecting");
    const error = await inFlight;
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("SERVER_DISCONNECTED");
    expect((error as CliError).message).toMatch(/stopped answering \(no reply for/);

    // Muted, every attempt connects but gets no hello back: it keeps counting.
    await waitFor("a failed attempt", () => client.linkState.status === "reconnecting" && client.linkState.attempts >= 1);

    server.muted = false;
    await waitFor("connected again", () => client.linkState.status === "connected");
    await waitFor("a fresh snapshot", () => items.length === 2);
    expect(states[0]).toMatchObject({ status: "reconnecting" });
    expect(states.at(-1)).toEqual({ status: "connected" });
  });

  it("keeps a quiet but live server: pings it rather than dropping it", async () => {
    const server = await fakeServer();
    const client = await RemoteConnection.connect(server.endpoint, FAST);
    teardown.push(() => client.close());
    client.subscribeShell({}, () => undefined, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(client.linkState).toEqual({ status: "connected" });
    expect(server.connections).toBe(1);
  });

  it("gives up on a server that accepts the connection but never says hello", async () => {
    const server = await fakeServer();
    server.muted = true;
    const started = Date.now();
    const error = await RemoteConnection.connect(server.endpoint, FAST).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("SERVER_UNAVAILABLE");
    expect((error as CliError).message).toMatch(/did not answer within/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("server side", () => {
  async function socketPair(silenceMs: number): Promise<{ client: net.Socket; closed: () => boolean }> {
    const endpoint = testEndpoint();
    let closed = false;
    const server = net.createServer((socket) => {
      handleSocket(socket, {} as ClientApi, { remote: false, shutdown: () => undefined, silenceMs });
      socket.once("close", () => {
        closed = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    const client = net.connect(endpoint);
    client.on("error", () => undefined);
    await new Promise((resolve) => client.once("connect", resolve));
    teardown.push(async () => {
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== "win32") await rm(endpoint, { force: true });
    });
    return { client, closed: () => closed };
  }

  it("closes a client that pinged and then went silent", async () => {
    const { client, closed } = await socketPair(150);
    client.write(encode({ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION } }));
    client.write(encode({ id: 2, method: "ping" }));
    await waitFor("the server to drop it", closed, 2_000);
  });

  it("never times out a client that does not ping", async () => {
    const { client, closed } = await socketPair(150);
    client.write(encode({ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION } }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(closed()).toBe(false);
  });
});
