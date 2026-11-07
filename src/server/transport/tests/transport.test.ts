import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfigPath } from "../../../core/config.js";
import { buildIdOf, buildIdentity } from "../../../core/build.js";
import { CliError } from "../../../core/errors.js";
import { testHarness, type TestHarness } from "../../../core/testing/harness.js";
import type { ClientApi, ShellFrame } from "../../api.js";
import { openClient } from "../../client.js";
import { DirectConnection } from "../../connection.js";
import { probe } from "../endpoint.js";
import { RemoteConnection } from "../remote.js";
import { serve, type ServerHandle } from "../serve.js";
import { encode, LineReader, PROTOCOL_VERSION } from "../wire.js";
import { testEndpoint } from "./endpoint.js";

const teardown: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step().catch(() => undefined);
});

async function served(harness: TestHarness, endpoint = testEndpoint()): Promise<ServerHandle> {
  const api = new DirectConnection({
    storeRoot: harness.root,
    drivers: harness.drivers,
    config: async () => harness.config,
    shellPollMs: 50,
  });
  // Says which config it runs on, as `runServer` does: the harness's.
  const handle = await serve({ endpoint, api, onClose: () => api.close(), greeting: { configPath: defaultConfigPath() } });
  teardown.push(() => handle.close());
  return handle;
}

