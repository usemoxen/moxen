/**
 * The pre-restart drain over the server boundary (MXN-377): a stop for a
 * restart lets running turns finish inside the grace window, holds queued
 * and scheduled work in place with its times, and stops whatever is left —
 * or everything at once, when forced — recording why on the turns it
 * stopped. Watched through the same `ClientApi` every client uses.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { describe, expect, it, afterEach, vi } from "vitest";

import { CliError } from "../../core/errors.js";
import { testHarness } from "../../core/testing/harness.js";
import { RESTART_INTERRUPT_REASON, setDraining } from "../../core/threads/drain.js";
import type { TurnDriver, TurnDriverFactories } from "../../core/threads/execute.js";
import { ThreadStore } from "../../core/threads/store.js";
import { createThread, sendTurn } from "../../core/threads/threads.js";
import { DirectConnection } from "../connection.js";
import type { ShellFrame } from "../protocol.js";
import { RemoteConnection } from "../transport/remote.js";
import { serve } from "../transport/serve.js";

// The drain flag is process-wide: no test leaves it on for the next one.
afterEach(() => {
  setDraining(false);
});

/**
 * A driver whose turns park until the test releases them. An abort (what
 * the drain's interrupt does to the running run) rejects the parked wait,
 * exactly like the real drivers.
 */
function parkingDriver(options: { readonly extra?: Partial<TurnDriver> } = {}): { driver: TurnDriver; release: () => void; prompts: string[] } {
  const parked: Array<(outcome: { status: "completed" }) => void> = [];
  const prompts: string[] = [];
  let released = false;
  const driver: TurnDriver = {
    hasSession: () => Effect.succeed(true),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => {
      prompts.push(input.prompt);
      return Effect.succeed({ threadId: input.threadId, turnId: input.prompt });
    },
    interruptTurn: () => Effect.void,
    streamEvents: Stream.never,
    awaitTurn: (threadId, turnId, signal) =>
      new Promise((resolve, reject) => {
        const settle = (outcome: { status: "completed" }): void => {
          resolve({ status: outcome.status, text: "done", usage: null, error: null });
        };
        // `release` may land before the run parks (the runner is still in its
        // pre-turn capture): the release latches, and the late runner
        // settles at once instead of waiting behind a release it missed.
        if (released) {
          settle({ status: "completed" });
          return;
        }
        parked.push(settle);
        if (signal?.aborted === true) {
          parked.pop();
          reject(new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {}));
          return;
        }
        signal?.addEventListener("abort", () => {
          const at = parked.indexOf(settle);
          if (at !== -1) parked.splice(at, 1);
          reject(new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {}));
        }, { once: true });
        void threadId;
      }),
    ...options.extra,
  };
  return {
    driver,
    prompts,
    release: () => {
      released = true;
      parked.shift()?.({ status: "completed" });
    },
  };
}

/** A connection whose one running turn parks, with the drain window the test asks for. */
async function drainingConnection(options: { readonly grace: string }) {
  const { driver, release } = parkingDriver();
  const factories: TurnDriverFactories = { opencode: () => driver };
  const harness = await testHarness({ drivers: factories });
  const connection = new DirectConnection({
    storeRoot: harness.root,
    drivers: harness.drivers,
    drainPollMs: 10,
    config: async () => ({ ...harness.config, restartDrainTimeout: options.grace }),
  });
  const frames: ShellFrame[] = [];
  connection.subscribeShell({}, (frame) => frames.push(frame), () => undefined);
  const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
  return { harness, connection, release, frames, threadId: created.threadId };
}

const drainingEvents = (frames: readonly ShellFrame[]): Array<{ running: number; deadline: string | null }> =>
  frames.flatMap((frame) => {
    if (frame.kind !== "event" || frame.event.type !== "app.server-draining") return [];
    return [frame.event.payload];
  });

