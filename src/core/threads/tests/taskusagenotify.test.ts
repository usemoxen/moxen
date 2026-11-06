import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, completeTurn, failTurn, sendTurn, openTurn, interruptTurn, settleThread } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { driverKindOfInstance } from "../../types.js";
import {
  cancelAutoContinue,
  cancelTask,
  continueThread,
  describeTask,
  editWorkQueue,
  flushTaskNotifications,
  noteAutoContinueCancelled,
  queueTaskNotification,
  recoverTaskNotifications,
  scheduleUsageContinue,
  sendTaskMessage,
  startTurn,
  taskNotificationOf,
  type OperationContext,
} from "../operations.js";
import { taskNotificationText } from "../notify.js";
import { UsageProtection } from "../../usage/protection.js";

afterEach(() => {
  vi.useRealTimers();
  resetUsageLimitsForTests();
});

async function world(config: Record<string, unknown> = {}, harnessOptions: Parameters<typeof testHarness>[0] = {}) {
  const harness = await testHarness(harnessOptions);
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: { ...harness.config, ...config },
    driverFor: (id) => {
      const kind = driverKindOfInstance(id)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = harness.drivers[kind]!();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const make = (title: string) =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
  return { ...harness, ctx, make };
}

async function delegateNotifying(w: Awaited<ReturnType<typeof world>>, parentId: string, childId: string, notify = true): Promise<void> {
  const now = w.store.nowIso();
  await w.store.appendDelegation({
    id: `d-${childId}`,
    parentThreadId: parentId,
    childThreadId: childId,
    prompt: "Build it",
    status: "running",
    ...(notify ? { notify: true } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

async function notificationsIn(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<string[]> {
  return (await w.store.readMessages(threadId)).filter((message) => message.origin === "task-notification").map((message) => message.text);
}

async function batchesOf(w: Awaited<ReturnType<typeof world>>): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
}

describe("a delegated task that pauses for usage", () => {
  it("tells the parent with the resume time, then reports again when it finishes", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await scheduleUsageContinue(w.ctx, child.id, stopped.id, resetsAt);
    expect(continued).not.toBeNull();

    await flushTaskNotifications(w.ctx, parent.id);
    const paused = await notificationsIn(w, parent.id);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toContain("paused for usage");
    expect(paused[0]).toContain(child.id);
    expect(paused[0]).toContain(new Date(Date.parse(resetsAt) + 60_000).toISOString());
    expect(paused[0]).not.toContain("has settled");

    // The pause is a running task, not a terminal one.
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("running");
    expect(await taskNotificationOf(w.ctx, child.id)).toMatchObject({ status: "running" });

    // The resume runs and the task finishes: the normal report arrives too.
    const queued = (await w.store.readTurns(child.id)).find((turn) => turn.scheduleReason === "usage-reset")!;
    await w.store.updateTurn(child.id, queued.id, { status: "running" });
    await completeTurn(w.store, child.id, queued.id, { text: "Done." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const both = await notificationsIn(w, parent.id);
    expect(both).toHaveLength(2);
    expect(both[1]).toContain("finished");
    expect(both[1]).toContain(child.id);
  });

  it("says nothing when the task notifies nobody", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id, false);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({});
  });

  it("does not tell the parent twice when the pause notice is flushed twice", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  });
});

describe("a parent that cannot receive task notices yet", () => {
  it("queues notices while the parent is held and delivers them together as one message on recovery", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const first = await w.make("first task");
    const second = await w.make("second task");
    await delegateNotifying(w, parent.id, first.id);
    await delegateNotifying(w, parent.id, second.id);
    for (const child of [first, second]) {
      const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
      await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    }

    const record = await w.store.readThreadRecord(parent.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
    });
    await queueTaskNotification(w.ctx, parent.id, first.id);
    await queueTaskNotification(w.ctx, parent.id, second.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    // Durable: both entries wait in the batch file, not in a live turn.
    const batches = await batchesOf(w);
    expect(batches[parent.id]).toHaveLength(2);
    expect((await w.store.readTurns(parent.id)).filter((turn) => turn.status === "queued")).toEqual([]);

    const held = (await w.store.readThreadRecord(parent.id))!;
    await w.store.writeThreadRecord({ ...held, usagePause: null });
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(first.id);
    expect(delivered[0]).toContain(second.id);
    expect(delivered[0]).toContain("finished");
  });

  it("keeps held batches across a restart and delivers them once", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    const record = await w.store.readThreadRecord(parent.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
    });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    // A restart replays the batch file: still held, so still nothing goes out.
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect(await batchesOf(w)).not.toEqual({});

    const held = (await w.store.readThreadRecord(parent.id))!;
    await w.store.writeThreadRecord({ ...held, usagePause: null });
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
    // Replaying after delivery finds nothing left and sends nothing twice.
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  });

  it("holds notices for a spent parent without auto-continue until its next message, delivered together", async () => {
    const steered: string[] = [];
    const w = await world({}, { steering: { codex: "delivers" }, onSteer: (_threadId, text) => void steered.push(text) });
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    const parent = await w.make("orchestrator");
    const first = await w.make("first task");
    const second = await w.make("second task");
    await delegateNotifying(w, parent.id, first.id);
    await delegateNotifying(w, parent.id, second.id);
    for (const child of [first, second]) {
      const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
      await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    }

    await queueTaskNotification(w.ctx, parent.id, first.id);
    await queueTaskNotification(w.ctx, parent.id, second.id);
    await flushTurnRunners();
    // Spent with no hold to wait behind: nothing goes out on its own.
    expect(await notificationsIn(w, parent.id)).toEqual([]);

    // The user's next message carries both notices with it, as one message.
    const sent = await w.ctx.store.readTurns(parent.id);
    expect(sent.filter((turn) => turn.status === "running")).toEqual([]);
    const started = await startTurn(w.ctx, { threadId: parent.id, prompt: "Go on." });
    await started.run;
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(first.id);
    expect(delivered[0]).toContain(second.id);
    // Steered into the user's running turn: same turn, not a turn of its own.
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain(first.id);
    expect(steered[0]).toContain(second.id);
    // One turn: the notification rode the user's message, not a turn of its own.
    const live = (await w.store.readTurns(parent.id)).filter((turn) => turn.status === "completed" || turn.status === "running");
    expect(live).toHaveLength(1);
    const note = (await w.store.readMessages(parent.id)).find((message) => message.origin === "task-notification")!;
    expect(note.turnId).toBe(live[0]!.id);
  });

  it("does not deliver a spent parent's batch into the limit on flush or restart", async () => {
    const w = await world();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    // Flushing into an exhausted provider keeps the batch instead of
    // starting a turn into the wall and forgetting it.
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({ [parent.id]: [{ child: child.id }] });
    // A restart replays the same way: still spent, still nothing goes out.
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({ [parent.id]: [{ child: child.id }] });
  });

  it("keeps a settled spent parent's batch for later activity instead of dropping it", async () => {
    const w = await world();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await settleThread(w.store, parent.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({ [parent.id]: [{ child: child.id }] });
    // Once the allowance is back, the waiting batch still delivers.
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
  });
});

describe("cancelling a delegated task's automatic continue", () => {
  it("notifies the parent by default and task_status reads cancelled", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
    expect(delivered[0]).toContain("was cancelled");
  });

  it("stays silent when asked not to notify, but still reads cancelled", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id, { notifyParent: false })).toBe(true);

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
  });

  it("marks cancelled without notifying when the parent never asked to be told", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id, false);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
  });

  it("cancelling a protection recovery tells the parent and clears the hold", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, turn.id, { error: "Usage limit reached." });

    const recovery = (
      await sendTurn(w.store, child.id, {
        prompt: "Resume.",
        queue: { conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread", automatic: true, requestId: "usage:1" },
      })
    ).turn;
    const record = await w.store.readThreadRecord(child.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, recoveryTurnId: recovery.id, handoff: false },
    });

    const protection = new UsageProtection(async () => w.ctx);
    await protection.reorder(child.id, "cancel");
    protection.close();
    expect((await w.store.readThreadRecord(child.id))?.usagePause).toBeNull();
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("was cancelled");
  });

  it("task_cancel ends a pending continue and tells the parent", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    const cancelled = await cancelTask(w.ctx, parent.id, child.id);
    expect(cancelled.task.status).toBe("cancelled");
    expect(openTurn(await w.store.readTurns(child.id))).toBeNull();
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    // The stale pause is dropped: one cancellation message, not two.
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("was cancelled");
  });

  it("a note helper marks without mechanics for callers that already interrupted", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    const scheduled = await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    await interruptTurn(w.store, child.id, scheduled!.id);
    expect(await noteAutoContinueCancelled(w.ctx, child.id)).toBe(true);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
  });

  it("does not mark when live work remains, but still tells the parent", async () => {
    const w = await world({ autoContinueAtUsageLimit: true }, { leaveTurnsRunning: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    // A follow-up is still running when a usage-limit continue is scheduled.
    const followUp = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });
    expect(followUp.turn.status).toBe("running");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const cont = (
      await sendTurn(w.store, child.id, {
        prompt: "Continue later.",
        queue: { conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread", automatic: true },
        scheduledFor: at,
        scheduleReason: "usage-reset",
      })
    ).turn;
    expect(cont.status).toBe("queued");

    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);
    // Not marked: the task is still working and reports on its own.
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).not.toBe("cancelled");
    await flushTaskNotifications(w.ctx, parent.id);
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("automatic continue was cancelled");
    await interruptTurn(w.store, child.id, followUp.turn.id);
  });

  it("clears the mark when fresh work settles, reading the new outcome", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    const resumed = await startTurn(w.ctx, { threadId: child.id, prompt: "Go on." });
    await resumed.run;
    await flushTurnRunners();
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("a steered task_send revives the row and re-arms the settle report", async () => {
    const w = await world({ autoContinueAtUsageLimit: true }, { leaveTurnsRunning: true, steering: { codex: "delivers" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    // Fresh work starts on the live session while the mark stands.
    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Keep going." });
    const sent = await sendTaskMessage(w.ctx, parent.id, child.id, "Hold on.", false);
    expect(sent.outcome).toBe("steered");
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");

    await interruptTurn(w.store, child.id, running.turn.id);
    await flushTurnRunners();
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
  });

  it("restoring a removed recovery entry clears the mark", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, turn.id, { error: "Usage limit reached." });

    const recovery = (
      await sendTurn(w.store, child.id, {
        prompt: "Resume.",
        queue: { conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread", automatic: true, requestId: "usage:1" },
      })
    ).turn;
    const record = await w.store.readThreadRecord(child.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, recoveryTurnId: recovery.id, handoff: false },
    });
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    await editWorkQueue(w.ctx, child.id, recovery.id, "restore");
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
    // The mark is gone; the failed turn still stands until the restored entry runs.
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("failed");
  });
});