async function connected(endpoint: string): Promise<RemoteConnection> {
  const connection = await RemoteConnection.connect(endpoint);
  teardown.push(() => connection.close());
  return connection;
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One raw request on a fresh socket, for the handshake rules. */
async function raw(endpoint: string, lines: object[]): Promise<Array<Record<string, unknown>>> {
  const socket = net.connect(endpoint);
  socket.setEncoding("utf8");
  const reader = new LineReader();
  const replies: Array<Record<string, unknown>> = [];
  socket.on("data", (chunk: string) => {
    for (const line of reader.push(chunk)) replies.push(JSON.parse(line) as Record<string, unknown>);
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  for (const line of lines) socket.write(encode(line as never));
  await waitFor("replies", () => replies.length >= lines.length);
  socket.destroy();
  return replies;
}

describe("transport", () => {
  it("carries thread-scoped proposal subscriptions and user answers without starting a run on a model suggestion", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    const client = await connected(handle.endpoint);
    const parent = await client.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Parent", wait: true, threadEnvMode: "local" });
    const frames: ShellFrame[] = [];
    const unsubscribe = client.subscribeShell({ researchProposals: [parent.threadId] }, (frame) => frames.push(frame), () => {});
    await waitFor("subscription", () => frames.some((frame) => frame.kind === "synchronized"));
    try {
      const pending = client.dispatch({ type: "thread.delegate", parentThreadId: parent.threadId, task: "Check claims", interactionMode: "research", researchProposal: { size: { researchers: 8, critics: 3 } }, wait: true });
      await waitFor("proposal snapshot", () => frames.some((frame) => frame.kind === "snapshot" && frame.snapshot.researchProposals?.length === 1));
      const [proposal] = await client.query({ type: "research.proposals", threadId: parent.threadId });
      expect(await client.query({ type: "research.run", threadId: parent.threadId })).toBeNull();
      await client.dispatch({ type: "research.proposal.answer", proposalId: proposal!.id, choice: "start", plan: { size: { researchers: 1, critics: 1 } } });
      const delegated = await pending;
      expect(await client.query({ type: "research.run", threadId: delegated.child.id })).toMatchObject({ size: { researchers: 1, critics: 1 } });
    } finally { unsubscribe(); }
  });

  it("carries commands, queries and errors — code, details and exit code intact", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    const client = await connected(handle.endpoint);
    expect(client.helloResult).toMatchObject({ protocol: PROTOCOL_VERSION, server: "moxen", pid: process.pid });

    const ensured = await client.dispatch({ type: "project.ensure", cwd: harness.work });
    expect(ensured.created).toBe(true);
    expect((await client.query({ type: "projects.list" })).projects.map((project) => project.id)).toEqual([
      ensured.project.id,
    ]);

    const error = await client.query({ type: "thread.inspect", threadId: "missing" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "THREAD_NOT_FOUND", exitCode: 3, details: { threadId: "missing" } });
  });

  it("requires the handshake, and refuses a client speaking another protocol", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    const [early] = await raw(handle.endpoint, [{ id: 1, method: "query", params: { type: "projects.list" } }]);
    expect(early).toMatchObject({ id: 1, error: { code: "PROTOCOL_HELLO_REQUIRED" } });
    const [mismatch] = await raw(handle.endpoint, [{ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION + 1 } }]);
    expect(mismatch).toMatchObject({ id: 1, error: { code: "PROTOCOL_MISMATCH" } });
  });

  it("allows one server per endpoint", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    await expect(served(harness, handle.endpoint)).rejects.toMatchObject({ code: "SERVER_RUNNING" });
  });

  it("stops an in-flight query when its socket goes away", async () => {
    let entered!: () => void;
    const enteredQuery = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let stopped = false;
    // A wait that only ends when its socket does: the point is the server
    // passing the socket's lifetime in, not what the wait does.
    const api = {
      query: async (_query: unknown, options?: { signal?: AbortSignal }) => {
        entered();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            stopped = true;
            resolve();
          }, { once: true });
        });
        return null;
      },
    } as unknown as ClientApi;
    const handle = await serve({ endpoint: testEndpoint(), api });
    teardown.push(() => handle.close());
    const socket = net.connect(handle.endpoint);
    socket.setEncoding("utf8");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(encode({ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION, build: buildIdentity().id, buildDisplay: buildIdentity().display } } as never));
    socket.write(encode({ id: 2, method: "query", params: { type: "projects.list" } } as never));
    await enteredQuery;
    socket.destroy();
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the in-flight query survived the disconnect")), 5000),
    );
    await Promise.race([waitFor("the server-side wait to stop", () => stopped), deadline]);
  });

  it("resumes subscriptions after the server restarts, from a fresh snapshot", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const first = await served(harness, endpoint);
    const client = await connected(endpoint);
    const frames: ShellFrame[] = [];
    const unsubscribe = client.subscribeShell({}, (frame) => frames.push(frame), () => undefined);
    teardown.push(async () => unsubscribe());
    await waitFor("the first snapshot", () => frames.some((frame) => frame.kind === "snapshot"));

    // Work in flight when the server dies fails loudly rather than hanging.
    await client.dispatch({ type: "project.ensure", cwd: harness.work });
    await first.close();
    await expect(client.query({ type: "projects.list" })).rejects.toMatchObject({ code: "SERVER_DISCONNECTED" });

    const seen = frames.length;
    await served(harness, endpoint);
    await waitFor("a snapshot from the restarted server", () =>
      frames.slice(seen).some((frame) => frame.kind === "snapshot" && frame.snapshot.projects.length === 1),
    );
    expect((await client.query({ type: "projects.list" })).projects).toHaveLength(1);
  });

  it("uses this machine's server by default; in-process only when asked in code", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    await served(harness, endpoint);
    const shared = await openClient({ endpoint });
    teardown.push(() => shared.close());
    expect(shared).toBeInstanceOf(RemoteConnection);
    const forced = await openClient({ mode: "direct", endpoint, config: harness.config });
    teardown.push(() => forced.close());
    expect(forced).toBeInstanceOf(DirectConnection);

    const previous = process.env.MOXEN_SERVER;
    process.env.MOXEN_SERVER = "direct";
    try {
      const refused = await openClient({ endpoint }).catch((error: unknown) => error);
      expect((refused as CliError).code).toBe("SERVER_MODE_REMOVED");
    } finally {
      if (previous === undefined) delete process.env.MOXEN_SERVER;
      else process.env.MOXEN_SERVER = previous;
    }
  });

  it("refuses a running server on another config than the one asked for", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const handle = await serve({ endpoint, api, onClose: () => api.close(), greeting: { configPath: "/elsewhere/config.json" } });
    teardown.push(() => handle.close());
    // The harness sets MOXEN_CONFIG, as `--config` does.
    const refused = await openClient({ endpoint }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).code).toBe("SERVER_CONFIG_MISMATCH");
    expect((refused as CliError).message).toContain("/elsewhere/config.json");
  });

  it("takes a running server on the same config file however its path is spelled", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const wanted = defaultConfigPath();
    // `dir/./config.json`, and on Windows, where case does not matter, upper-cased too.
    const spelled = `${path.dirname(wanted)}${path.sep}.${path.sep}${path.basename(wanted)}`;
    const reported = process.platform === "win32" ? spelled.toUpperCase() : spelled;
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const handle = await serve({ endpoint, api, onClose: () => api.close(), greeting: { configPath: reported } });
    teardown.push(() => handle.close());
    const client = await openClient({ endpoint });
    teardown.push(() => client.close());
    expect(client).toBeInstanceOf(RemoteConnection);
  });

  it("starts a detached server on demand and can stop it", async () => {
    // The spawned server inherits this test's store and (absent) config
    // through the harness environment, so it touches nothing real.
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const client = await openClient({ mode: "daemon", endpoint });
    expect(client).toBeInstanceOf(RemoteConnection);
    const remote = client as RemoteConnection;
    expect(remote.helloResult?.pid).not.toBe(process.pid);
    const ensured = await remote.dispatch({ type: "project.ensure", cwd: harness.work });
    expect(ensured.project.workspaceRoot.length).toBeGreaterThan(0);

    await remote.shutdownServer();
    await remote.close();
    await waitFor("the server to stop", async () => !(await probe(endpoint)));
  }, 30_000);
});

