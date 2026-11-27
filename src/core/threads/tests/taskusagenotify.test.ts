import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, completeTurn, failTurn, sendTurn, openTurn, interruptTurn, reconcileOrphanedTurn, settleThread, isContinuationBusy } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { driverKindOfInstance } from "../../types.js";
import {
  cancelAutoContinue,
  cancelTask,
  continueOwnThread,
  continueThread,
  delegate,
  describeTask,
  editWorkQueue,
  flushTaskNotifications,
  noteAutoContinueCancelled,
  queueAgentMessage,
  queueTaskNotification,
  recoverPendingAdoptions,
  recoverTaskNotifications,
  removeAgentQueuedMessage,
  runDueScheduledTurn,
  runWorkQueue,
  scheduleUsageContinue,
  sendTaskMessage,
  startTurn,
  taskNotificationOf,
  type OperationContext,
} from "../operations.js";
import { parseQueuePolicy } from "../queue.js";
import { markDelegationNoticeReported } from "../delegationnotice.js";
import { openThreadStore } from "../store.js";
import { taskNotificationText } from "../notify.js";
import { UsageProtection } from "../../usage/protection.js";

/** One-shot I/O failures for the batch file, to prove a move's single write is the durability point. */
const batchIo = vi.hoisted(() => ({ failNextBatchWrites: 0 }));

