/**
 * The pre-restart drain (MXN-377): while the shared server drains for a
 * restart, nothing new starts — sends that would run now are refused,
 * admission admits nothing — and what waits keeps its place and its times,
 * so the next server runs it. Pinned here at the core paths the drain gates.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliConfig } from "../../types.js";
import { openThreadStore, type ThreadStore } from "../store.js";
import { createThread, sendTurn } from "../threads.js";
import { executeTurn, type TurnDriver } from "../execute.js";
import { runDueScheduledTurn, type OperationContext } from "../operations.js";
import { isDraining, setDraining } from "../drain.js";
import { settleRuns } from "../../testing/turns.js";
import { rmTempAsync } from "../../testing/tmp.js";
import type { QueuePolicy } from "../queue.js";

const MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" } as const;
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  // The drain flag is process-wide: no test leaves it on for the next one.
  setDraining(false);
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-drain-"));
  cleanup.push(() => rmTempAsync(root));
  const store = await openThreadStore(root);
  const thread = await createThread(store, {
    projectId: "p",
    title: "Drain",
    modelSelection: { ...MODEL },
    env: { mode: "local", path: root, branch: null },
  });
  return { store, thread, root };
}

/** A driver that records what it was asked to run, and finishes at once. */
function driver(sent: string[]): TurnDriver {
  return {
    hasSession: () => Effect.succeed(true),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => {
      sent.push(input.prompt);
      return Effect.succeed({ threadId: input.threadId, turnId: `native-${sent.length}` });
    },
    interruptTurn: () => Effect.void,
    streamEvents: Stream.never,
    awaitTurn: async () => ({ status: "completed" as const, text: "done", usage: null, error: null }),
  };
}

function context(store: ThreadStore, root: string, turnDriver: TurnDriver): OperationContext {
  return { store, storeRoot: root, config: {} as CliConfig, driverFor: () => turnDriver };
}

const queuePolicy = (): QueuePolicy => ({ conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread" });

describe("a drain refuses what would start", () => {
  it("refuses a fresh send with a draining state, and takes sends again once it lifts", async () => {
    const { store, thread } = await setup();
    setDraining(true);
    expect(isDraining()).toBe(true);
    await expect(sendTurn(store, thread.id, { prompt: "during the drain" })).rejects.toMatchObject({
      code: "SERVER_DRAINING",
      message: expect.stringContaining("restarting"),
    });
    // Nothing was written: the refused send leaves no turn behind.
    expect((await store.readTurns(thread.id)).map((turn) => turn.status)).toEqual([]);
    setDraining(false);
    const after = await sendTurn(store, thread.id, { prompt: "after the drain" });
    expect(after.turn.status).toBe("running");
  });

  it("keeps waiting sends durable, with their times untouched", async () => {
    const { store, thread, root } = await setup();
    setDraining(true);
    const at = "2030-01-01T00:00:00Z";
    const scheduled = await sendTurn(store, thread.id, { prompt: "scheduled during the drain", scheduledFor: at });
    expect(scheduled.turn).toMatchObject({ status: "queued", scheduledFor: "2030-01-01T00:00:00.000Z", scheduleReason: "user" });
    // Admission admits nothing while the drain lasts: a queue entry that
    // would run now waits too, exactly as it was.
    const entry = await sendTurn(store, thread.id, { prompt: "queued during the drain", queue: { ...queuePolicy(), requestId: "drain:entry" } });
    expect(entry.turn).toMatchObject({ status: "queued" });
    const sent: string[] = [];
    expect(await runDueScheduledTurn(context(store, root, driver(sent)), thread.id, Date.now())).toBe(false);
    expect(sent).toEqual([]);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === scheduled.turn.id)).toMatchObject({
      status: "queued",
      scheduledFor: "2030-01-01T00:00:00.000Z",
    });
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === entry.turn.id)).toMatchObject({ status: "queued" });
  });

  it("still lets a steer reach the running turn, which the drain lets finish", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    expect(first.turn.status).toBe("running");
    setDraining(true);
    const steered = await sendTurn(store, thread.id, { prompt: "a mid-turn note", delivery: "steer" });
    expect(steered.delivery).toBe("steered");
    expect(steered.turn.id).toBe(first.turn.id);
  });
});

describe("a drain holds what a settle would promote", () => {
  it("requeues the promotion a settle would run instead of starting it", async () => {
    const { store, thread, root } = await setup();
    const sent: string[] = [];
    const turnDriver = driver(sent);
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    const behind = await sendTurn(store, thread.id, { prompt: "queued behind", delivery: "queue" });
    expect(behind.turn).toMatchObject({ status: "queued", delivery: "queued" });
    setDraining(true);
    await executeTurn({ store, driver: turnDriver, threadId: thread.id, storeTurnId: first.turn.id, prompt: "first" });
    // The settling turn finished, and only it was ever sent: the promotion
    // went back to the queue, held for the admission path, message and all.
    expect(sent).toEqual(["first"]);
    const held = (await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id);
    expect(held).toMatchObject({ status: "queued", heldAtSettle: true });
    // Once the drain lifts, admission runs exactly what it held.
    setDraining(false);
    expect(await runDueScheduledTurn(context(store, root, turnDriver), thread.id, Date.now())).toBe(true);
    await settleRuns();
    expect(sent).toEqual(["first", "queued behind"]);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id)?.status).toBe("completed");
  });
});