describe("a restart drains over the server boundary", () => {
  it("waits for a running turn that finishes, and holds what is queued behind it", async () => {
    const { harness, connection, release, frames, threadId } = await drainingConnection({ grace: "2m" });
    try {
      const queued = await connection.dispatch({ type: "thread.turn.start", threadId, message: { text: "queued behind" }, delivery: "queue" });
      expect(queued.status).toBe("queued");
      const drain = connection.drainForRestart();
      // The drain is on before the test moves on: a new start is refused
      // with a clear draining state while the running turn is still going.
      for (let attempt = 0; connection.draining === null && attempt < 500; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // A fresh start is refused with a clear draining state while the
      // running turn is still going (the busy thread itself says THREAD_BUSY,
      // as always; this one is asked on an idle thread, where the drain is
      // the only thing in the way).
      const idle = await connection.dispatch({ type: "thread.create", scratch: true, title: "fresh" });
      await expect(connection.dispatch({ type: "thread.turn.start", threadId: idle.threadId, message: { text: "during the drain" } })).rejects.toMatchObject({
        code: "SERVER_DRAINING",
      });
      expect(drainingEvents(frames).at(0)).toMatchObject({ running: 1, deadline: expect.any(String) });
      // The running turn finishes inside the window: the drain resolves
      // with it finished, and the queued message never started.
      release();
      expect(await drain).toMatchObject({ finished: 1, interrupted: 0 });
      const rows = await harness.store.readTurns(threadId);
      expect(rows.find((turn) => turn.id === queued.turnId)).toMatchObject({ status: "queued", delivery: "queued" });
      expect(rows.filter((turn) => turn.status === "running")).toHaveLength(0);
      // The gate lifted with the drain: nothing waits behind it.
      expect(connection.draining).toBeNull();
      expect(drainingEvents(frames).at(-1)).toMatchObject({ running: 0, deadline: null });
    } finally {
      release();
      await connection.close();
    }
  });

  it("does not treat a transient ledger read error as zero running turns during a drain", async () => {
    const { harness, connection, release, threadId } = await drainingConnection({ grace: "2m" });
    const origReadTurns = ThreadStore.prototype.readTurns;
    const origThreadVersion = ThreadStore.prototype.threadVersion;
    let versionTick = 0;
    let injectedFailures = 0;
    const versionSpy = vi.spyOn(ThreadStore.prototype, "threadVersion").mockImplementation(async function (this: ThreadStore, id) {
      const base = await origThreadVersion.call(this, id);
      // Poll 1 caches the running turn; polls 2–3 force re-reads that hit EBUSY.
      if (id === threadId && injectedFailures < 2) return `${base}:tick:${++versionTick}`;
      return base;
    });
    const readSpy = vi.spyOn(ThreadStore.prototype, "readTurns").mockImplementation(async function (this: ThreadStore, id, options) {
      if (id === threadId && versionTick > 1 && injectedFailures < 2) {
        injectedFailures += 1;
        const err = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        throw err;
      }
      return await origReadTurns.call(this, id, options);
    });
    try {
      const drain = connection.drainForRestart();
      await vi.waitFor(() => expect(injectedFailures).toBe(2), { timeout: 5_000 });
      // Even after two transient read errors, the drain is still waiting on the running turn.
      expect(connection.draining).not.toBeNull();
      release();
      expect(await drain).toMatchObject({ finished: 1, interrupted: 0 });
      const rows = await harness.store.readTurns(threadId);
      expect(rows.filter((turn) => turn.status === "running")).toHaveLength(0);
    } finally {
      readSpy.mockRestore();
      versionSpy.mockRestore();
      release();
      await connection.close();
    }
  });

  it("stops what outlasts the window, recording why, and never touches waiting rows", async () => {
    const { harness, connection, frames, threadId } = await drainingConnection({ grace: "100ms" });
    try {
      const at = "2030-01-01T00:00:00Z";
      const scheduled = await connection.dispatch({ type: "thread.turn.start", threadId, message: { text: "later" }, scheduledFor: at });
      expect(await connection.drainForRestart()).toMatchObject({ finished: 0, interrupted: 1 });
      const rows = await harness.store.readTurns(threadId);
      const stopped = rows.find((turn) => turn.status === "interrupted");
      expect(stopped?.error).toBe(RESTART_INTERRUPT_REASON);
      // What waited, waits still: its time never moved, its row never ran.
      expect(rows.find((turn) => turn.id === scheduled.turnId)).toMatchObject({ status: "queued", scheduledFor: "2030-01-01T00:00:00.000Z" });
      expect(drainingEvents(frames).at(-1)).toMatchObject({ running: 0, deadline: null });
    } finally {
      await connection.close();
    }
  });

  it("stops everything at once when forced", async () => {
    const { harness, connection, threadId } = await drainingConnection({ grace: "2m" });
    try {
      const startedAt = Date.now();
      expect(await connection.drainForRestart({ force: true })).toMatchObject({ interrupted: 1, finished: 0 });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect((await harness.store.readTurns(threadId)).filter((turn) => turn.status === "running")).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("resolves at once with nothing running", async () => {
    const { connection, harness, threadId } = await drainingConnection({ grace: "2m" });
    let release: (() => void) | null = null;
    void release;
    try {
      // Parked work stopped by hand first: nothing runs.
      const { interruptTurn } = await import("../../core/threads/threads.js");
      await interruptTurn(harness.store, threadId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      expect(await connection.drainForRestart()).toMatchObject({ finished: 0, interrupted: 0 });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await connection.close();
    }
  });

  it("joins an in-flight drain, and a forced request escalates it", async () => {
    const { connection, release } = await drainingConnection({ grace: "2m" });
    try {
      const first = connection.drainForRestart();
      expect(connection.drainForRestart()).toBe(first);
      const joined = await connection.drainForRestart({ force: true });
      expect(joined).toMatchObject({ interrupted: 1 });
      expect(await first).toBe(joined);
      void release;
    } finally {
      await connection.close();
    }
  });
});

// -- findings 1 and 6: the drain's own interrupt stage --------------------------

describe("the interrupt stage holds to its own bounds", () => {
  it("a driver whose interrupt never returns cannot hang the drain", async () => {
    const { driver, prompts } = parkingDriver({ extra: { interruptTurn: () => Effect.never } });
    const harness = await testHarness({ drivers: { opencode: () => driver } as TurnDriverFactories });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      drainPollMs: 10,
      closeDriverTimeoutMs: 200,
      config: async () => ({ ...harness.config, restartDrainTimeout: "100ms" }),
    });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
      await waitUntil(() => Promise.resolve(prompts.includes("one")));
      // The grace expires; interrupts run in parallel, each against the
      // same bound a close pays its drivers, so the stop behind the drain
      // is never hostage to one hung interrupt.
      const settled = await Promise.race([
        connection.drainForRestart(),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve("still draining"), 10_000);
          timer.unref?.();
        }),
      ]);
      expect(settled).toMatchObject({ interrupted: 1 });
      // A repeated, even forced stop joins or retries the bounded drain
      // rather than waiting on the same stuck promise forever.
      await expect(Promise.race([
        connection.drainForRestart({ force: true }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve("still draining"), 10_000);
          timer.unref?.();
        }),
      ])).resolves.not.toBe("still draining");
    } finally {
      await connection.close();
    }
  });

  it("a slow runner cannot spend the queued turn behind an interrupted turn", async () => {
    let slow = false;
    const { driver, prompts } = parkingDriver({ extra: { contextUsage: async () => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 600));
      return null;
    } } });
    const harness = await testHarness({ drivers: { opencode: () => driver } as TurnDriverFactories });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      drainPollMs: 10,
      closeDriverTimeoutMs: 100,
      config: async () => ({ ...harness.config, restartDrainTimeout: "2m" }),
    });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
      await waitUntil(() => Promise.resolve(prompts.includes("one")));
      const queued = await connection.dispatch({ type: "thread.turn.start", threadId: created.threadId, message: { text: "QUEUED-BEHIND" }, delivery: "queue" });
      slow = true;
      await connection.drainForRestart({ force: true });
      // The drain's own interrupt promotes nothing and the gate it set
      // outlasts the aborted runner's bookkeeping: the queued turn stays
      // queued, never sent, while the old runner slowly settles.
      await expect.poll(async () => (await harness.store.readTurns(created.threadId)).length > 1, { timeout: 10_000 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(prompts).toEqual(["one"]);
      expect((await harness.store.readTurns(created.threadId)).find((turn) => turn.id === queued.turnId)).toMatchObject({ status: "queued" });
    } finally {
      await connection.close();
    }
  });
});

