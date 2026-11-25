import { afterEach, describe, expect, it } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn } from "../../threads/threads.js";
import { runDueScheduledTurn, runWorkQueue, type OperationContext } from "../../threads/operations.js";
import { settleRuns } from "../../testing/turns.js";
import { parseQueuePolicy } from "../../threads/queue.js";
import { driverKindOfInstance, type CliConfig } from "../../types.js";
import { resetUsageLimitsForTests } from "../limits.js";
import { prefersColdHandoff } from "../coldresume.js";

afterEach(resetUsageLimitsForTests);

const HOUR = 3_600_000;
const on = { usageColdResume: "handoff" as const, usageColdResumeAfter: "1h", usageColdResumeTokens: 50_000 };

describe("prefersColdHandoff", () => {
  it("hands off only a large context whose cache has expired", () => {
    expect(prefersColdHandoff(on, { lastActivityAt: 0, usedTokens: 80_000, now: 2 * HOUR })).toBe(true);
    expect(prefersColdHandoff(on, { lastActivityAt: 0, usedTokens: 80_000, now: HOUR / 2 })).toBe(false);
    expect(prefersColdHandoff(on, { lastActivityAt: 0, usedTokens: 20_000, now: 2 * HOUR })).toBe(false);
  });

  it("stays put when off or when a fact is missing", () => {
    expect(prefersColdHandoff({ ...on, usageColdResume: "same-thread" }, { lastActivityAt: 0, usedTokens: 80_000, now: 2 * HOUR })).toBe(false);
    expect(prefersColdHandoff(on, { lastActivityAt: null, usedTokens: 80_000, now: 2 * HOUR })).toBe(false);
    expect(prefersColdHandoff(on, { lastActivityAt: 0, usedTokens: null, now: 2 * HOUR })).toBe(false);
  });

  it("reads an unparseable window as the one-hour default", () => {
    expect(prefersColdHandoff({ ...on, usageColdResumeAfter: "soon" }, { lastActivityAt: 0, usedTokens: 80_000, now: HOUR / 2 })).toBe(false);
    expect(prefersColdHandoff({ ...on, usageColdResumeAfter: "soon" }, { lastActivityAt: 0, usedTokens: 80_000, now: HOUR + 1 })).toBe(true);
  });
});

async function recovering(config: Partial<CliConfig>, usedTokens: number) {
  const sends: { threadId: string; prompt: string }[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => sends.push({ threadId: turn.threadId, prompt: turn.prompt }) });
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: { ...harness.config, ...config }, driverFor: (id) => harness.drivers[driverKindOfInstance(id)!]!() };
  const thread = await createThread(harness.store, { projectId: "p", title: "work", env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
  await sendTurn(harness.store, thread.id, { prompt: "Build it" });
  await completeTurn(harness.store, thread.id, openTurn(await harness.store.readTurns(thread.id))!.id, { text: "Paused." });
  await harness.store.rewriteLedger(thread.id, "activity", [{ id: "c", threadId: thread.id, turnId: null, kind: "context-window.updated", summary: "", createdAt: harness.store.nowIso(), payload: { usedTokens } }]);
  const recovery = (await sendTurn(harness.store, thread.id, { prompt: "Continue", origin: "usage-continue", queue: { ...parseQueuePolicy({ conditions: [], order: 1, sequential: false, continuation: "same-thread" }), automatic: true, requestId: "usage:1" } })).turn;
  return { ...harness, ctx, threadId: thread.id, recoveryId: recovery.id, sends };
}

describe("cold usage recovery", () => {
  it("turns a due recovery on a cold, large thread into a stored handoff", async () => {
    const w = await recovering(on, 80_000);
    expect(await runDueScheduledTurn(w.ctx, w.threadId, Date.now() + 2 * HOUR)).toBe(false);
    const turn = (await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)!;
    expect(turn.status).toBe("queued");
    expect(turn.queue?.continuation).toBe("stored");
    expect((await w.store.readActivities(w.threadId)).some((activity) => activity.kind === "usage.cold-resume")).toBe(true);
    await runWorkQueue(w.ctx, Date.now() + 2 * HOUR);
    const prepared = (await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)!;
    expect(prepared.handoff?.destinationThreadId).toBeTruthy();
    expect(await w.store.readThreadRecord(prepared.handoff!.destinationThreadId)).not.toBeNull();
  });

  it("resumes in the same thread while the cache is warm", async () => {
    const w = await recovering(on, 80_000);
    expect(await runDueScheduledTurn(w.ctx, w.threadId, Date.now() + 60_000)).toBe(true);
    expect((await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)?.queue?.continuation).toBe("same-thread");
  });

  it("moves a plain follow-up along when a cold recovery becomes a stored handoff", async () => {
    const w = await recovering(on, 80_000);
    const recovery = (await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)!;
    const thread = (await w.store.readThreadRecord(w.threadId))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "waiting", handoff: false, recoveryTurnId: recovery.id } });
    // A plain message queued while the hold stood: accepted right before the
    // hand-off clears the pause, it must not be stranded behind it (MXN-388).
    const plain = (await sendTurn(w.store, w.threadId, { prompt: "Then cover the edge case.", delivery: "queue" })).turn;
    expect(plain.status).toBe("queued");
    expect(plain.queue).toBeUndefined();
    const now = Date.now() + 2 * HOUR;
    expect(await runDueScheduledTurn(w.ctx, w.threadId, now)).toBe(false);
    await runWorkQueue(w.ctx, now);
    const prepared = (await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)!;
    expect(prepared.handoff?.destinationThreadId).toBeTruthy();
    const destination = prepared.handoff!.destinationThreadId!;
    // The follow-up moved with the hand-off: taken back as removed on the
    // source, landed on the destination waiting on its hand-off turn.
    expect((await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === plain.id)).toMatchObject({
      status: "interrupted",
      handoff: { destinationThreadId: destination, landed: true },
    });
    await settleRuns();
    // The hand-off turn starts as a queue entry itself, so each pass admits
    // the next waiting turn on the destination: the hand-off turn first,
    // then the follow-up it carried.
    let settled: string = "queued";
    for (let pass = 0; pass < 3 && settled !== "completed"; pass += 1) {
      await runWorkQueue(w.ctx, now);
      await settleRuns();
      settled = (await w.store.readTurns(destination)).find((candidate) => candidate.queue?.requestId === `handoff:transfer:${plain.id}`)?.status ?? "queued";
    }
    await settleRuns();
    const moved = (await w.store.readTurns(destination)).find((candidate) => candidate.queue?.requestId === `handoff:transfer:${plain.id}`)!;
    expect(moved.status).toBe("completed");
    // It ran once, on the new thread only; the old thread never ran it.
    expect(w.sends.filter((send) => send.prompt.includes("Then cover the edge case."))).toHaveLength(1);
    expect(w.sends.every((send) => send.threadId === destination)).toBe(true);
    expect((await w.store.readThreadRecord(w.threadId))?.usagePause).toBeNull();
  });

  it("does nothing with the setting off", async () => {
    const w = await recovering({}, 80_000);
    expect(await runDueScheduledTurn(w.ctx, w.threadId, Date.now() + 2 * HOUR)).toBe(true);
    expect((await w.store.readTurns(w.threadId)).find((candidate) => candidate.id === w.recoveryId)?.queue?.continuation).toBe("same-thread");
  });
});
