import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { TurnDriver } from "../execute.js";
import { readThreadForAgent } from "../agentread.js";
import { prepareQueuedHandoff, type OperationContext } from "../operations.js";
import { parseQueuePolicy } from "../queue.js";
import { openThreadStore, type ThreadStore } from "../store.js";
import { completeTurn, createThread, interruptTurn, promoteDueScheduledTurn, sendTurn } from "../threads.js";

const MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const budget = { chars: 40_000, outlineOnly: false, reason: null };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

/** A handoff's first turn on the destination is queued, so no provider is ever asked to run one. */
function fakeDriver(): TurnDriver {
  return {
    hasSession: () => Effect.succeed(false),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId: "native-1" }),
    interruptTurn: () => Effect.void,
    awaitTurn: async () => ({ status: "completed", text: "", usage: null, error: null }),
    streamEvents: Stream.never,
    resumeCursor: () => null,
  };
}

async function setup(): Promise<{ store: ThreadStore; threadId: string; ctx: OperationContext; now: (iso: string) => void }> {
  let clock = Date.parse("2026-11-19T00:00:00.000Z");
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-agentread-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await openThreadStore(root, { clock: () => clock });
  const thread = await createThread(store, {
    projectId: "p",
    title: "Queued work",
    modelSelection: MODEL,
    env: { mode: "local", path: root, branch: null },
  });
  const ctx: OperationContext = { store, storeRoot: root, config: DEFAULT_CONFIG, driverFor: () => fakeDriver() };
  return { store, threadId: thread.id, ctx, now: (iso) => { clock = Date.parse(iso); } };
}

/**
 * The incident behind MXN-374: a scheduled message was queued at 00:05 for
 * 00:20, a task notification ran at 00:09, and `thread_read` reported the
 * notification as turn 18. When the scheduled message was cancelled before
 * it ran, the reader listed it as turn 18 and moved the notification to 19,
 * though it had never run and no turn had been reordered on disk.
 */
describe("thread_read numbering", () => {
  it("keeps the numbers of turns that already ran when a queued message is taken back before it runs", async () => {
    const { store, threadId, now } = await setup();
    now("2026-11-19T00:00:00.000Z");
    const first = await sendTurn(store, threadId, { prompt: "first" });
    await completeTurn(store, threadId, first.turn.id, { text: "done" });

    now("2026-11-19T00:05:27.754Z");
    const scheduled = await sendTurn(store, threadId, { prompt: "follow through", scheduledFor: "2026-11-19T00:20:00.000Z" });
    expect(scheduled.turn).toMatchObject({ status: "queued" });

    now("2026-11-19T00:09:27.522Z");
    const notification = await sendTurn(store, threadId, { prompt: "task settled" });
    await completeTurn(store, threadId, notification.turn.id, { text: "ok" });

    now("2026-11-19T00:18:00.000Z");
    expect(await readThreadForAgent(store, { threadId }, budget)).toContain("2 turns");

    await interruptTurn(store, threadId, scheduled.turn.id);
    const after = await readThreadForAgent(store, { threadId }, budget);
    expect(after).toContain("2 turns");
    expect(after).not.toContain("follow through");
    expect(await readThreadForAgent(store, { threadId, turns: "1" }, budget)).toContain("User: first");
    expect(await readThreadForAgent(store, { threadId, turns: "2" }, budget)).toContain("User: task settled");
  });

  it("numbers a queued message by when it ran, not where its row was queued", async () => {
    const { store, threadId, now } = await setup();
    now("2026-11-19T00:00:00.000Z");
    const first = await sendTurn(store, threadId, { prompt: "first" });
    await completeTurn(store, threadId, first.turn.id, { text: "done" });

    now("2026-11-19T00:05:27.754Z");
    const scheduled = await sendTurn(store, threadId, { prompt: "later", scheduledFor: "2026-11-19T00:20:00.000Z" });

    now("2026-11-19T00:09:27.522Z");
    const notification = await sendTurn(store, threadId, { prompt: "task settled" });
    await completeTurn(store, threadId, notification.turn.id, { text: "ok" });
    expect(await readThreadForAgent(store, { threadId }, budget)).toContain("2 turns");

    now("2026-11-19T00:20:00.010Z");
    const started = await promoteDueScheduledTurn(store, threadId);
    expect(started?.id).toBe(scheduled.turn.id);
    await completeTurn(store, threadId, scheduled.turn.id, { text: "late" });

    const after = await readThreadForAgent(store, { threadId }, budget);
    expect(after).toContain("3 turns");
    expect(await readThreadForAgent(store, { threadId, turns: "2" }, budget)).toContain("User: task settled");
    expect(await readThreadForAgent(store, { threadId, turns: "3" }, budget)).toContain("User: later");
  });

  /**
   * A queued entry whose continuation is `model` or `stored` leaves for a new
   * thread: the queue pass settles its row without ever starting it here. That
   * row used to count as a turn at its queued position, so a reader that had
   * already numbered the turns after it saw them move.
   */
  it("does not number an entry handed off before a turn that ran later", async () => {
    const { store, ctx, threadId, now } = await setup();
    now("2026-11-19T00:00:00.000Z");
    const first = await sendTurn(store, threadId, { prompt: "first" });
    await completeTurn(store, threadId, first.turn.id, { text: "done" });

    now("2026-11-19T00:05:00.000Z");
    const handedOff = await sendTurn(store, threadId, { prompt: "carry on elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) });
    expect(handedOff.turn).toMatchObject({ status: "queued", delivery: "queued" });

    now("2026-11-19T00:09:00.000Z");
    const second = await sendTurn(store, threadId, { prompt: "second" });
    await completeTurn(store, threadId, second.turn.id, { text: "two" });

    now("2026-11-19T00:19:00.000Z");
    await prepareQueuedHandoff(ctx, threadId, handedOff.turn.id, Date.now());
    expect((await store.readTurns(threadId)).find((turn) => turn.id === handedOff.turn.id)).toMatchObject({
      status: "completed",
      delivery: "queued",
    });
    expect((await store.readTurns(threadId)).find((turn) => turn.id === handedOff.turn.id)?.startedAt).toBeUndefined();

    // Only the two turns that ran here are numbered; the entry continued in its own thread.
    const thread = await readThreadForAgent(store, { threadId }, budget);
    expect(thread).toContain("2 turns");
    expect(thread).not.toContain("carry on elsewhere");
    expect(await readThreadForAgent(store, { threadId, turns: "2" }, budget)).toContain("User: second");
  });
});