describe("a task notification across a continued parent", () => {
  it("reroutes a queued pause to the new parent only", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const record = await w.store.readThreadRecord(parent.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
    });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    const continued = await continueThread(w.ctx, { threadId: parent.id });

    await flushTaskNotifications(w.ctx, parent.id);
    await flushTaskNotifications(w.ctx, continued.threadId);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    const delivered = await notificationsIn(w, continued.threadId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
  });
});

describe("a settle queued behind a pause", () => {  it("delivers one message with the settle report, not the stale pause", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const record = await w.store.readThreadRecord(parent.id);
    await w.store.writeThreadRecord({
      ...record!,
      usagePause: { provider: "codex", windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
    });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    const held = (await w.store.readThreadRecord(parent.id))!;
    await w.store.writeThreadRecord({ ...held, usagePause: null });
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("finished");
    expect(delivered[0]).not.toContain("paused for usage");
  });

  it("wakes a settled parent to deliver its queued notice, still as one message", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await settleThread(w.store, parent.id);
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
    expect((await w.store.readThreadRecord(parent.id))?.settledAt).toBeNull();
  });
});

describe("task notification text for pauses and cancellations", () => {
  const task = {
    taskId: "child",
    title: "Build it",
    durationMs: 60_000,
    model: "codex/gpt-6.1-sol",
    branch: null,
    headline: "Partial report.",
    filesChanged: null,
    additions: null,
    deletions: null,
    background: [],
    backgroundUnknown: false,
  } as const;

  it("says a task paused for usage and when it resumes", () => {
    const text = taskNotificationText([{ ...task, status: "running", resumesAt: "2026-11-06T12:00:00.000Z" }]);
    expect(text).toContain("paused for usage");
    expect(text).toContain("2026-11-06T12:00:00.000Z");
    expect(text).not.toContain("has settled");
  });

  it("says a cancelled task will not resume", () => {
    const text = taskNotificationText([{ ...task, status: "cancelled", cancelled: true }]);
    expect(text).toContain("was cancelled");
    expect(text).toContain("will not resume on its own");
  });

  it("summarises mixed batches as updates", () => {
    const text = taskNotificationText([
      { ...task, status: "running", resumesAt: "2026-11-06T12:00:00.000Z" },
      { ...task, taskId: "other", status: "completed" },
    ]);
    expect(text).toContain("Updates on 2 tasks");
  });
});