// -- finding 7: the real stop route through serve() ------------------------------

describe("the real stop route drains", () => {
  async function servedSetup(options: { readonly grace: string; readonly closeDriverTimeoutMs?: number }) {
    const { driver, prompts, release } = parkingDriver();
    const harness = await testHarness({ drivers: { opencode: () => driver } as TurnDriverFactories });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      drainPollMs: 10,
      ...(options.closeDriverTimeoutMs ? { closeDriverTimeoutMs: options.closeDriverTimeoutMs } : {}),
      config: async () => ({ ...harness.config, restartDrainTimeout: options.grace }),
    });
    const frames: ShellFrame[] = [];
    connection.subscribeShell({}, (frame) => frames.push(frame), () => undefined);
    const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
    await waitUntil(() => Promise.resolve(prompts.includes("one")));
    const queued = await connection.dispatch({ type: "thread.turn.start", threadId: created.threadId, message: { text: "queued behind" }, delivery: "queue" });
    const server = await serve({ endpoint: process.env.MOXEN_SERVER_ENDPOINT!, api: connection, onClose: () => connection.close(), drain: (force) => connection.drainForRestart(force ? { force: true } : {}) });
    const client = await RemoteConnection.connect(process.env.MOXEN_SERVER_ENDPOINT!, { reconnect: false, allowBuildMismatch: true });
    const drains: Array<{ running: number; deadline: string | null }> = [];
    client.subscribeShell({}, (frame) => {
      if (frame.kind === "event" && frame.event.type === "app.server-draining") drains.push(frame.event.payload);
    }, () => undefined);
    return { harness, connection, server, client, frames, drains, release, threadId: created.threadId, queued, prompts };
  }

  it("a forced stop interrupts at once, and only then does it reply and stop", async () => {
    const { harness, server, client, threadId, queued, prompts } = await servedSetup({ grace: "2m" });
    const reply = await client.shutdownServer({ force: true });
    expect(reply).toMatchObject({ interrupted: 1 });
    const rows = await harness.store.readTurns(threadId);
    expect(rows.find((turn) => turn.id !== queued.turnId)).toMatchObject({ status: "interrupted", error: RESTART_INTERRUPT_REASON });
    expect(rows.find((turn) => turn.id === queued.turnId)).toMatchObject({ status: "queued" });
    expect(prompts).toEqual(["one"]);
    await expect(server.closed).resolves.toBeUndefined();
    await client.close();
  });

  it("replies only once the drain has finished, after the turn it waited on", async () => {
    const { harness, server, client, threadId, queued, drains, release } = await servedSetup({ grace: "2m" });
    const reply = client.shutdownServer().catch(() => null);
    // The drain holds the reply: while it waits, nothing has answered yet...
    await expect.poll(() => drains.some((drain) => drain.running === 1), { timeout: 5_000 }).toBe(true);
    const waited = (await harness.store.readTurns(threadId)).find((turn) => turn.id !== queued.turnId);
    expect(waited?.status).toBe("running");
    // ...the running turn finishes inside the window, the answer carries the
    // finished count, and its final drained event is already on the wire.
    release();
    await expect(reply).resolves.toMatchObject({ finished: 1, interrupted: 0 });
    expect(drains.at(-1)).toMatchObject({ running: 0, deadline: null });
    await expect(server.closed).resolves.toBeUndefined();
    await client.close();
  });

  it("a requester that vanishes mid-drain waits the drain as a forced stop", async () => {
    const { harness, server, client, threadId, queued, prompts, drains } = await servedSetup({ grace: "1m" });
    void client.shutdownServer().catch(() => undefined);
    // The stop reached the server and its drain is waiting; that is the
    // moment its requester disappears.
    await expect.poll(() => drains.length > 0, { timeout: 5_000 }).toBe(true);
    await client.close();
    await expect(server.closed).resolves.toBeUndefined();
    const rows = await harness.store.readTurns(threadId);
    expect(rows.find((turn) => turn.id !== queued.turnId)?.status).toBe("interrupted");
    expect(rows.find((turn) => turn.id === queued.turnId)).toMatchObject({ status: "queued" });
    expect(prompts).toEqual(["one"]);
  });
});

