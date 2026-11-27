import { readFile } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, completeTurn, failTurn, sendTurn, openTurn, interruptTurn, settleThread } from "../threads.js";
import { flushTurnRunners, type TurnDriver, type TurnOutcome } from "../execute.js";
import { CliError } from "../../errors.js";
import type { ProviderRuntimeEvent } from "../../providers/spi.js";
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
  revertThread,
  runDueScheduledTurn,
  scheduleUsageContinue,
  sendTaskMessage,
  startTurn,
  taskNotificationOf,
  type OperationContext,
} from "../operations.js";
import type { ThreadStore } from "../store.js";
import { taskNotificationText } from "../notify.js";
import { UsageProtection } from "../../usage/protection.js";

afterEach(() => {
  vi.useRealTimers();
  resetUsageLimitsForTests();
});

async function world(
  config: Record<string, unknown> = {},
  harnessOptions: Parameters<typeof testHarness>[0] = {},
  script?: (driver: TurnDriver) => TurnDriver,
) {
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
        if (script) driver = script(driver);
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

/**
 * A harness driver whose turns follow a script by the order they were sent:
 * the test holds one provider run where it needs the interleaving.
 */
function scriptedDriver(
  base: TurnDriver,
  sent: readonly string[],
  behavior: (prompt: string, signal?: AbortSignal) => Promise<TurnOutcome> | TurnOutcome,
): TurnDriver {
  const driver = Object.create(base) as TurnDriver;
  let awaited = 0;
  driver.awaitTurn = (_threadId, _turnId, signal) => Promise.resolve(behavior(sent[awaited++] ?? "", signal));
  return driver;
}

function completed(text: string): TurnOutcome {
  return { status: "completed", text, usage: { input: 1, cacheRead: 0, cacheCreate: 0, output: 2, thinking: 0 }, error: null };
}

/**
 * A store whose named delegation writes pass through `gate` first: the test
 * holds one write to force an interleaving. Internal store calls bypass it.
 */
function gateStore(store: ThreadStore, methods: readonly string[], gate: () => Promise<void>): ThreadStore {
  return new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && methods.includes(property)) {
        const original = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          await gate();
          return await original.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ThreadStore;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * A driver like Claude Code waking its own session: a real event stream,
 * so the session watcher records and runs the turn the provider starts.
 */
class WakingDriver implements TurnDriver {
  private readonly sessions = new Set<string>();
  private readonly queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  private readonly outcomes = new Map<string, (outcome: TurnOutcome) => void>();
  private readonly settled = new Map<string, TurnOutcome>();
  private turn = 0;

  private settle(turnId: string, outcome: TurnOutcome): void {
    const waiter = this.outcomes.get(turnId);
    if (waiter) waiter(outcome);
    else this.settled.set(turnId, outcome);
  }

  wake(threadId: string): string {
    const turnId = `wake-${(this.turn += 1)}`;
    Effect.runSync(Queue.offer(this.queue, { type: "turn.started", provider: "codex", threadId, turnId, origin: "background" }));
    setTimeout(() => this.settle(turnId, completed("Woken.")), 5);
    return turnId;
  }

  hasSession(threadId: string) {
    return Effect.succeed(this.sessions.has(threadId));
  }
  startSession(input: { threadId: string }) {
    return Effect.sync(() => void this.sessions.add(input.threadId));
  }
  sendTurn(input: { threadId: string }) {
    return Effect.sync(() => {
      const turnId = `driver-${(this.turn += 1)}`;
      this.settle(turnId, completed("Done."));
      return { threadId: input.threadId, turnId };
    });
  }
  interruptTurn() {
    return Effect.void;
  }
  awaitTurn(_threadId: string, turnId: string): Promise<TurnOutcome> {
    const done = this.settled.get(turnId);
    if (done) return Promise.resolve(done);
    return new Promise((resolve) => this.outcomes.set(turnId, resolve));
  }
  readonly streamEvents: TurnDriver["streamEvents"] = Stream.fromQueue(this.queue);
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

  it("keeps the cancel when the interrupted turn's own settle lands after it", async () => {
    const w = await world({}, { leaveTurnsRunning: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });
    expect(running.turn.status).toBe("running");
    const cancelled = await cancelTask(w.ctx, parent.id, child.id);
    expect(cancelled.interruptRequested).toBe(true);
    // The cancel wrote its mark first; the turn it interrupted settles after.
    await running.run;
    await flushTurnRunners();
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("cancelled");
  });

  it("clears a cancelled mark when a later turn settles, not the one it stopped", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    // The mark an explicit cancel leaves names the turn it stopped.
    const stopped = (await sendTurn(w.store, child.id, { prompt: "Work" })).turn;
    await interruptTurn(w.store, child.id, stopped.id);
    const row = (await w.store.readDelegations()).find((candidate) => candidate.childThreadId === child.id)!;
    await w.store.updateDelegation(row.id, { status: "cancelled", cancelledTurnId: stopped.id });

    const resumed = await startTurn(w.ctx, { threadId: child.id, prompt: "Go on." });
    await resumed.run;
    await flushTurnRunners();
    expect((await w.store.readDelegations()).find((candidate) => candidate.childThreadId === child.id)?.status).toBe("running");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
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

describe("cancelling a running task", () => {
  it("reads the promoted follow-up's own outcome, not the cancelled turn's mark", async () => {
    const sent: string[] = [];
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const w = await world(
      {},
      { leaveTurnsRunning: true, onSendTurn: (input) => sent.push(input.prompt) },
      (base) => scriptedDriver(base, sent, async (prompt, signal) => {
        if (prompt !== "Work A") return completed("Done.");
        parked();
        return await base.awaitTurn("", "", signal);
      }),
    );
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    const queued = await sendTurn(w.store, child.id, { prompt: "Work B", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    // Stopping A promotes B, which this runner then takes to completion.
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    await running.run;
    await flushTurnRunners();

    expect((await w.store.readTurns(child.id)).at(-1)?.status).toBe("completed");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("does not let the older turn's settle erase a newer cancellation", async () => {
    const sent: string[] = [];
    let aParked!: () => void;
    const aIsParked = new Promise<void>((resolve) => { aParked = resolve; });
    let bParked!: () => void;
    const bIsParked = new Promise<void>((resolve) => { bParked = resolve; });
    const w = await world(
      {},
      { leaveTurnsRunning: true, onSendTurn: (input) => sent.push(input.prompt) },
      (base) => scriptedDriver(base, sent, async (prompt, signal) => {
        if (prompt === "Work A") {
          aParked();
          return await base.awaitTurn("", "", signal);
        }
        bParked();
        return await base.awaitTurn("", "", signal);
      }),
    );
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const first = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aIsParked;
    // A has settled in the ledger; its runner, and so its settle callback, is
    // still held (set directly: the runner's own settle would free it).
    // Cancelling now takes the idle path (no turn to stop).
    await w.store.updateTurn(child.id, first.turn.id, { status: "completed", completedAt: w.store.nowIso() });
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(false);

    // B runs and is cancelled while A's callback is still held.
    const second = await startTurn(w.ctx, { threadId: child.id, prompt: "Work B" });
    await bIsParked;
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    // Release A: its callback lands after B's cancellation is persisted, and
    // A is older than the turn that mark names.
    w.store.abortRunning(first.turn.id);
    await first.run;
    await second.run?.catch(() => undefined);
    await flushTurnRunners();

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
  });

  it("reports the task's own ending when it finished before the cancel interrupted it", async () => {
    const w = await world({}, { leaveTurnsRunning: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });
    // The cancel reads the task as live, then the turn completes before the
    // interrupt takes the thread lock. The gate stands in for that window:
    // the store hands the interrupt its lock only after the turn settled.
    let armed = false;
    const store = new Proxy(w.ctx.store, {
      get(target, property) {
        if (property === "withThreadLock") {
          return async (id: string, run: () => Promise<unknown>) => {
            if (armed && id === child.id) {
              armed = false;
              // Settle in the ledger only: the runner stays held for the cleanup.
              await target.updateTurn(child.id, running.turn.id, { status: "completed", completedAt: target.nowIso() });
            }
            return await target.withThreadLock(id, run);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof w.ctx.store;
    try {
      armed = true;
      const cancelled = await cancelTask({ ...w.ctx, store }, parent.id, child.id);
      expect(cancelled.interruptRequested).toBe(false);
      expect(cancelled.task.status).toBe("completed");
      expect(cancelled.stateAfter).toBe("completed");
      // Nothing was stopped, so the delegation is untouched and reads its own ending.
      expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
      expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
    } finally {
      w.store.abortRunning(running.turn.id);
    }
  });
});

describe("cancellations that race later work", () => {
  function scriptedWorld(
    behavior: (prompt: string, base: TurnDriver, signal?: AbortSignal) => Promise<TurnOutcome> | TurnOutcome,
  ) {
    const sent: string[] = [];
    return world(
      {},
      { leaveTurnsRunning: true, onSendTurn: (input) => sent.push(input.prompt) },
      (base) => scriptedDriver(base, sent, (prompt, signal) => behavior(prompt, base, signal)),
    );
  }

  it("does not write a mark that a follow-up already settled ahead of", async () => {
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const w = await scriptedWorld(async (prompt, base, signal) => {
      if (prompt !== "Work A") return completed("Done.");
      parked();
      return await base.awaitTurn("", "", signal);
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    await sendTurn(w.store, child.id, { prompt: "Work B", delivery: "queue" });

    // Hold the cancellation write while the promoted follow-up completes and
    // its own settle lands: the mark would arrive behind work that already ended.
    const held = deferred();
    const release = deferred();
    let first = true;
    const store = gateStore(w.store, ["updateDelegationWith", "updateDelegationIf", "updateDelegation"], async () => {
      if (!first) return;
      first = false;
      held.resolve();
      await release.promise;
    });
    const cancelling = cancelTask({ ...w.ctx, store }, parent.id, child.id);
    await held.promise;
    // Let the promoted follow-up finish and its own settle land.
    await running.run;
    await flushTurnRunners();
    expect((await w.store.readTurns(child.id)).some((turn) => turn.status === "completed")).toBe(true);
    release.resolve();
    const cancelled = await cancelling;

    expect(cancelled.task.status).toBe("completed");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
  });

  it("clears the mark for a turn promoted from a startup abort", async () => {
    const started = deferred();
    const session = deferred();
    const sent: string[] = [];
    const w = await world(
      {},
      { leaveTurnsRunning: true, onSendTurn: (input) => sent.push(input.prompt) },
      (base) => {
        const driver = scriptedDriver(base, sent, () => completed("Done."));
        const start = driver.startSession.bind(driver);
        driver.startSession = (input) =>
          Effect.tryPromise({
            try: async () => {
              started.resolve();
              await session.promise;
              return await Effect.runPromise(start(input));
            },
            catch: (cause) => new CliError("DRIVER_START_FAILED", "The test session could not start.", { cause }),
          });
        return driver;
      },
    );
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    // A is stopped while its provider session is still starting; the stop
    // promotes B, which the send path runs itself once the session returns.
    const starting = startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await started.promise;
    const queued = await sendTurn(w.store, child.id, { prompt: "Work B", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    session.resolve();
    await starting;
    await flushTurnRunners();

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("clears the mark for a turn the provider starts itself", async () => {
    const driver = new WakingDriver();
    const w = await world({}, { drivers: { codex: () => driver } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    // A first turn opens the watched session; the task is then cancelled.
    const first = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });
    await first.run;
    await flushTurnRunners();
    expect(await noteAutoContinueCancelled(w.ctx, child.id)).toBe(true);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    driver.wake(child.id);
    await vi.waitFor(async () => {
      const turns = await w.store.readTurns(child.id);
      expect(turns.some((turn) => turn.delivery === "background" && turn.status === "completed")).toBe(true);
    }, { timeout: 15_000 });
    await vi.waitFor(async () => {
      expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
    }, { timeout: 10_000 });
  });

  it("orders freshness by when the turn ran, not when it was queued", async () => {
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const w = await scriptedWorld(async (prompt, base, signal) => {
      if (prompt === "Work A") {
        parked();
        return await base.awaitTurn("", "", signal);
      }
      return completed("Done.");
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    // Q is created first but runs last: the ledger says [Q, A], execution says A then Q.
    // Due shortly in real time: promotion reads the real clock.
    const dueAt = Date.now() + 1500;
    const queued = await sendTurn(w.store, child.id, { prompt: "Work Q", scheduledFor: new Date(dueAt).toISOString() });
    expect(queued.turn.status).toBe("queued");
    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    await running.run;
    await flushTurnRunners();
    // Q still waits, so the task has live work; the mark is on the row.
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("cancelled");

    await vi.waitFor(() => expect(Date.now() >= dueAt).toBe(true), { timeout: 10_000, interval: 10 });
    expect(await runDueScheduledTurn(w.ctx, child.id)).toBe(true);
    await flushTurnRunners();
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("does not clear for a settle whose turn was reverted away", async () => {
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const w = await scriptedWorld(async (prompt, base, signal) => {
      if (prompt === "Work A") {
        parked();
        return await base.awaitTurn("", "", signal);
      }
      return completed("Done.");
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const a = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    await a.run;
    await flushTurnRunners();

    // Hold B's settle just before it would clear, then revert B and keep A.
    const held = deferred();
    const release = deferred();
    let first = true;
    const store = gateStore(w.store, ["updateDelegationWith", "updateDelegationIf"], async () => {
      if (!first) return;
      first = false;
      held.resolve();
      await release.promise;
    });
    const b = await startTurn({ ...w.ctx, store }, { threadId: child.id, prompt: "Work B" });
    await held.promise;
    await revertThread(w.ctx, child.id, 1);
    release.resolve();
    await b.run;
    await flushTurnRunners();

    expect((await w.store.readTurns(child.id)).some((turn) => turn.id === b.turn.id)).toBe(false);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
  });

  it("does not let an older settle erase a newer recovery cancellation", async () => {
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const bRunning = deferred();
    const bRelease = deferred();
    const w = await scriptedWorld(async (prompt, base, signal) => {
      if (prompt === "Work A") {
        parked();
        return await base.awaitTurn("", "", signal);
      }
      bRunning.resolve();
      await bRelease.promise;
      return completed("Done.");
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const a = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    await a.run;
    await flushTurnRunners();
    // Hold B's settle just before its generation check, then cancel the recovery.
    const held = deferred();
    const release = deferred();
    let first = true;
    const store = gateStore(w.store, ["updateDelegationWith", "updateDelegationIf"], async () => {
      if (!first) return;
      first = false;
      held.resolve();
      await release.promise;
    });
    const b = await startTurn({ ...w.ctx, store }, { threadId: child.id, prompt: "Work B" });
    await bRunning.promise;
    bRelease.resolve();
    await held.promise;
    // A usage-reset continue waits on the settled task, then is cancelled
    // while the older settle is held just before its write.
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const cont = (await sendTurn(w.store, child.id, {
      prompt: "Continue later.",
      queue: { conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread", automatic: true },
      scheduledFor: at,
      scheduleReason: "usage-reset",
    })).turn;
    expect(cont.status).toBe("queued");
    expect(await cancelAutoContinue(w.ctx, child.id)).toBe(true);
    release.resolve();
    await b.run;
    await flushTurnRunners();

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");
  });

  it("clears a cancelled mark when the cancelled turn was reverted and new work completes", async () => {
    let parked!: () => void;
    const aParked = new Promise<void>((resolve) => { parked = resolve; });
    const w = await scriptedWorld(async (prompt, base, signal) => {
      if (prompt === "Work A") {
        parked();
        return await base.awaitTurn("", "", signal);
      }
      return completed("Fresh work done.");
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);

    const a = await startTurn(w.ctx, { threadId: child.id, prompt: "Work A" });
    await aParked;
    expect((await cancelTask(w.ctx, parent.id, child.id)).interruptRequested).toBe(true);
    await a.run;
    await flushTurnRunners();
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("cancelled");

    // Reverting to 0 drops the cancelled turn from the ledger; fresh work
    // that runs afterwards must replace the cancelled mark instead of leaving
    // the task stuck cancelled.
    await revertThread(w.ctx, child.id, 0);
    const b = await startTurn(w.ctx, { threadId: child.id, prompt: "Work B" });
    await b.run;
    await flushTurnRunners();

    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("leaves a finished task alone when the cancel stops nothing", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const turn = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });
    await turn.run;
    await flushTurnRunners();

    const cancelled = await cancelTask(w.ctx, parent.id, child.id);
    expect(cancelled.interruptRequested).toBe(false);
    expect(cancelled.task.status).toBe("completed");
    expect((await w.store.readDelegations()).find((row) => row.childThreadId === child.id)?.status).toBe("running");
    expect((await describeTask(w.ctx, parent.id, child.id)).task.status).toBe("completed");
  });

  it("builds the finished reply from a fresh projection", async () => {
    const w = await world({}, { leaveTurnsRunning: true });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const running = await startTurn(w.ctx, { threadId: child.id, prompt: "Work" });

    // The turn completes in the window between the cancel's read and its
    // interrupt: the reply must be the task as it now is, not the pre-read.
    let armed = false;
    const store = new Proxy(w.ctx.store, {
      get(target, property) {
        if (property === "withThreadLock") {
          return async (id: string, run: () => Promise<unknown>) => {
            if (armed && id === child.id) {
              armed = false;
              await target.updateTurn(child.id, running.turn.id, { status: "completed", completedAt: target.nowIso() });
            }
            return await target.withThreadLock(id, run);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof w.ctx.store;
    try {
      armed = true;
      const cancelled = await cancelTask({ ...w.ctx, store }, parent.id, child.id);
      const fresh = await describeTask(w.ctx, parent.id, child.id);
      expect(cancelled.task.workState).toBe(fresh.task.workState);
      expect(cancelled.task).toMatchObject({ status: "completed", workState: "result_available" });
      expect(cancelled.interruptRequested).toBe(false);
      expect(cancelled.stateAfter).toBe("completed");
      expect(fresh.task).toMatchObject({ status: "completed", workState: "result_available" });
    } finally {
      w.store.abortRunning(running.turn.id);
    }
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