vi.mock("../../infra/atomic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/atomic.js")>();
  return {
    ...actual,
    writeAtomic: async (file: string, text: string): Promise<void> => {
      if (batchIo.failNextBatchWrites > 0 && file.endsWith("task-notification-batches.json")) {
        batchIo.failNextBatchWrites -= 1;
        throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      }
      return actual.writeAtomic(file, text);
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  batchIo.failNextBatchWrites = 0;
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

/** The durable notice batches with each entry's identity dropped: these tests pin which notices wait, not their internal ids. */
async function batchesOf(w: Awaited<ReturnType<typeof world>>): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8").catch(() => "{}")) as Record<string, { id?: string }[]>;
  return Object.fromEntries(Object.entries(raw).map(([parent, entries]) => [parent, entries.map(({ id: _id, ...rest }) => rest)]));
}

/** The thread a source continued: the destination a handoff created. */
async function destinationOf(w: Awaited<ReturnType<typeof world>>, sourceId: string): Promise<string | null> {
  for (const id of await w.store.listThreadIds()) {
    if ((await w.store.readThreadRecord(id))?.continuedFrom === sourceId) return id;
  }
  return null;
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

  it("moves a pending pause notice to the continuation that inherits the hold", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt }]);
    const continued = await scheduleUsageContinue(w.ctx, child.id, stopped.id, resetsAt);
    expect(continued).not.toBeNull();
    // No flush yet: the pause entry is still in its batch window. The thread
    // is held for the same reset before the window lapses...
    await w.store.withThreadLock(child.id, async () => {
      const current = (await w.store.readThreadRecord(child.id))!;
      await w.store.writeThreadRecord({ ...current, usagePause: { provider: "codex", windows: [], resetsAt, order: 1, phase: "waiting", handoff: false }, updatedAt: w.store.nowIso() });
    });
    const next = await continueThread(w.ctx, { threadId: child.id, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    // ...and the destination inherits the hold.
    expect((await w.store.readThreadRecord(next.threadId))?.usagePause).toMatchObject({ phase: "waiting" });

    // The reset lapses; the parent still hears the pause notice — naming the
    // live task, not the dormant source.
    resetUsageLimitsForTests();
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const notes = await notificationsIn(w, parent.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("paused for usage");
    expect(notes[0]).toContain(next.threadId);
  });

  it("takes back a stale automatic continue without cancelling the task, and the parent still gets its settle report", async () => {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    // Due almost at once: the long-past reset only sets how far ahead the continue waits.
    const continued = await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() - 59_000).toISOString());
    expect(continued).not.toBeNull();

    await flushTaskNotifications(w.ctx, parent.id);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);

    // The thread resumes on its own past the reset: a maintenance turn runs
    // to completion, so the scheduled nudge is stale.
    const at = continued!.scheduledFor!;
    await vi.waitFor(() => expect(Date.now() >= Date.parse(at)).toBe(true), { timeout: 120_000, interval: 25 });
    const resumed = await sendTurn(w.store, child.id, { prompt: "wrap-up notes", usageControl: true });
    expect(resumed.turn.status).toBe("running");
    await completeTurn(w.store, child.id, resumed.turn.id, { text: "Stopped safely." });

    // Taken back, not cancelled: no mark on the delegation, no cancel notice.
    expect((await w.store.readTurns(child.id)).find((turn) => turn.id === continued!.id)).toMatchObject({ status: "interrupted" });
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
    expect(await taskNotificationOf(w.ctx, child.id)).toMatchObject({ status: "completed" });

    // And the parent hears the normal settle report — never left waiting on a resume that will not come.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const both = await notificationsIn(w, parent.id);
    expect(both).toHaveLength(2);
    expect(both[1]).toContain("finished");
    expect(both[1]).toContain(child.id);
    expect(both[1]).toContain("Stopped safely.");
    expect(both[1]).not.toContain("paused for usage");
    expect(both[1]).not.toContain("Resumes at");
    expect(both[1]).not.toContain("cancelled");
    expect(await batchesOf(w)).toEqual({});
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

  it("drops a spent parent's batch at once when the parent is archived or deleted", async () => {
    const w = await world();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    const archived = await w.make("archived parent");
    const deleted = await w.make("deleted parent");
    const archivedChild = await w.make("archived task");
    const deletedChild = await w.make("deleted task");
    await delegateNotifying(w, archived.id, archivedChild.id);
    await delegateNotifying(w, deleted.id, deletedChild.id);
    for (const child of [archivedChild, deletedChild]) {
      const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
      await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    }

    await queueTaskNotification(w.ctx, archived.id, archivedChild.id);
    await queueTaskNotification(w.ctx, deleted.id, deletedChild.id);
    expect(await batchesOf(w)).toEqual({ [archived.id]: [{ child: archivedChild.id }], [deleted.id]: [{ child: deletedChild.id }] });
    const now = w.store.nowIso();
    await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(archived.id))!, archivedAt: now, updatedAt: now });
    await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(deleted.id))!, deletedAt: now, updatedAt: now });

    await flushTaskNotifications(w.ctx, archived.id);
    await flushTaskNotifications(w.ctx, deleted.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, archived.id)).toEqual([]);
    expect(await notificationsIn(w, deleted.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({});
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

  /** A notifying task whose usage-limit failure had its automatic continue cancelled. */
  async function cancelledAfterLimit(opts: { notifyParent?: boolean } = {}) {
    const w = await world({ autoContinueAtUsageLimit: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it", parentNotice: true })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    expect((await w.store.readDelegations())[0]?.settleGeneration).toBe(1);
    await scheduleUsageContinue(w.ctx, child.id, stopped.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(await cancelAutoContinue(w.ctx, child.id, opts)).toBe(true);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    return { w, parent, child };
  }

  /** A new server over the same store: it replays batches and owed settles. */
  async function restart(w: Awaited<ReturnType<typeof world>>): Promise<void> {
    await recoverTaskNotifications({ ...w.ctx, store: await openThreadStore(w.root) });
    await flushTurnRunners();
  }

  it("adds no settle notice to the cancellation after a restart", async () => {
    const { w, parent } = await cancelledAfterLimit();
    await restart(w);
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("was cancelled");
  });

  it("stays silent after a restart when asked not to notify", async () => {
    const { w, parent } = await cancelledAfterLimit({ notifyParent: false });
    await restart(w);
    expect(await notificationsIn(w, parent.id)).toEqual([]);
  });

  it.each([["with its notice", {}, 1], ["silently", { notifyParent: false }, 0]] as const)(
    "owes nothing for a direct follow-up after a cancel %s",
    async (_how, opts, notices) => {
      const { w, parent, child } = await cancelledAfterLimit(opts);
      // Typed straight into the task: it settles, revives the status, and the
      // running server tells the parent nothing.
      await (await startTurn(w.ctx, { threadId: child.id, prompt: "One more thing." })).run;
      await flushTurnRunners();
      await flushTaskNotifications(w.ctx, parent.id);
      await flushTurnRunners();
      expect((await w.store.readDelegations())[0]).toMatchObject({ status: "running", settleGeneration: 1 });
      expect(await notificationsIn(w, parent.id)).toHaveLength(notices);
      await restart(w);
      expect(await notificationsIn(w, parent.id)).toHaveLength(notices);
    },
  );

  it("keeps the cancelled settle accounted for once later compaction revives the task", async () => {
    const { w, parent, child } = await cancelledAfterLimit({ notifyParent: false });
    // The compaction settles for good, which clears the cancelled mark
    // without settling any work of its own.
    await (await startTurn(w.ctx, { threadId: child.id, prompt: "/compact" })).run;
    await flushTurnRunners();
    expect((await w.store.readDelegations())[0]?.status).toBe("running");
    await restart(w);
    expect(await notificationsIn(w, parent.id)).toEqual([]);
  });

  it("replays no settle for a running task its parent cancelled", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    // No run callback: the process dies before one could queue the notice.
    await sendTurn(w.store, child.id, { prompt: "Build it", parentNotice: true });
    await cancelTask(w.ctx, parent.id, child.id);
    expect((await w.store.readDelegations())[0]?.settleGeneration).toBe(1);
    await restart(w);
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

async function spentClaudeParent(w: Awaited<ReturnType<typeof world>>) {
  const parent = await createThread(w.store, {
    projectId: "p",
    title: "orchestrator",
    env: { mode: "local", path: w.work, branch: null },
    modelSelection: { instanceId: "claude", model: "claude-opus-5" },
  });
  recordUsageWindows("claude", [
    { id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
  ]);
  return parent;
}

async function hold(w: Awaited<ReturnType<typeof world>>, threadId: string, provider: string, phase: "waiting" | "resuming" = "waiting"): Promise<void> {
  const record = await w.store.readThreadRecord(threadId);
  await w.store.writeThreadRecord({
    ...record!,
    usagePause: { provider, windows: [], phase, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
  });
}

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

  it("reports a task that finishes after a handoff to the new parent while the old one is spent", async () => {
    const w = await world();
    const parent = await spentClaudeParent(w);
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;

    // The orchestrator carries on in a new thread on another provider while
    // the task is still running; its completion callback still names the old
    // parent, which has no allowance left.
    const continued = await continueThread(w.ctx, {
      threadId: parent.id,
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    await queueTaskNotification(w.ctx, parent.id, child.id);

    // Resolved to the live parent before its recipient was checked: the notice
    // waits with the new thread, not in a batch nothing would flush.
    expect((await batchesOf(w))[parent.id]).toBeUndefined();
    expect((await batchesOf(w))[continued.threadId]).toEqual([{ child: child.id }]);

    await flushTaskNotifications(w.ctx, continued.threadId);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    const delivered = await notificationsIn(w, continued.threadId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
  });

  it("moves a batch already waiting on the old parent when the thread continues", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    await hold(w, parent.id, "codex");
    await queueTaskNotification(w.ctx, parent.id, child.id);
    expect(await batchesOf(w)).toEqual({ [parent.id]: [{ child: child.id }] });

    // The handoff takes the waiting notice with it; its own first turn pulls
    // the moved batch along, so it arrives without a restart or a flush of the
    // dormant parent.
    const continued = await continueThread(w.ctx, { threadId: parent.id });
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    const delivered = await notificationsIn(w, continued.threadId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
    expect(await batchesOf(w)).toEqual({});

    // One notice: a restart replays nothing left, and neither parent resends.
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect(await notificationsIn(w, continued.threadId)).toHaveLength(1);
    expect(await batchesOf(w)).toEqual({});
  });

  it("keeps a post-handoff notice under the new parent's own hold and delivers it once", async () => {
    const w = await world();
    const parent = await spentClaudeParent(w);
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    const continued = await continueThread(w.ctx, {
      threadId: parent.id,
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    await hold(w, continued.threadId, "codex");

    await queueTaskNotification(w.ctx, parent.id, child.id);
    // The live recipient is held for its own allowance: the notice waits with
    // it instead of starting a turn into that limit.
    expect(await notificationsIn(w, continued.threadId)).toEqual([]);
    expect((await batchesOf(w))[parent.id]).toBeUndefined();
    expect((await batchesOf(w))[continued.threadId]).toEqual([{ child: child.id }]);

    await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(continued.threadId))!, usagePause: null });
    await flushTaskNotifications(w.ctx, continued.threadId);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, continued.threadId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect(await notificationsIn(w, continued.threadId)).toHaveLength(1);
  });

  it("delivers once when the destination flushes as a waiting batch moves", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const destination = await w.make("continuation");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });

    await hold(w, source.id, "codex");
    await queueTaskNotification(w.ctx, source.id, child.id);

    // The handoff moves the waiting notice; a flush that reaches the
    // destination just before the handoff's own enqueue must not leave the
    // notice queued a second time.
    const locked = w.store.withThreadLock.bind(w.store);
    let flushed = false;
    const spy = vi.spyOn(w.store, "withThreadLock").mockImplementation(async (threadId, run) => {
      if (!flushed && threadId === `\0task-notification:${destination.id}`) {
        flushed = true;
        await flushTaskNotifications(w.ctx, destination.id);
      }
      return locked(threadId, run);
    });
    try {
      await continueThread(w.ctx, { threadId: source.id, destinationThreadId: destination.id });
    } finally {
      spy.mockRestore();
    }
    expect(flushed).toBe(true);
    await flushTaskNotifications(w.ctx, destination.id);
    await flushTurnRunners();

    const delivered = await notificationsIn(w, destination.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
    expect(await notificationsIn(w, source.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({});
  });

  it("keeps the old timer for notices that stay on the old parent", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    const orphan = await w.make("orphan notice");
    await delegateNotifying(w, source.id, child.id);
    for (const thread of [child, orphan]) {
      const turn = (await sendTurn(w.store, thread.id, { prompt: "Build it" })).turn;
      await completeTurn(w.store, thread.id, turn.id, { text: "Done." });
    }

    // One batch: the child moves with the handoff, the orphan has no live row
    // and stays. Only the moved entry may leave; the kept one keeps its timer.
    await queueTaskNotification(w.ctx, source.id, child.id);
    await queueTaskNotification(w.ctx, source.id, orphan.id);
    const continued = await continueThread(w.ctx, { threadId: source.id });

    await vi.waitFor(async () => {
      expect(await notificationsIn(w, source.id)).toHaveLength(1);
      expect(await batchesOf(w)).toEqual({});
    }, { timeout: 3_000, interval: 25 });
    await flushTurnRunners();
    const kept = await notificationsIn(w, source.id);
    expect(kept[0]).toContain(orphan.id);
    const moved = await notificationsIn(w, continued.threadId);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain(child.id);
  });

  it("keeps the old parent's durable copy when the move write fails", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const destination = await w.make("continuation");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    await hold(w, source.id, "codex");
    await queueTaskNotification(w.ctx, source.id, child.id);
    await hold(w, destination.id, "codex");

    batchIo.failNextBatchWrites = 1;
    await expect(continueThread(w.ctx, { threadId: source.id, destinationThreadId: destination.id })).rejects.toThrow(/injected EIO/);
    // The move's one write failed, so the only durable copy is still the source's.
    expect((await batchesOf(w))[source.id]).toEqual([{ child: child.id }]);

    await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(destination.id))!, usagePause: null });
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, destination.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, destination.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(child.id);
  });

  it("delivers one notice when a crash left it on both parents", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const destination = await w.make("continuation");
    const child = await w.make("task");
    const now = w.store.nowIso();
    await w.store.appendDelegation({
      id: "d-crash",
      parentThreadId: destination.id,
      childThreadId: child.id,
      prompt: "Build it",
      status: "running",
      notify: true,
      createdAt: now,
      updatedAt: now,
    });
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    // The destination's key comes first, as it would after the move committed
    // and the source copy was not yet removed.
    await writeFile(
      path.join(w.root, "task-notification-batches.json"),
      `${JSON.stringify({ [destination.id]: [{ child: child.id }], [source.id]: [{ child: child.id }] })}\n`,
    );

    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, destination.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, destination.id)).toHaveLength(1);
    expect(await notificationsIn(w, source.id)).toEqual([]);
    expect(await batchesOf(w)).toEqual({});
  });

  it("refuses to continue a thread that is still receiving a handoff", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const adopt = w.store.rewriteDelegationsLocked.bind(w.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const spy = vi.spyOn(w.store, "rewriteDelegationsLocked").mockImplementation(async (patches) => {
      if (!blocked && patches.some((patch) => patch.patch.parentThreadId !== undefined)) {
        blocked = true;
        await gate;
      }
      return adopt(patches);
    });

    let destinationId = "";
    let failure: unknown = null;
    const handoff = continueThread(w.ctx, { threadId: source.id });
    try {
      await vi.waitFor(async () => {
        for (const id of await w.store.listThreadIds()) {
          if ((await w.store.readThreadRecord(id))?.continuedFrom === source.id) {
            destinationId = id;
            return;
          }
        }
        throw new Error("handoff destination not created yet");
      }, { timeout: 2_000, interval: 10 });
      await expect(continueThread(w.ctx, { threadId: destinationId })).rejects.toThrow(/receiving the handoff/);
    } catch (cause) {
      failure = cause;
    } finally {
      release();
    }
    await handoff;
    spy.mockRestore();
    await flushTurnRunners();
    if (failure) throw failure;

    // Once the adoption lands, the second handoff is allowed and takes the task.
    const next = await continueThread(w.ctx, { threadId: destinationId });
    const row = (await w.store.readDelegations()).find((entry) => entry.childThreadId === child.id);
    expect(row?.parentThreadId).toBe(next.threadId);
  });

  it("does not consume a kept notice while the handoff claim still stands", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    const orphan = await w.make("orphan notice");
    await delegateNotifying(w, source.id, child.id);
    for (const thread of [child, orphan]) {
      const turn = (await sendTurn(w.store, thread.id, { prompt: "Build it" })).turn;
      await completeTurn(w.store, thread.id, turn.id, { text: "Done." });
    }
    await queueTaskNotification(w.ctx, source.id, child.id);
    await queueTaskNotification(w.ctx, source.id, orphan.id);

    // Pause after the move has re-armed the kept notice and before the
    // continuation clears its claim: the handoff's next step reads the new
    // thread's turns while the claim still stands.
    const readTurns = w.store.readTurns.bind(w.store);
    let reached!: () => void;
    const atClaimClear = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation(async (threadId, options) => {
      const turns = await readTurns(threadId, options);
      if (armed && threadId !== source.id && turns.length === 0 && (await w.store.readThreadRecord(threadId))?.continuedFrom === source.id) {
        armed = false;
        reached();
        await gate;
      }
      return turns;
    });
    const handoff = continueThread(w.ctx, { threadId: source.id });
    await atClaimClear;
    // Admission would refuse a turn while the claim stands: the flush must
    // keep the notice and arm another attempt instead of consuming it.
    await expect(flushTaskNotifications(w.ctx, source.id)).resolves.toBeUndefined();
    expect((await batchesOf(w))[source.id]).toEqual([{ child: orphan.id }]);
    release();
    await handoff;
    spy.mockRestore();

    await vi.waitFor(async () => {
      expect(await notificationsIn(w, source.id)).toHaveLength(1);
    }, { timeout: 3_000, interval: 25 });
    await flushTurnRunners();
    const kept = await notificationsIn(w, source.id);
    expect(kept[0]).toContain(orphan.id);
    let destinationId = "";
    for (const id of await w.store.listThreadIds()) {
      if ((await w.store.readThreadRecord(id))?.continuedFrom === source.id) destinationId = id;
    }
    expect(destinationId).not.toBe("");
    expect(await notificationsIn(w, destinationId)).toHaveLength(1);
  });
});

