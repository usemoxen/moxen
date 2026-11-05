/**
 * MXN-268: a prompt is delivered when the provider answers it, not when it
 * accepts it. Claude reports its session handle on `init`, before the model
 * runs, so a first turn a usage limit stopped (0 output tokens, the limit as
 * the "answer") left a handle behind for a conversation that never read the
 * handoff. The next turn resumed it, with no handoff and no `<moxen-mode>`
 * block, and thread.modeState already said the mode had been told.
 */
import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import type { TurnDriver, TurnOutcome } from "../execute.js";
import { continueThread, startTurn, type OperationContext } from "../operations.js";
import { completeTurn, createThread, sendTurn } from "../threads.js";

/** The outcome of a Claude turn the 5-hour limit stopped: the limit as the reply, no output tokens. */
const LIMIT: TurnOutcome = {
  status: "completed",
  text: "You've hit your 5-hour limit · resets 7:30pm (Europe/Madrid)",
  usage: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 },
  turnOutputTokens: 0,
  error: null,
};
const ANSWER: TurnOutcome = {
  status: "completed",
  text: "On it.",
  usage: { input: 12, cacheRead: 98852, cacheCreate: 199340, output: 28, thinking: 0 },
  turnOutputTokens: 28,
  error: null,
};

async function world(outcomes: TurnOutcome[]) {
  const prompts: string[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => void prompts.push(turn.prompt) });
  const claude = harness.drivers.claude!();
  // Each turn gets the next scripted outcome.
  const driver: TurnDriver = Object.assign(Object.create(claude) as TurnDriver, {
    awaitTurn: async (): Promise<TurnOutcome> => outcomes.shift() ?? ANSWER,
  });
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (id) => (driverKindOfInstance(id) === "claude" ? driver : harness.drivers[driverKindOfInstance(id)!]!()),
  };
  const source = await createThread(harness.store, {
    projectId: "p",
    title: "source",
    env: { mode: "local", path: harness.work, branch: null },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    interactionMode: "orchestrate",
  });
  const first = (await sendTurn(harness.store, source.id, { prompt: "Replace the compaction" })).turn;
  await completeTurn(harness.store, source.id, first.id, { text: "Half done." });
  return { ...harness, ctx, prompts, source };
}

describe("a prompt the provider never answered", () => {
  it("is sent again, with the mode block, on the next turn of a continued thread stopped by a usage limit", async () => {
    const w = await world([LIMIT, ANSWER]);
    const { threadId } = await continueThread(w.ctx, { threadId: w.source.id });
    await settleRuns();

    // The shape of the real stop: the turn completed, nothing generated, and Claude had already reported a handle.
    const [stopped] = await w.store.readTurns(threadId);
    expect(stopped).toMatchObject({ status: "completed", interactionMode: "orchestrate", turnOutputTokens: 0, unanswered: true });
    const thread = (await w.store.readThreadRecord(threadId))!;
    expect(thread.providerSessions?.claude).toBeUndefined();
    expect(thread.modeState?.claude).toBeUndefined();
    expect(w.prompts).toHaveLength(1);
    expect(w.prompts[0]).toContain("<moxen-mode");
    expect(w.prompts[0]).toContain("# Continuing: ");

    await startTurn(w.ctx, { threadId, prompt: "Hey, the task finished." });
    await settleRuns();

    expect(w.prompts).toHaveLength(2);
    expect(w.prompts[1]).toContain("<moxen-mode");
    expect(w.prompts[1]).toContain("# Continuing: ");
    expect(w.prompts[1]?.endsWith("Hey, the task finished.")).toBe(true);
    const after = (await w.store.readThreadRecord(threadId))!;
    expect(after.modeState?.claude).toBe("orchestrate");
    expect(after.providerSessions?.claude).toBeDefined();
  });

  it("is still owed when the usage continue queued after it was stopped before it ran", async () => {
    const w = await world([LIMIT, ANSWER]);
    const { threadId } = await continueThread(w.ctx, { threadId: w.source.id });
    await settleRuns();
    // The real thread's second turn: the queued continue, interrupted while it waited. It never had an owner.
    const { turn: nudge } = await sendTurn(w.store, threadId, { prompt: "The usage limit has reset.", scheduledFor: new Date(Date.now() + 3_600_000).toISOString(), scheduleReason: "usage-reset" });
    await w.store.updateTurn(threadId, nudge.id, { status: "interrupted", completedAt: w.store.nowIso() });

    await startTurn(w.ctx, { threadId, prompt: "Hey, the task finished." });
    await settleRuns();

    expect(w.prompts).toHaveLength(2);
    expect(w.prompts[1]).toContain("<moxen-mode");
    expect(w.prompts[1]).toContain("# Continuing: ");
    expect(w.prompts[1]).not.toContain("The usage limit has reset.");
  });

  it("says the mode once: after an answered turn the next prompt carries neither the handoff nor the block", async () => {
    const w = await world([LIMIT, ANSWER, ANSWER]);
    const { threadId } = await continueThread(w.ctx, { threadId: w.source.id });
    await settleRuns();
    await startTurn(w.ctx, { threadId, prompt: "Hey, the task finished." });
    await settleRuns();
    await startTurn(w.ctx, { threadId, prompt: "And the next?" });
    await settleRuns();

    expect(w.prompts).toHaveLength(3);
    expect(w.prompts[2]).toBe("And the next?");
  });

  it("goes once on an ordinary first turn that was answered", async () => {
    const w = await world([ANSWER, ANSWER]);
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "orchestrator",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      interactionMode: "orchestrate",
    });
    await startTurn(w.ctx, { threadId: thread.id, prompt: "Start" });
    await settleRuns();
    await startTurn(w.ctx, { threadId: thread.id, prompt: "Go on" });
    await settleRuns();

    expect(w.prompts).toHaveLength(2);
    expect(w.prompts[0]).toContain("<moxen-mode");
    expect(w.prompts[1]).toBe("Go on");
  });
});
