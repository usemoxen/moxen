import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { prepareQueuedHandoff, type OperationContext } from "../operations.js";
import { toActivityEnvelope, toCheckpointEnvelope, toMessageEnvelope, toThreadEnvelope } from "../project.js";
import { parseQueuePolicy } from "../queue.js";
import { turnThroughput } from "../throughput.js";
import { completeTurn, createThread, sendTurn } from "../threads.js";
import type { StoredThread, StoredTurn } from "../types.js";

function thread(overrides: Partial<StoredThread> = {}): StoredThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "opencode", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    env: { mode: "local", path: "/repo", branch: "main" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    unsettledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function turn(overrides: Partial<StoredTurn> = {}): StoredTurn {
  return {
    id: "turn-1",
    threadId: "thread-1",
    status: "completed",
    delivery: "started",
    messageId: "msg-1",
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: null,
    parentTurnId: null,
    error: null,
    usage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

describe("toThreadEnvelope", () => {
  it("excludes turns without observed generation time from throughput", () => {
    const usage = { input: 10, cacheRead: 0, cacheCreate: 0, output: 120, thinking: 0 };
    const selection = { instanceId: "opencode", model: "model" };
    const base = turn({ usage, modelSelection: selection, startedAt: "2026-01-01T00:00:30.000Z" });
    expect(turnThroughput([
      { ...base, generation: { characters: 400, durationMs: 2000 } },
      turn({ id: "old", usage, modelSelection: selection }),
      turn({ id: "claude", usage, modelSelection: { instanceId: "claudeAgent", model: "model" }, turnOutputTokens: 30 }),
      turn({ id: "old-claude", usage, modelSelection: { instanceId: "claudeAgent", model: "model" } }),
      turn({ id: "running", status: "running", usage, completedAt: null }),
      turn({ id: "failed", status: "failed", usage }),
      turn({ id: "missing", usage: null }),
      turn({ id: "zero", usage: { ...usage, output: 0 } }),
      turn({ id: "bad-time", usage, startedAt: "invalid" }),
      turn({ id: "instant", usage, startedAt: "2026-01-01T00:01:00.000Z" }),
    ])).toEqual({ "turn-1": 50 });
  });
  it("projects catalog rows without ledgers", () => {
    const projected = toThreadEnvelope(thread(), [turn()]);
    expect(projected.latestTurn).toMatchObject({ turnId: "turn-1", state: "completed" });
    expect(projected.session).toMatchObject({ status: "idle", providerName: "opencode", activeTurnId: null });
    expect(projected.branch).toBe("main");
    expect(projected.worktreePath).toBeNull();
    expect(projected.proposedPlans).toEqual([]);
    expect(projected).not.toHaveProperty("messages");
  });

  it("marks running sessions and skips queued turns", () => {
    const projected = toThreadEnvelope(thread(), [
      turn({ id: "t1", status: "completed" }),
      turn({ id: "t2", status: "queued" }),
      turn({ id: "turn-3", status: "running" }),
    ]);
    expect(projected.latestTurn).toMatchObject({ turnId: "turn-3", state: "running" });
    expect(projected.session).toMatchObject({ status: "running", activeTurnId: "turn-3" });

    const queuedOnly = toThreadEnvelope(thread(), [turn({ id: "q", status: "queued" })]);
    expect(queuedOnly.latestTurn).toBeNull();
    expect(queuedOnly.session?.status).toBe("idle");
  });

  it("maps failure states and worktree env", () => {
    const failed = toThreadEnvelope(thread(), [turn({ status: "failed" })]);
    expect(failed.latestTurn?.state).toBe("error");
    const interrupted = toThreadEnvelope(thread(), [turn({ status: "interrupted" })]);
    expect(interrupted.latestTurn?.state).toBe("interrupted");
    const worktree = toThreadEnvelope(thread({ env: { mode: "worktree", path: "/wt", branch: "feat" } }), []);
    expect(worktree.worktreePath).toBe("/wt");
    expect(worktree.latestTurn).toBeNull();
  });

  it("numbers checkpoints by turns that ran, not by rows still waiting in the queue", () => {
    const projected = toThreadEnvelope(
      thread(),
      [
        turn({ id: "t1", createdAt: "2026-11-19T00:00:00.000Z" }),
        // Queued before the second real turn but run after it.
        turn({ id: "q", status: "queued", delivery: "queued", createdAt: "2026-11-19T00:05:00.000Z", scheduledFor: "2026-11-19T00:20:00.000Z", completedAt: null }),
        turn({ id: "t3", createdAt: "2026-11-19T00:09:00.000Z", startedAt: "2026-11-19T00:09:00.000Z" }),
      ],
      {
        checkpoints: [
          { id: "c1", threadId: "thread-1", turnId: "t1", status: "available", ref: "a", baseRef: "b", createdAt: "2026-11-19T00:00:00.000Z" },
          { id: "c3", threadId: "thread-1", turnId: "t3", status: "available", ref: "c", baseRef: "d", createdAt: "2026-11-19T00:09:00.000Z" },
        ],
      },
    );
    // Two turns have run: the queued message is not a turn a reader has seen.
    expect(projected.checkpoints?.map((row) => row.checkpointTurnCount)).toEqual([1, 2]);
  });

  it("keeps the last turn that ran as latest when a queued message is taken back before it runs", () => {
    const projected = toThreadEnvelope(thread(), [
      turn({ id: "t1", createdAt: "2026-11-19T00:00:00.000Z" }),
      turn({ id: "q", status: "interrupted", delivery: "queued", createdAt: "2026-11-19T00:05:00.000Z", scheduledFor: "2026-11-19T00:20:00.000Z", updatedAt: "2026-11-19T00:17:00.000Z", completedAt: "2026-11-19T00:17:00.000Z" }),
    ]);
    expect(projected.latestTurn).toMatchObject({ turnId: "t1", state: "completed" });
  });

  /**
   * MXN-374 follow-up: a queued entry handed off to a new thread is marked
   * completed by the queue pass without starting here, so it is not a turn
   * and cannot take a number from one that ran later.
   */
  it("numbers a checkpoint by the turns that ran, not by an entry handed off before one", async () => {
    const harness = await testHarness();
    const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: harness.config, driverFor: () => harness.drivers.codex!() };
    const real = await createThread(harness.store, {
      projectId: "p",
      title: "Handoff",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      env: { mode: "local", path: harness.work, branch: null },
    });
    const first = (await sendTurn(harness.store, real.id, { prompt: "first" })).turn;
    await completeTurn(harness.store, real.id, first.id, { text: "one" });
    const handedOff = (await sendTurn(harness.store, real.id, { prompt: "carry on elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    const second = (await sendTurn(harness.store, real.id, { prompt: "second" })).turn;
    await completeTurn(harness.store, real.id, second.id, { text: "two" });
    await prepareQueuedHandoff(ctx, real.id, handedOff.id, Date.now());
    // The row the settle path would write for the second turn that ran.
    await harness.store.appendLedger(real.id, "checkpoints", {
      id: harness.store.newId(),
      threadId: real.id,
      turnId: second.id,
      status: "available",
      ref: "post",
      baseRef: "pre",
      files: [],
      createdAt: harness.store.nowIso(),
    });

    const projected = toThreadEnvelope((await harness.store.readThreadRecord(real.id))!, await harness.store.readTurns(real.id), {
      checkpoints: await harness.store.readCheckpoints(real.id),
    });
    expect(projected.checkpoints?.map((row) => [row.turnId, row.checkpointTurnCount])).toEqual([[second.id, 2]]);
    expect(projected.latestTurn).toMatchObject({ turnId: second.id, state: "completed" });
  });

  it("attaches ledgers with checkpoint turn counts", () => {
    const projected = toThreadEnvelope(
      thread(),
      [turn({ id: "t1" }), turn({ id: "t2" })],
      {
        messages: [{ id: "m1", threadId: "thread-1", turnId: "t1", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
        activities: [{ id: "a1", threadId: "thread-1", turnId: "t1", kind: "turn.started", summary: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
        checkpoints: [{ id: "c1", threadId: "thread-1", turnId: "t2", status: "available", ref: "abc", baseRef: "def", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
    );
    expect(projected.messages?.[0]).toMatchObject({ id: "m1", streaming: false });
    expect(projected.latestUserMessageAt).toBe("2026-01-01T00:00:00.000Z");
    expect(projected.activities?.[0]).toMatchObject({ tone: "info" });
    // The second turn: two turns exist once it has run.
    expect(projected.checkpoints?.[0]).toMatchObject({ turnId: "t2", checkpointTurnCount: 2, ref: "abc" });
  });
});

describe("row projections", () => {
  it("reads a turn with an unknown status as unknown, not completed", () => {
    const strange = turn({ id: "t9", status: "bogus" as StoredTurn["status"] });
    expect(toThreadEnvelope(thread(), [strange]).latestTurn).toMatchObject({ turnId: "t9", state: "unknown" });
  });

  it("does not report idle while an unknown or ownerless turn is open", () => {
    const strange = turn({ id: "t9", status: "bogus" as StoredTurn["status"] });
    expect(toThreadEnvelope(thread(), [strange]).session).toMatchObject({ status: "running", activeTurnId: "t9" });
    const { owner: _dropped, ...ownerless } = turn({ id: "t8", status: "running" });
    expect(toThreadEnvelope(thread(), [ownerless]).session).toMatchObject({ status: "running", activeTurnId: "t8" });
    expect(toThreadEnvelope(thread(), []).session).toMatchObject({ status: "idle", activeTurnId: null });
  });

  it("maps messages, activities, and checkpoints", () => {
    expect(
      toMessageEnvelope({ id: "m", threadId: "t", turnId: "u", role: "assistant", text: "x", createdAt: "c" }),
    ).toMatchObject({ streaming: false, updatedAt: "c" });
    expect(
      toActivityEnvelope({ id: "a", threadId: "t", turnId: null, kind: "k", summary: "s", createdAt: "c" }),
    ).toMatchObject({ tone: "info", turnId: null });
    expect(
      toCheckpointEnvelope({ id: "c", threadId: "t", turnId: "u", status: "available", ref: "r", baseRef: "b", createdAt: "c" }, 3),
    ).toMatchObject({ checkpointTurnCount: 3, ref: "r" });
  });
});
