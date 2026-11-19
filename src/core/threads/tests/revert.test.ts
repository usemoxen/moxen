import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import type { TurnDriver } from "../execute.js";
import { prepareQueuedHandoff, revertThread, type OperationContext } from "../operations.js";
import { parseQueuePolicy } from "../queue.js";
import { completeTurn, createThread, interruptTurn, promoteDueScheduledTurn, sendTurn } from "../threads.js";

/**
 * MXN-374: turns are numbered in the order they ran. Revert has to cut the
 * ledger by that numbering too, or it drops the wrong turn.
 */
async function world() {
  const harness = await testHarness();
  const rollbacks: Array<{ threadId: string; numTurns: number }> = [];
  const driver: TurnDriver = {
    hasSession: () => Effect.succeed(false),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "native-1" }),
    interruptTurn: () => Effect.void,
    awaitTurn: async () => ({ status: "completed", text: "", usage: null, error: null }),
    streamEvents: Stream.never,
    rollbackThread: (threadId, numTurns) => Effect.sync(() => { rollbacks.push({ threadId, numTurns }); }),
    resumeCursor: () => null,
  };
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: harness.config, driverFor: () => driver };
  const thread = await createThread(harness.store, {
    projectId: "p",
    title: "Revert",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    env: { mode: "local", path: harness.work, branch: null },
  });
  // A provider handle makes the revert roll the provider back without a live session.
  await harness.store.writeThreadRecord({ ...thread, providerSessions: { codex: "cursor-1" } });
  return { ...harness, ctx, thread, rollbacks };
}

describe("revertThread numbering", () => {
  it("cuts by when turns ran, not by where their rows were queued", async () => {
    const w = await world();
    const first = (await sendTurn(w.store, w.thread.id, { prompt: "first" })).turn;
    await completeTurn(w.store, w.thread.id, first.id, { text: "one" });

    // Queued before the second turn that ran, promoted after it.
    const waiting = (await sendTurn(w.store, w.thread.id, { prompt: "waiting", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })).turn;
    const second = (await sendTurn(w.store, w.thread.id, { prompt: "second" })).turn;
    await completeTurn(w.store, w.thread.id, second.id, { text: "two" });
    // A steer on the second turn: two prompts the provider saw there.
    await w.store.appendLedger(w.thread.id, "messages", {
      id: "steer-1",
      threadId: w.thread.id,
      turnId: second.id,
      role: "user",
      text: "and also",
      createdAt: w.store.nowIso(),
    });
    await w.store.updateTurn(w.thread.id, waiting.id, { scheduledFor: new Date(Date.now() - 1000).toISOString() });
    expect((await promoteDueScheduledTurn(w.store, w.thread.id))?.id).toBe(waiting.id);
    await completeTurn(w.store, w.thread.id, waiting.id, { text: "late" });

    // Rows are first, waiting, second; run order is first, second, waiting.
    const reverted = await revertThread(w.ctx, w.thread.id, 2);
    expect(reverted).toMatchObject({ keptTurns: 2, removedTurns: 1, providers: ["codex"] });
    // Only the waiting turn is dropped, and only its prompt is rolled back.
    expect(w.rollbacks).toEqual([{ threadId: w.thread.id, numTurns: 1 }]);
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.id)).toEqual([first.id, second.id]);
    expect((await w.store.readMessages(w.thread.id)).some((message) => message.turnId === waiting.id)).toBe(false);
    expect((await w.store.readMessages(w.thread.id)).some((message) => message.id === "steer-1")).toBe(true);
    expect((await w.store.readActivities(w.thread.id)).some((row) => row.turnId === waiting.id)).toBe(false);
  });

  it("leaves a cancelled-before-start message in the ledger and does not count it as a dropped turn", async () => {
    const w = await world();
    const first = (await sendTurn(w.store, w.thread.id, { prompt: "first" })).turn;
    await completeTurn(w.store, w.thread.id, first.id, { text: "one" });

    const cancelled = (await sendTurn(w.store, w.thread.id, { prompt: "never ran", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })).turn;
    await interruptTurn(w.store, w.thread.id, cancelled.id);
    const second = (await sendTurn(w.store, w.thread.id, { prompt: "second" })).turn;
    await completeTurn(w.store, w.thread.id, second.id, { text: "two" });

    // Rows are first, cancelled, second; only first and second ran.
    const reverted = await revertThread(w.ctx, w.thread.id, 1);
    expect(reverted).toMatchObject({ keptTurns: 1, removedTurns: 1, providers: ["codex"] });
    expect(w.rollbacks).toEqual([{ threadId: w.thread.id, numTurns: 1 }]);
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.id)).toEqual([first.id, cancelled.id]);
    expect((await w.store.readTurns(w.thread.id)).find((turn) => turn.id === cancelled.id)?.status).toBe("interrupted");
    expect((await w.store.readMessages(w.thread.id)).some((message) => message.turnId === cancelled.id)).toBe(true);
  });

  /**
   * MXN-374 follow-up: an entry handed off to a new thread is marked completed
   * without running here. Keeping the turns that ran must not count it, or
   * keepTurns drops a real turn instead.
   */
  it("keeps the turns that ran when an entry was handed off before the second one", async () => {
    const w = await world();
    const first = (await sendTurn(w.store, w.thread.id, { prompt: "first" })).turn;
    await completeTurn(w.store, w.thread.id, first.id, { text: "one" });

    const handedOff = (await sendTurn(w.store, w.thread.id, { prompt: "carry on elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    const second = (await sendTurn(w.store, w.thread.id, { prompt: "second" })).turn;
    await completeTurn(w.store, w.thread.id, second.id, { text: "two" });
    await prepareQueuedHandoff(w.ctx, w.thread.id, handedOff.id, Date.now());
    expect((await w.store.readTurns(w.thread.id)).find((turn) => turn.id === handedOff.id)).toMatchObject({
      status: "completed",
      delivery: "queued",
    });
    expect((await w.store.readTurns(w.thread.id)).find((turn) => turn.id === handedOff.id)?.startedAt).toBeUndefined();

    // Two turns ran here: keeping both drops nothing and rolls nothing back.
    const kept = await revertThread(w.ctx, w.thread.id, 2);
    expect(kept).toMatchObject({ keptTurns: 2, removedTurns: 0, providers: [] });
    expect(w.rollbacks).toEqual([]);

    // Keeping one drops the second turn, and only the prompt its provider saw.
    const cut = await revertThread(w.ctx, w.thread.id, 1);
    expect(cut).toMatchObject({ keptTurns: 1, removedTurns: 1, providers: ["codex"] });
    expect(w.rollbacks).toEqual([{ threadId: w.thread.id, numTurns: 1 }]);
    // The entry that never ran stays in the ledger, like an interrupted-before-start row.
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.id)).toEqual([first.id, handedOff.id]);
    const messages = await w.store.readMessages(w.thread.id);
    expect(messages.some((message) => message.turnId === second.id)).toBe(false);
    expect(messages.some((message) => message.turnId === handedOff.id)).toBe(true);
  });
});