describe("build identity", () => {
  const otherBuild = () => buildIdOf({ kind: "source", version: buildIdentity().version, revision: "f".repeat(40) });

  it("greets with the server's build", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    const client = await connected(handle.endpoint);
    const own = buildIdentity();
    expect(client.helloResult).toMatchObject({ build: own.id, buildDisplay: own.display });
  });

  it("greets a local hello from another build only to refuse it, naming both builds", async () => {
    const harness = await testHarness();
    const handle = await served(harness);
    const own = buildIdentity();
    // Without a build (an older client) the hello is still greeted — with
    // the server's build — so stopping the old server keeps working; the
    // client itself refuses on the comparison.
    const [missing] = await raw(handle.endpoint, [{ id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION } }]);
    expect(missing).toMatchObject({ id: 1, result: { build: own.id, buildDisplay: own.display } });
    // From another build: greeted, then every request but `shutdown` is
    // refused with the mismatch, naming both builds and what to do next.
    const other = otherBuild();
    const [greeted, refused, stopped] = await raw(handle.endpoint, [
      { id: 1, method: "hello", params: { protocol: PROTOCOL_VERSION, build: other.id, buildDisplay: other.display } },
      { id: 2, method: "query", params: { type: "projects.list" } },
      { id: 3, method: "shutdown" },
    ]);
    expect(greeted).toMatchObject({ id: 1, result: { build: own.id } });
    expect(refused).toMatchObject({ id: 2, error: { code: "BUILD_MISMATCH" } });
    const message = ((refused as Record<string, unknown>).error as { message: string }).message;
    expect(message).toContain(own.display);
    expect(message).toContain(other.display);
    expect(message).toContain("moxen server stop");
    // ...except stopping it, which is how the person fixes it.
    expect(stopped).toMatchObject({ id: 3, result: null });
    await waitFor("the server to stop", async () => !(await probe(handle.endpoint)));
  });

  it("a new client refuses an old server that reports no build", async () => {
    const endpoint = testEndpoint();
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      const reader = new LineReader();
      socket.on("data", (chunk: string) => {
        for (const line of reader.push(chunk)) {
          const message = JSON.parse(line) as { id: number; method: string };
          if (message.method === "hello") {
            socket.write(encode({ id: message.id, result: { protocol: PROTOCOL_VERSION, server: "moxen", pid: 1 } }));
          }
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    teardown.push(async () => {
      await new Promise((resolve) => server.close(resolve));
    });
    const error = await RemoteConnection.connect(endpoint, { reconnect: false }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "BUILD_MISMATCH" });
    expect((error as CliError).message).toContain(buildIdentity().display);
  });

  it("reconnects recheck the build and stop on a mismatch", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const first = await served(harness, endpoint);
    const client = await connected(endpoint);
    const failures: unknown[] = [];
    const items: unknown[] = [];
    client.subscribeShell(
      {},
      (item) => items.push(item),
      (cause) => failures.push(cause),
    );
    // Let the subscription establish: closing mid-ack would fail its own
    // resubscribe with SERVER_DISCONNECTED, which is not what this pins.
    await waitFor("the subscription", () => items.length > 0);
    await first.close();

    const other = otherBuild();
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const second = await serve({
      endpoint,
      api,
      onClose: () => api.close(),
      greeting: { configPath: defaultConfigPath(), build: other.id, buildDisplay: other.display },
    });
    teardown.push(() => second.close());

    await waitFor("a failed link", () => client.linkState.status === "failed");
    expect(client.linkState).toMatchObject({ status: "failed", code: "BUILD_MISMATCH" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "BUILD_MISMATCH" });
  });

  it("openClient refuses a running server from another build without stopping it", async () => {
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const other = otherBuild();
    const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    const handle = await serve({
      endpoint,
      api,
      onClose: () => api.close(),
      greeting: { configPath: defaultConfigPath(), build: other.id, buildDisplay: other.display },
    });
    teardown.push(() => handle.close());
    const error = await openClient({ endpoint }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "BUILD_MISMATCH" });
    expect((error as CliError).message).toContain(other.display);
    // The running server is left alone: stopping it is the person's call.
    expect(await probe(endpoint)).toBe(true);
  });
});

describe("store ownership across processes", () => {
  it("refuses a second server on one store, and takes over once it stops", async () => {
    // A real server process, owning the harness store from another pid.
    const harness = await testHarness();
    const endpoint = testEndpoint();
    const client = await openClient({ mode: "daemon", endpoint });
    const remote = client as RemoteConnection;
    try {
      expect(remote.helloResult?.pid).not.toBe(process.pid);
      const lock = JSON.parse(await readFile(path.join(harness.root, "server.lock"), "utf8")) as { pid: number };
      expect(lock.pid).toBe(remote.helloResult?.pid);
      // The same store from this process is refused while that server lives.
      const api = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
      try {
        const refused = await api.claimStore().catch((cause: unknown) => cause);
        expect(refused).toBeInstanceOf(CliError);
        expect(refused).toMatchObject({ code: "STORE_OWNED" });
        expect((refused as CliError).message).toContain(`process ${remote.helloResult?.pid}`);
      } finally {
        await api.close();
      }
      await remote.shutdownServer();
      await remote.close();
      await waitFor("the server to stop", async () => !(await probe(endpoint)));
      // The shutdown reply goes out before the server releases its lock, so
      // the lock may briefly outlive the socket: wait for the takeover.
      const next = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
      try {
        await waitFor("the store lock to release", async () =>
          next
            .claimStore()
            .then(() => true)
            .catch(() => false),
        );
      } finally {
        await next.close();
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});