describe("a handoff that has not adopted its source's tasks yet", () => {
  /** Open the destination's first turn, if any, so a manual continue of it is admitted. */
  async function finishTurns(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<void> {
    await flushTurnRunners();
    for (const turn of await w.store.readTurns(threadId)) {
      if (turn.status === "running") await completeTurn(w.store, threadId, turn.id, { text: "Done." }).catch(() => undefined);
    }
  }

  /** Gate the adoption write so the destination exists and is still receiving. */
  function gateAdoption(w: Awaited<ReturnType<typeof world>>): { release: () => void; spy: () => void } {
    const adopt = w.store.rewriteDelegationsLocked.bind(w.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const spy = vi.spyOn(w.store, "rewriteDelegationsLocked").mockImplementation(async (patches) => {
      if (!blocked && patches.some((patch) => patch.patch.parentThreadId !== undefined)) {
        blocked = true;
        await gate;
      }
      return adopt(patches);
    });
    return { release, spy: () => spy.mockRestore() };
  }

  it("refuses a handoff naming its destination while the source is still receiving one", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const adoption = gateAdoption(w);

    const handoff = continueThread(w.ctx, { threadId: source.id });
    let destinationId = "";
    let failure: unknown = null;
    try {
      await vi.waitFor(async () => {
        destinationId = (await destinationOf(w, source.id)) ?? "";
        if (!destinationId) throw new Error("handoff destination not created yet");
      }, { timeout: 2_000, interval: 10 });
      // A queued stored handoff supplies its own destination id; the incoming
      // adoption check must still refuse before that reservation is honoured.
      const explicit = w.store.newId();
      const refused = await continueThread(w.ctx, { threadId: destinationId, destinationThreadId: explicit }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isContinuationBusy(refused)).toBe(true);
      expect(await w.store.readThreadRecord(explicit)).toBeNull();
    } catch (cause) {
      failure = cause;
    } finally {
      adoption.release();
    }
    await handoff;
    adoption.spy();
    await flushTurnRunners();
    for (const id of [source.id, destinationId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
    if (failure) throw failure;
  });

  it("leaves a queued handoff waiting while its own thread is still receiving one", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const adoption = gateAdoption(w);
    const handoff = continueThread(w.ctx, { threadId: source.id });
    let destinationId = "";
    let failure: unknown = null;
    try {
      await vi.waitFor(async () => {
        destinationId = (await destinationOf(w, source.id)) ?? "";
        if (!destinationId) throw new Error("handoff destination not created yet");
      }, { timeout: 2_000, interval: 10 });
      // The new thread already has a stored handoff of its own waiting. It
      // must not prepare it by taking its predecessor's task along.
      const queued = (await sendTurn(w.store, destinationId, {
        prompt: "Hand off again",
        queue: parseQueuePolicy({ conditions: [], continuation: "stored" }),
      })).turn;
      await runWorkQueue(w.ctx);
      const entry = (await w.store.readTurns(destinationId)).find((turn) => turn.id === queued.id)!;
      expect(entry.status).toBe("queued");
      expect((await w.store.readActivities(destinationId)).filter((activity) => activity.kind === "handoff.prepared")).toHaveLength(0);
      // Still the source's task, not the thread that has not taken it over.
      expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.parentThreadId).toBe(source.id);
    } catch (cause) {
      failure = cause;
    } finally {
      adoption.release();
    }
    await handoff;
    adoption.spy();
    await flushTurnRunners();
    for (const id of [source.id, destinationId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
    if (failure) throw failure;
  });

  it("keeps an interrupted adoption durable, refuses the next handoff, and finishes it at startup", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const adopt = w.store.rewriteDelegationsLocked.bind(w.store);
    const failing = vi.spyOn(w.store, "rewriteDelegationsLocked").mockRejectedValueOnce(Object.assign(new Error("injected EIO"), { code: "EIO" }));
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toThrow(/injected EIO/);
    failing.mockRestore();
    const destinationId = await destinationOf(w, source.id);
    expect(destinationId).not.toBeNull();
    // The crash is durable: the destination says it is still receiving.
    expect((await w.store.readThreadRecord(destinationId!))?.adoptingFrom).toBe(source.id);

    // Neither a direct continue nor the queue may move the task on first.
    const failure = await continueThread(w.ctx, { threadId: destinationId! }).then(() => null, (error: unknown) => error);
    expect(isContinuationBusy(failure)).toBe(true);
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.parentThreadId).toBe(source.id);

    // A restart finishes the handoff it inherited.
    await recoverPendingAdoptions(w.ctx);
    expect((await w.store.readThreadRecord(destinationId!))?.adoptingFrom ?? null).toBeNull();
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.parentThreadId).toBe(destinationId);
    expect((await w.store.readTurns(destinationId!)).length).toBeGreaterThan(0);
    await finishTurns(w, destinationId!);

    // With the adoption behind it, the thread may continue on its own.
    const next = await continueThread(w.ctx, { threadId: destinationId! });
    expect((await w.store.readThreadRecord(next.threadId))?.continuedFrom).toBe(destinationId);
    await flushTurnRunners();
    for (const id of [source.id, destinationId!, next.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
  });

  it("rechecks the live Antigravity opt-in for an interrupted agent opener", async () => {
    let optIn = true;
    const w = await world({ providers: { antigravity: { allowUnsupportedUse: true } } });
    const ctx = { ...w.ctx, providersInForce: () => ({ antigravity: { allowUnsupportedUse: optIn } }) };
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const failure = vi.spyOn(w.store, "rewriteDelegationsLocked").mockRejectedValueOnce(new Error("injected adoption failure"));
    try {
      await expect(continueOwnThread(ctx, {
        threadId: source.id,
        summary: "Agent's original handoff.",
        firstMessage: "Check the result.",
        modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
      })).rejects.toThrow("injected adoption failure");
    } finally {
      failure.mockRestore();
    }
    const destinationId = (await destinationOf(w, source.id))!;
    expect(destinationId).toBeTruthy();
    optIn = false;
    await recoverPendingAdoptions(ctx);
    expect(await w.store.readTurns(destinationId)).toEqual([]);
    expect((await w.store.readThreadRecord(destinationId))?.adoptingFrom).toBe(source.id);
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.parentThreadId).toBe(source.id);

    optIn = true;
    await recoverPendingAdoptions(ctx);
    await finishTurns(w, destinationId);
    expect(await w.store.readTurns(destinationId)).toMatchObject([{ handoffOpen: true, modelSelection: { instanceId: "antigravity" } }]);
    expect((await w.store.readMessages(destinationId)).find((message) => message.role === "user")?.text).toContain("Check the result.");
  });

  it.each(["adoption", "opener turn", "opener message", "dependent queue"] as const)("recovers the scheduled opener and its dependent queue after a crash at %s", async (point) => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const pending = (await sendTurn(w.store, source.id, { prompt: "Transferred request", queue: parseQueuePolicy({ conditions: [] }) })).turn;
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const action = "Run the original first action.";
    const append = w.store.appendLedger.bind(w.store);
    let failed = false;
    const appendFailure = vi.spyOn(w.store, "appendLedger").mockImplementation(async (id, ledger, row) => {
      if (!failed && id !== source.id && (
        (point === "opener turn" && ledger === "turns") ||
        (point === "opener message" && ledger === "messages") ||
        (point === "dependent queue" && ledger === "messages" && typeof row === "object" && row !== null && "text" in row && row.text === "Transferred request")
      )) {
        failed = true;
        throw new Error("injected handoff failure");
      }
      return append(id, ledger, row);
    });
    const adoptionFailure = point === "adoption" ? vi.spyOn(w.store, "rewriteDelegationsLocked").mockRejectedValueOnce(new Error("injected handoff failure")) : null;
    try {
      await expect(continueThread(w.ctx, { threadId: source.id, scheduledFor, firstMessage: action })).rejects.toThrow("injected handoff failure");
    } finally {
      appendFailure.mockRestore();
      adoptionFailure?.mockRestore();
    }
    const destinationId = (await destinationOf(w, source.id))!;
    expect(destinationId).toBeTruthy();
    await recoverPendingAdoptions(w.ctx);
    await recoverPendingAdoptions(w.ctx);

    const turns = await w.store.readTurns(destinationId);
    const opener = turns.find((turn) => turn.handoffOpen === true);
    expect(opener).toMatchObject({ scheduledFor, status: "queued" });
    expect(turns.filter((turn) => turn.handoffOpen)).toHaveLength(1);
    const messages = await w.store.readMessages(destinationId);
    expect(messages.filter((message) => message.id === opener?.messageId)).toMatchObject([{ text: expect.stringContaining(action) }]);
    const transfer = turns.find((turn) => turn.queue?.requestId === `handoff:transfer:${pending.id}`);
    expect(transfer?.queue?.conditions).toContainEqual({ type: "entry", threadId: destinationId, turnId: opener?.id, serverWait: true });
    expect(messages.filter((message) => message.turnId === transfer?.id)).toMatchObject([{ text: "Transferred request" }]);
    expect((await w.store.readThreadRecord(destinationId))?.adoptingFrom).toBeNull();
  });

  it("clears a receiving marker left behind once the adoption is behind it", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const continued = await continueThread(w.ctx, { threadId: source.id });
    await finishTurns(w, continued.threadId);
    // The clear write died with the handoff: the tasks are already this
    // thread's and nothing is left on the source to adopt.
    await w.store.withThreadLock(continued.threadId, async () => {
      const current = (await w.store.readThreadRecord(continued.threadId))!;
      await w.store.writeThreadRecord({ ...current, adoptingFrom: source.id });
    });
    const next = await continueThread(w.ctx, { threadId: continued.threadId });
    expect(next.threadId).not.toBe(continued.threadId);
    expect((await w.store.readThreadRecord(continued.threadId))?.adoptingFrom ?? null).toBeNull();
    await flushTurnRunners();
    for (const id of [source.id, continued.threadId, next.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
  });

  it("does not report an idempotent agent retry as done before the handoff finished", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });
    const sourceTurn = (await sendTurn(w.store, source.id, { prompt: "Orchestrate" })).turn;
    await completeTurn(w.store, source.id, sourceTurn.id, { text: "Continue it." });
    // The notice the handoff must carry, written durably and left alone by a
    // flush timer, so the only write that can fail is the move itself.
    await writeFile(path.join(w.root, "task-notification-batches.json"), `${JSON.stringify({ [source.id]: [{ child: child.id }] })}\n`);

    batchIo.failNextBatchWrites = 1;
    const failed = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done.", idempotencyKey: "k1" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).not.toBeNull();
    batchIo.failNextBatchWrites = 0;
    const destinationId = await destinationOf(w, source.id);
    expect(destinationId).not.toBeNull();
    // The notice never moved and the destination has no first turn: the first
    // call did not finish, whatever the reservation says.
    expect((await batchesOf(w))[source.id]).toEqual([{ child: child.id }]);
    expect(await w.store.readTurns(destinationId!)).toHaveLength(0);

    // The same key must resume the handoff, not answer "already done".
    const retried = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done.", idempotencyKey: "k1" });
    expect(retried.threadId).toBe(destinationId);
    expect(retried.note).toBeUndefined();
    expect((await w.store.readTurns(destinationId!)).length).toBeGreaterThan(0);
    expect((await batchesOf(w))[source.id]).toBeUndefined();
    await flushTurnRunners();
    for (const id of [source.id, destinationId!]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
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

describe("owed settle bookkeeping (MXN-389)", () => {
  async function notifyingTask() {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const row = async () => (await w.store.readDelegations())[0]!;
    return { w, child, row };
  }

  it("never lowers the reported generation when two notices are queued at once", async () => {
    const { w, child, row } = await notifyingTask();
    await Promise.all([markDelegationNoticeReported(w.store, child.id, 3), markDelegationNoticeReported(w.store, child.id, 2)]);
    expect((await row()).reportedGeneration).toBe(3);
  });

  it.each(["completed", "interrupted"] as const)("owes nothing for a %s compaction written before the turn marker existed", async (outcome) => {
    const { w, child, row } = await notifyingTask();
    // Marked as awaited, so only its being a compaction keeps it from counting.
    const compact = (await sendTurn(w.store, child.id, { prompt: "/compact", parentNotice: true })).turn;
    const { maintenance: _marker, ...legacy } = compact;
    await w.store.rewriteLedger(child.id, "turns", [legacy]);
    if (outcome === "completed") await completeTurn(w.store, child.id, compact.id, { text: "Conversation compacted." });
    else await interruptTurn(w.store, child.id, compact.id);
    expect((await row()).settleGeneration).toBeUndefined();
  });
});

describe("a restart owes only what the running server would report (MXN-389)", () => {
  type World = Awaited<ReturnType<typeof world>>;
  const rowOf = async (w: World, childId: string) =>
    (await w.store.readDelegations()).find((row) => row.childThreadId === childId && row.continuedIn === undefined)!;
  const restart = async (w: World): Promise<void> => {
    await recoverTaskNotifications({ ...w.ctx, store: await openThreadStore(w.root) });
    await flushTurnRunners();
  };
  const flush = async (w: World, parentId: string): Promise<void> => {
    await flushTaskNotifications(w.ctx, parentId);
    await flushTurnRunners();
  };
  /** A task delegated without waiting, settled, its one notice delivered. */
  async function reportedDelegation() {
    const w = await world();
    const parent = await w.make("orchestrator");
    const childId = (await delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", wait: false })).child.id;
    await flushTurnRunners();
    await expect.poll(async () => (await rowOf(w, childId)).reportedGeneration).toBe(1);
    await flush(w, parent.id);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
    return { w, parent, childId };
  }
  /** A message typed into the task's own thread, run to its end. */
  async function typeIntoTask(w: World, childId: string, prompt = "One more thing."): Promise<void> {
    await (await startTurn(w.ctx, { threadId: childId, prompt })).run;
    await flushTurnRunners();
  }

  it("owes nothing for a direct follow-up after the delegated turn was reported", async () => {
    const { w, parent, childId } = await reportedDelegation();
    await typeIntoTask(w, childId);
    await flush(w, parent.id);
    expect(await rowOf(w, childId)).toMatchObject({ settleGeneration: 1, reportedGeneration: 1 });
    await restart(w);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  });

  it("owes a task_send, a scheduled turn and a continuation's opener", async () => {
    const { w, parent, childId } = await reportedDelegation();

    const sent = await sendTaskMessage(w.ctx, parent.id, childId, "Also check the tests.", true);
    // On the turn itself: a watcher would not survive a crash mid-turn.
    expect((await w.store.readTurns(childId)).find((turn) => turn.id === sent.turnId)?.parentNotice).toBe(true);
    await flushTurnRunners();
    await expect.poll(async () => (await rowOf(w, childId)).settleGeneration).toBe(2);

    // Due a moment from now: promotion reads the real clock.
    await sendTurn(w.store, childId, { prompt: "Scheduled follow-up", scheduledFor: new Date(Date.now() + 250).toISOString() });
    await expect.poll(() => runDueScheduledTurn(w.ctx, childId), { timeout: 5_000 }).toBe(true);
    await flushTurnRunners();
    await expect.poll(async () => (await rowOf(w, childId)).settleGeneration).toBe(3);

    const successor = await continueThread(w.ctx, { threadId: childId });
    await flushTurnRunners();
    await expect.poll(async () => (await rowOf(w, successor.threadId)).settleGeneration).toBe(1);
  }, 30_000);

  it("owes the turn that takes a steered task_send, even one typed into the task", async () => {
    const w = await world({}, { leaveTurnsRunning: true, steering: { codex: "delivers" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const typed = await startTurn(w.ctx, { threadId: child.id, prompt: "Look around." });
    expect((await sendTaskMessage(w.ctx, parent.id, child.id, "Also check the tests.", false)).outcome).toBe("steered");
    expect((await w.store.readTurns(child.id)).find((turn) => turn.id === typed.turn.id)?.parentNotice).toBe(true);
    await completeTurn(w.store, child.id, typed.turn.id, { text: "Done." });
    expect((await rowOf(w, child.id)).settleGeneration).toBe(1);
  });

  it("owes the parent's message after it is batched into one typed earlier", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const running = (await sendTurn(w.store, child.id, { prompt: "Look around." })).turn;
    const typed = (await sendTurn(w.store, child.id, { prompt: "Mine.", delivery: "queue" })).turn;
    await sendTurn(w.store, child.id, { prompt: "The parent's.", delivery: "queue", parentNotice: true });
    await completeTurn(w.store, child.id, running.id, { text: "Looked." });
    const turns = await w.store.readTurns(child.id);
    expect(turns.map((turn) => turn.id)).toEqual([running.id, typed.id]);
    expect(turns[1]).toMatchObject({ status: "running", parentNotice: true });
  });

  it("owes a typed message's settle only while a watcher waits on the task", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const running = (await sendTurn(w.store, child.id, { prompt: "Build it", parentNotice: true })).turn;
    // Still working, so the notice is deferred and a watcher waits on the task.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flush(w, parent.id);
    const typed = (await sendTurn(w.store, child.id, { prompt: "And this.", delivery: "queue" })).turn;
    await completeTurn(w.store, child.id, running.id, { text: "Built." });
    await completeTurn(w.store, child.id, typed.id, { text: "Done too." });
    expect((await rowOf(w, child.id)).settleGeneration).toBe(2);
  });

  it("counts a notice queued early as reported once it is delivered", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const running = (await sendTurn(w.store, child.id, { prompt: "Build it", parentNotice: true })).turn;
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flush(w, parent.id);
    await completeTurn(w.store, child.id, running.id, { text: "Built." });
    await expect.poll(async () => {
      await flush(w, parent.id);
      return (await notificationsIn(w, parent.id)).length;
    }).toBe(1);
    await expect.poll(async () => (await rowOf(w, child.id)).reportedGeneration).toBe(1);

    // A later typed message is the task's newest work: a restart that still
    // thought the first settle unsent would report it under that identity.
    await typeIntoTask(w, child.id);
    await restart(w);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  });
});

describe("delegation lock order (MXN-389)", () => {
  type World = Awaited<ReturnType<typeof world>>;

  /**
   * Run `operation` while this holds the delegation ledger lock, then take the
   * task's thread lock inside it: the order a cancellation takes them. An
   * operation holding that thread lock while it waits for the ledger would
   * deadlock against it, which shows here as the lock never coming free.
   */
  async function againstLedgerThenThread(w: World, threadId: string, operation: () => Promise<unknown>): Promise<void> {
    let running: Promise<unknown> = Promise.resolve();
    let free = false;
    await w.store.withThreadLock("!delegations", async () => {
      running = operation();
      running.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      let timer: ReturnType<typeof setTimeout> | undefined;
      free = await Promise.race([
        w.store.withThreadLock(threadId, async () => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
      clearTimeout(timer);
    });
    await running;
    expect(free).toBe(true);
  }

  /** A notifying review task with an awaited turn running, so a settle writes both delegation facts. */
  async function awaitedReview() {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    await w.store.updateDelegation(`d-${child.id}`, { reviewTask: true });
    const turn = (await sendTurn(w.store, child.id, { prompt: "Review it", parentNotice: true })).turn;
    const row = async () => (await w.store.readDelegations())[0]!;
    return { w, parent, child, turn, row };
  }

  it("settles a turn", async () => {
    const { w, child, turn, row } = await awaitedReview();
    await againstLedgerThenThread(w, child.id, () => completeTurn(w.store, child.id, turn.id, { text: "Fine.\n\nVERDICT: MERGE" }));
    expect(await row()).toMatchObject({ settleGeneration: 1, review: { verdict: "MERGE", turnId: turn.id } });
  });

  it("interrupts a turn", async () => {
    const { w, child, turn, row } = await awaitedReview();
    await againstLedgerThenThread(w, child.id, () => interruptTurn(w.store, child.id, turn.id));
    expect(await row()).toMatchObject({ settleGeneration: 1, review: { turnId: turn.id } });
  });

  it("settles a thread by stopping its work", async () => {
    const { w, child, row } = await awaitedReview();
    await againstLedgerThenThread(w, child.id, () => settleThread(w.store, child.id, { stop: true }));
    expect((await row()).settleGeneration).toBe(1);
  });

  it("reconciles an orphaned turn", async () => {
    const { w, child, turn, row } = await awaitedReview();
    await w.store.updateTurn(child.id, turn.id, { owner: { pid: 2_147_483_647, host: turn.owner!.host } });
    await againstLedgerThenThread(w, child.id, () => reconcileOrphanedTurn(w.store, child.id));
    expect((await row()).settleGeneration).toBe(1);
  });

  it("carries a delegation into a continuation", async () => {
    const { w, child, turn } = await awaitedReview();
    await completeTurn(w.store, child.id, turn.id, { text: "Fine.\n\nVERDICT: MERGE" });
    await againstLedgerThenThread(w, child.id, () => continueThread(w.ctx, { threadId: child.id }));
    await flushTurnRunners();
    expect((await w.store.readDelegations()).find((entry) => entry.childThreadId === child.id)?.continuedIn).toBeDefined();
  }, 30_000);

  it("takes back an agent's queued message", async () => {
    const { w, parent, child } = await awaitedReview();
    const queued = await queueAgentMessage(w.ctx, parent.id, { threadId: child.id, message: "Later." });
    await againstLedgerThenThread(w, child.id, () => removeAgentQueuedMessage(w.ctx, parent.id, queued.turnId));
    expect((await w.store.readTurns(child.id)).find((entry) => entry.id === queued.turnId)?.status).toBe("interrupted");
  });
});
