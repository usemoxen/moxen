import { describe, expect, it } from "vitest";

import { toActivityEnvelope, toCheckpointEnvelope, toMessageEnvelope, toThreadEnvelope } from "../project.js";
import { turnThroughput } from "../throughput.js";
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