// -- small: only what this server runs ------------------------------------------

describe("the drain waits on and stops only what this server runs", () => {
  it("leaves a turn another owner recorded alone", async () => {
    const { driver, prompts, release } = parkingDriver();
    const harness = await testHarness({ drivers: { opencode: () => driver } as TurnDriverFactories });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      drainPollMs: 10,
      config: async () => ({ ...harness.config, restartDrainTimeout: "100ms" }),
    });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
      await waitUntil(() => Promise.resolve(prompts.includes("one")));
      // Its own work settles first: what the drain has left to look at is
      // only the turn some other owner recorded.
      release();
      await waitUntil(async () => (await harness.store.readTurns(created.threadId)).every((turn) => turn.status !== "running"));
      const foreign = await createForeignTurn(harness, "elsewhere");
      const drained = await connection.drainForRestart();
      // This server neither waits on nor stops the other owner's work.
      expect(drained).toMatchObject({ finished: 0, interrupted: 0 });
      const rows = await harness.store.readTurns(foreign);
      expect(rows.find((turn) => turn.status === "running")).toBeDefined();
    } finally {
      await connection.close();
    }
  });
});

/** Wait until the thread's turn is truly parked (the runner reached the driver). */
async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

/** A running turn owned by something else, written beside the connection's own. */
async function createForeignTurn(harness: Awaited<ReturnType<typeof testHarness>>, prompt: string): Promise<string> {
  const foreign = await createThread(harness.store, { projectId: "p", title: "foreign", env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: "opencode", model: "gpt-5.4" } });
  const sent = await sendTurn(harness.store, foreign.id, { prompt });
  await harness.store.updateTurn(foreign.id, sent.turn.id, { owner: { pid: 424_242, host: "some-other-host" } });
  return foreign.id;
}


