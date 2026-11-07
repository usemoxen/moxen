import { rm } from "node:fs/promises";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startEmbeddingsHeartbeat } from "../embeddingsHeartbeat.js";
import { testEndpoint } from "../transport/tests/endpoint.js";
import { RemoteConnection } from "../transport/remote.js";
import { encode, LineReader, PROTOCOL_VERSION } from "../transport/wire.js";

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
 * A server that completes the hello and then either holds every query open
 * (`answerQueries: false` — a poll is guaranteed in flight whenever one was
 * sent) or answers status polls with a fresh file each time.
 */
async function fakeStatusServer(answerQueries: boolean): Promise<{
  endpoint: string;
  waitForQuery: () => Promise<void>;
}> {
  const endpoint = testEndpoint();
  let seen = 0;
  let markSeen!: () => void;
  const firstQuery = new Promise<void>((resolve) => { markSeen = resolve; });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    const reader = new LineReader();
    socket.on("data", (chunk: string) => {
      for (const line of reader.push(chunk)) {
        const message = JSON.parse(line) as { id: number; method: string; params?: { build?: unknown; buildDisplay?: unknown } };
        if (message.method === "hello") {
          // Echo the client's build back: this fake stands in for any
          // server, and the test's subject is the heartbeat, not the
          // handshake (a real mismatch would be BUILD_MISMATCH).
          socket.write(encode({ id: message.id, result: { protocol: PROTOCOL_VERSION, server: "moxen", pid: 1, build: message.params?.build, buildDisplay: message.params?.buildDisplay } }));
        } else if (message.method === "query") {
          seen += 1;
          markSeen();
          if (answerQueries) {
            socket.write(encode({ id: message.id, result: { state: "loading", file: `file-${seen}` } }));
          }
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
  return { endpoint, waitForQuery: () => firstQuery };
}

describe("embeddings heartbeat", () => {
  it("ignores a poll parked at close instead of failing the process unhandled", async () => {
    // MXN-320: the verification script stops its heartbeat timer before
    // close(), but a poll already in flight rejects with
    // SERVER_DISCONNECTED there. Without a rejection handler that rejection
    // escapes the fire-and-forget chain and Bun exits 1 after every
    // validation passed.
    const server = await fakeStatusServer(false);
    const client = await RemoteConnection.connect(server.endpoint);
    teardown.push(() => client.close());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const progress: string[] = [];
      const heartbeat = startEmbeddingsHeartbeat(
        () => client.query({ type: "memory.embeddings.status" }),
        (update) => progress.push(update),
      );
      try {
        await server.waitForQuery();
        // Like the script's finally: no new polls, while the last one is
        // still parked on the connection.
        heartbeat.stop();
        await client.close();
        await waitFor("the parked poll to settle", () => heartbeat.pending === 0);
        // The rejection (if it escaped) is already settled; drain the loop
        // so an unhandled rejection would have surfaced by the assert.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        heartbeat.stop();
      }
      expect(progress).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("counts completed polls and reports progress changes", async () => {
    // The teardown tolerance must not neuter the heartbeat: successful polls
    // still feed the beats and latency counters the script asserts on.
    const server = await fakeStatusServer(true);
    const client = await RemoteConnection.connect(server.endpoint);
    teardown.push(() => client.close());
    const progress: string[] = [];
    const heartbeat = startEmbeddingsHeartbeat(
      () => client.query({ type: "memory.embeddings.status" }),
      (update) => progress.push(update),
      10,
    );
    try {
      await waitFor("completed polls", () => heartbeat.beats >= 2);
      expect(heartbeat.maxHeartbeatMs).toBeLessThan(1000);
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expect(new Set(progress).size).toBe(progress.length);
    } finally {
      heartbeat.stop();
    }
    await waitFor("the last poll to settle", () => heartbeat.pending === 0);
  });
});
