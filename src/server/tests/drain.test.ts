/**
 * The pre-restart drain over the server boundary (MXN-377): a stop for a
 * restart lets running turns finish inside the grace window, holds queued
 * and scheduled work in place with its times, and stops whatever is left —
 * or everything at once, when forced — recording why on the turns it
 * stopped. Watched through the same `ClientApi` every client uses.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { describe, expect, it } from "vitest";

import { CliError } from "../../core/errors.js";
import { testHarness } from "../../core/testing/harness.js";
import { RESTART_INTERRUPT_REASON } from "../../core/threads/drain.js";
import type { TurnDriver, TurnDriverFactories } from "../../core/threads/execute.js";
import { DirectConnection } from "../connection.js";
import type { ShellFrame } from "../protocol.js";

/**
 * A driver whose turns park until the test releases them. An abort (what
 * the drain's interrupt does to the running run) rejects the parked wait,
 * exactly like the real drivers.
 */
function parkingDriver(): { driver: TurnDriver; release: () => void } {
  const parked: Array<(outcome: { status: "completed" }) => void> = [];
  let released = false;
  const driver: TurnDriver = {
    hasSession: () => Effect.succeed(true),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: input.prompt }),
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
  };
  return {
    driver,
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
      expect(Date.now() - startedAt).toBeLessThan(2_000);
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
      expect(Date.now() - startedAt).toBeLessThan(500);
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