// -- finding 1: a steer a forced drain must not lose -----------------------------

/**
 * A run that never comes back and cannot be stopped: its wait ignores the
 * abort the drain's interrupt sends, and the interrupt itself never returns
 * — a hung provider, exactly the case the drain's own bounds exist for. The
 * provider also reports the steer it never confirmed reaching the
 * conversation, as a real driver does when its arrival signal says so.
 */
function hungDriver(steer: { id: string }): TurnDriver {
  return {
    hasSession: () => Effect.succeed(true),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: input.prompt }),
    interruptTurn: () => Effect.never,
    streamEvents: Stream.never,
    awaitTurn: () => new Promise(() => undefined),
    takeUnconfirmedSteers: () => (steer.id === "" ? [] : [{ id: steer.id, text: "STEER-ME", images: [] }]),
  };
}

describe("a forced drain keeps a steer its stopped turn never confirmed", () => {
  it("saves the redelivery copy as queued work even when the interrupt hangs", async () => {
    const steer = { id: "" };
    const driver = hungDriver(steer);
    const harness = await testHarness({ drivers: { opencode: () => driver } as TurnDriverFactories });
    const connection = new DirectConnection({
      storeRoot: harness.root,
      drivers: harness.drivers,
      drainPollMs: 10,
      closeDriverTimeoutMs: 200,
      config: async () => ({ ...harness.config, restartDrainTimeout: "2m" }),
    });
    try {
      const created = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "one", threadEnvMode: "local" });
      const steered = await connection.dispatch({ type: "thread.turn.start", threadId: created.threadId, message: { text: "STEER-ME" }, delivery: "steer" });
      expect(steered.delivery).toBe("steered");
      steer.id = steered.messageId;
      expect(await connection.drainForRestart({ force: true })).toMatchObject({ interrupted: 1 });
      const rows = await harness.store.readTurns(created.threadId);
      // The turn is stopped, and the steer it never confirmed is durable
      // queued work of its own: the next server runs it.
      const stopped = rows.find((turn) => turn.status === "interrupted");
      expect(stopped?.error).toBe(RESTART_INTERRUPT_REASON);
      const copy = rows.find((turn) => turn.id !== stopped?.id);
      expect(copy).toMatchObject({ status: "queued" });
      const messages = await harness.store.readMessages(created.threadId);
      expect(messages.some((message) => message.turnId === copy!.id && message.text === "STEER-ME")).toBe(true);
      expect((await harness.store.readActivities(created.threadId)).some((row) => row.kind === "steer.redelivered")).toBe(true);
    } finally {
      await connection.close();
    }
  });
});

// -- finding 4: the drain gate belongs to the server that set it -----------------

describe("the drain gate belongs to its own connection", () => {
  it("closing another connection in the same process leaves the drain standing", async () => {
    const { release, frames, harness, connection } = await drainingConnection({ grace: "2m" });
    // A second server in this process, with its own store, that never drains:
    // closing it must not take the first one's gate down with it.
    const bystander = new DirectConnection({ storeRoot: `${harness.root}-bystander`, drivers: harness.drivers, config: async () => harness.config });
    try {
      const idle = await connection.dispatch({ type: "thread.create", scratch: true, title: "fresh" });
      const drain = connection.drainForRestart();
      await expect.poll(() => connection.draining !== null, { timeout: 5_000 }).toBe(true);
      await bystander.close();
      // Still draining: a fresh start on the running server is refused, and
      // its queued work is still held rather than released.
      await expect(connection.dispatch({ type: "thread.turn.start", threadId: idle.threadId, message: { text: "during the drain" } })).rejects.toMatchObject({
        code: "SERVER_DRAINING",
      });
      expect(connection.draining).not.toBeNull();
      expect(frames.length).toBeGreaterThan(0);
      release();
      expect(await drain).toMatchObject({ finished: 1, interrupted: 0 });
    } finally {
      release();
      await connection.close();
    }
  });
});
