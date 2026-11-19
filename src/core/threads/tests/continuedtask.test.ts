import * as Effect from "effect/Effect";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { createThread, deleteThread, sendTurn, openTurn, completeTurn, interruptTurn, startBackgroundTurn, updateThreadMeta, trackContinuation, untrackContinuation, settleThread, isContinuationBusy } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { continueThread, continueOwnThread, cancelTask, describeTask, delegate, flushTaskNotifications, prepareQueuedHandoff, queueTaskNotification, recoverTaskNotifications, runDueScheduledTurn, runWorkQueue, runningTasksNote, type OperationContext } from "../operations.js";
import { parseQueuePolicy } from "../queue.js";
import { driverKindOfInstance } from "../../types.js";
import type { StoredThread } from "../types.js";

afterEach(() => {
  vi.useRealTimers();
  resetUsageLimitsForTests();
});

async function world() {
  const harness = await testHarness();
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: harness.config, driverFor: (id) => {
    const kind = driverKindOfInstance(id)!;
    let driver = drivers.get(kind);
    if (!driver) { driver = harness.drivers[kind]!(); drivers.set(kind, driver); }
    return driver;
  } };
  const make = (title: string) => createThread(harness.store, { projectId: "p", title, env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
  return { ...harness, ctx, make };
}

async function notificationsIn(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<string[]> {
  return (await w.store.readMessages(threadId)).filter((message) => message.origin === "task-notification").map((message) => message.text);
}

describe("a delegated task continued in a new thread", () => {
  // Two continuations plus a ten-second notification wait: a loaded runner does not fit in fifteen seconds.
  it("reports to its parent once, from the continuation, naming the original task", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const first = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, first.id, { text: "Stopped at the usage limit." });

    const continued = await continueThread(w.ctx, { threadId: child.id, automatic: true });
    const again = await continueThread(w.ctx, { threadId: child.id, automatic: true, destinationThreadId: continued.threadId });
    expect(again.threadId).toBe(continued.threadId);

    const rows = await w.store.readDelegations();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "d1")?.continuedIn).toBe(continued.threadId);
    expect(rows.find((row) => row.childThreadId === continued.threadId)).toMatchObject({ parentThreadId: parent.id, notify: true, continuesTaskId: child.id });

    // The source settling by handing off is not the task finishing; the continuation's run ending is.
    queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTurnRunners();
    expect(openTurn(await w.store.readTurns(continued.threadId))).toBeNull();
    let sent: string[] = [];
    for (let waited = 0; waited < 10_000; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await flushTurnRunners();
      sent = await notificationsIn(w, parent.id);
      if (sent.length > 0) break;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`taskId ${continued.threadId}, continued from taskId ${child.id}`);
    expect(sent[0]).not.toContain(`(taskId ${child.id}`);
  }, 30_000);

  it("leaves a thread that was not delegated without a delegation row", async () => {
    const w = await world();
    const thread = await w.make("solo");
    const turn = (await sendTurn(w.store, thread.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, thread.id, turn.id, { text: "Done for now." });
    await continueThread(w.ctx, { threadId: thread.id });
    expect(await w.store.readDelegations()).toEqual([]);
  });

  /** MXN-290: a task notification never starts a turn on a deleted parent, like archived. */
  it("drops a task notification for a deleted parent instead of starting a turn", async () => {
    const w = await world();
    const parent = await w.make("parent");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const turn = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, turn.id, { text: "Done." });
    await deleteThread(w.store, parent.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await w.store.readTurns(parent.id)).toHaveLength(0);
    // Dropped with one line in the server log; nothing more (MXN-290 review).
    const log = await readFile(path.join(w.root, "server.log"), "utf8").catch(() => "");
    expect(log).toContain(`parent ${parent.id} is deleted`);
  });
});

describe("an orchestrator continued in a new thread", () => {
  // Four threads plus a ten-second notification wait: a loaded runner does not fit in fifteen seconds.
  it("takes its running and idle tasks along: listed in the handoff, reporting to the new thread", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const running = await w.make("still running");
    const done = await w.make("already done");
    const limited = await w.make("stopped by a limit");
    const now = new Date().toISOString();
    // Every row says running: the ledger is not updated when a task finishes, so the task's own turns decide.
    for (const [id, child] of [["r", running], ["d", done], ["l", limited]] as const) {
      await w.store.appendDelegation({ id, parentThreadId: parent.id, childThreadId: child.id, prompt: id, status: "running", notify: true, createdAt: now, updatedAt: now });
    }
    await sendTurn(w.store, running.id, { prompt: "A", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    const finished = (await sendTurn(w.store, done.id, { prompt: "B" })).turn;
    await completeTurn(w.store, done.id, finished.id, { text: "Done." });
    const stopped = (await sendTurn(w.store, limited.id, { prompt: "C" })).turn;
    await w.store.appendLedger(limited.id, "activity", { id: "limit", threadId: limited.id, turnId: stopped.id, kind: "usage.limit", summary: "Usage limit reached", payload: {}, createdAt: w.store.nowIso() });
    await completeTurn(w.store, limited.id, stopped.id, { text: "Stopped at the limit." });
    const turn = (await sendTurn(w.store, parent.id, { prompt: "Orchestrate" })).turn;
    await completeTurn(w.store, parent.id, turn.id, { text: "Waiting on tasks." });

    const continued = await continueThread(w.ctx, { threadId: parent.id });
    const rows = await w.store.readDelegations();
    // Running, idle and limit-stopped alike: the new thread owns every delegation row now.
    expect(rows.find((row) => row.id === "r")?.parentThreadId).toBe(continued.threadId);
    expect(rows.find((row) => row.id === "d")?.parentThreadId).toBe(continued.threadId);
    expect(rows.find((row) => row.id === "l")?.parentThreadId).toBe(continued.threadId);
    const prompt = (await w.store.readMessages(continued.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain(`"still running" (taskId ${running.id})`);
    expect(prompt).toContain(`"stopped by a limit" (taskId ${limited.id})`);
    expect(prompt).toContain(`"already done" (taskId ${done.id})`);
    await flushTurnRunners();

    // A notification batched for the old parent before the move still reaches the new one.
    const waiting = (await w.store.readTurns(running.id)).find((turn) => turn.status === "queued")!;
    await interruptTurn(w.store, running.id, waiting.id);
    queueTaskNotification(w.ctx, parent.id, running.id);
    for (let waited = 0; waited < 10_000; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await flushTurnRunners();
      if ((await notificationsIn(w, continued.threadId)).length > 0) break;
    }
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect((await notificationsIn(w, continued.threadId)).join("\n")).toContain(`taskId ${running.id}`);
  }, 30_000);

  it("adds no note when no task is running", () => {
    expect(runningTasksNote([])).toBe("");
  });
});

describe("a limited thread continued in a new one", () => {
  async function limitedSource(w: Awaited<ReturnType<typeof world>>) {
    const source = await w.make("limited work");
    const turn = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt }]);
    await w.store.appendLedger(source.id, "activity", { id: "limit", threadId: source.id, turnId: turn.id, kind: "usage.limit", summary: "Usage limit reached", payload: { provider: "codex", rateLimitType: null, label: "Session", resetsAt }, createdAt: w.store.nowIso() });
    await completeTurn(w.store, source.id, turn.id, { text: "Stopped at the limit." });
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, usagePause: { provider: "codex", windows: [], resetsAt, order: 1, phase: "waiting", handoff: false }, updatedAt: w.store.nowIso() });
    });
    return { source, resetsAt };
  }

  it("inherits the hold for the reset: waiting, with the first turn as its recovery and the limit marker", async () => {
    const w = await world();
    const { source, resetsAt } = await limitedSource(w);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: at });

    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    const first = (await w.store.readTurns(continued.threadId))[0]!;
    // Held for the reset, not released: the first turn is the recovery entry.
    expect(first).toMatchObject({ status: "queued", scheduledFor: at });
    // A scheduled destination still lands the handoff: the claim is gone.
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect(destination.usagePause).toMatchObject({ provider: "codex", resetsAt, phase: "waiting", recoveryTurnId: first.id });
    // The limit marker travels along, so the new thread shows the block from the start.
    expect((await w.store.readActivities(continued.threadId)).find((activity) => activity.kind === "usage.limit")).toMatchObject({
      summary: "Usage limit reached",
      payload: { provider: "codex", label: "Session", resetsAt },
    });
  });

  it("holds a task notification on the continued thread without spending a turn", async () => {
    const w = await world();
    const { source } = await limitedSource(w);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: at });

    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: continued.threadId, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const finished = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, finished.id, { text: "Done." });
    await queueTaskNotification(w.ctx, continued.threadId, child.id);
    await flushTurnRunners();
    // Held durably, not run into the wall: nothing is running, no turn spent.
    expect(openTurn(await w.store.readTurns(continued.threadId))).toBeNull();
    expect(await w.store.readTurns(continued.threadId)).toHaveLength(1);
    expect((await w.store.readMessages(continued.threadId)).some((message) => message.origin === "task-notification")).toBe(false);
    const batches = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8").catch(() => "{}")) as Record<string, unknown[]>;
    expect(batches[continued.threadId]).toHaveLength(1);

    // Once the hold lifts and the reset lapses, the notice is delivered instead of waiting forever.
    await w.store.withThreadLock(continued.threadId, async () => {
      const current = (await w.store.readThreadRecord(continued.threadId))!;
      await w.store.writeThreadRecord({ ...current, usagePause: null });
    });
    resetUsageLimitsForTests();
    await flushTaskNotifications(w.ctx, continued.threadId);
    await flushTurnRunners();
    expect((await w.store.readMessages(continued.threadId)).some((message) => message.origin === "task-notification")).toBe(true);
  });

  it("an immediate continue of an unpaused thread still starts its first turn at once, with no hold", async () => {
    const w = await world();
    const source = await w.make("solo");
    const turn = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, turn.id, { text: "Done for now." });
    const continued = await continueThread(w.ctx, { threadId: source.id });
    await flushTurnRunners();
    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    expect(destination.usagePause).toBeUndefined();
    expect((await w.store.readActivities(continued.threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
    expect(openTurn(await w.store.readTurns(continued.threadId))).toBeNull();
  });

  it("does not inherit the hold on a different provider: the scheduled turn waits for nothing", async () => {
    const w = await world();
    const { source } = await limitedSource(w);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, {
      threadId: source.id,
      scheduledFor: at,
      modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
    });
    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    // The codex limit does not apply to the claude thread: no hold, no marker —
    // just the scheduled turn, which admission runs at its time.
    expect(destination.usagePause).toBeUndefined();
    expect((await w.store.readTurns(continued.threadId))[0]).toMatchObject({ status: "queued", scheduledFor: at });
    expect((await w.store.readActivities(continued.threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
  });

  it("does not inherit a hold whose reset already passed", async () => {
    const w = await world();
    const { source } = await limitedSource(w);
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({
        ...current,
        usagePause: { ...current.usagePause!, resetsAt: new Date(Date.now() - 60_000).toISOString() },
        updatedAt: w.store.nowIso(),
      });
    });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: at });
    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    expect(destination.usagePause).toBeUndefined();
    expect((await w.store.readTurns(continued.threadId))[0]).toMatchObject({ status: "queued", scheduledFor: at });
    expect((await w.store.readActivities(continued.threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
  });

  it("does not inherit a hold when no limit stands any more", async () => {
    const w = await world();
    const { source } = await limitedSource(w);
    resetUsageLimitsForTests();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: at });
    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    expect(destination.usagePause).toBeUndefined();
    expect((await w.store.readTurns(continued.threadId))[0]).toMatchObject({ status: "queued", scheduledFor: at });
    expect((await w.store.readActivities(continued.threadId)).some((activity) => activity.kind === "usage.limit")).toBe(false);
  });
});

describe("concurrent continuations of one thread", () => {
  it("two overlapping calls share one destination instead of creating two", async () => {
    const w = await world();
    const source = await w.make("solo");
    const turn = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, turn.id, { text: "Done for now." });
    const [first, second] = await Promise.all([
      continueThread(w.ctx, { threadId: source.id }),
      continueThread(w.ctx, { threadId: source.id }),
    ]);
    expect(second.threadId).toBe(first.threadId);
    expect((await w.store.readTurns(first.threadId))).toHaveLength(1);
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(1);
  });

  it("a sequential retry returns the existing destination instead of duplicating it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const turn = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, turn.id, { text: "Done for now." });
    const first = await continueThread(w.ctx, { threadId: source.id });
    const second = await continueThread(w.ctx, { threadId: source.id });
    expect(second.threadId).toBe(first.threadId);
    expect((await w.store.readTurns(first.threadId))).toHaveLength(1);
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(1);
  });
});

describe("a thread continued in a new one", () => {
  /** The codex test driver, with the calls that end a session or a background task recorded. */
  function watch(w: Awaited<ReturnType<typeof world>>, tasks: readonly string[] = []) {
    const driver = w.ctx.driverFor("codex") as TurnDriver & { stopSession?: unknown; backgroundTasks?: unknown; stopBackgroundTask?: unknown };
    const stopped: string[] = [];
    const taskStops: string[] = [];
    driver.stopSession = (threadId: string) => Effect.sync(() => void stopped.push(threadId));
    driver.backgroundTasks = () => tasks.map((taskId) => ({ taskId, taskType: "local_bash", description: taskId }));
    driver.stopBackgroundTask = (threadId: string, taskId: string) => Effect.sync(() => void taskStops.push(`${threadId}:${taskId}`));
    return { stopped, taskStops };
  }

  it("carries an unclaimed run-size mark to the new thread, and none when there is none", async () => {
    const w = await world();
    const marked = await w.make("researching");
    await updateThreadMeta(w.store, marked.id, { interactionMode: "research" });
    expect((await w.store.readThreadRecord(marked.id))?.researchPicker).toBe(true);
    const plain = await w.make("building");
    const movedMarked = await continueThread(w.ctx, { threadId: marked.id });
    const movedPlain = await continueThread(w.ctx, { threadId: plain.id });
    expect((await w.store.readThreadRecord(movedMarked.threadId))?.researchPicker).toBe(true);
    expect((await w.store.readThreadRecord(movedPlain.threadId))?.researchPicker).toBeUndefined();
  });

  it("carries an unclaimed run-size mark into an existing destination that has none", async () => {
    const w = await world();
    const marked = await w.make("researching");
    await updateThreadMeta(w.store, marked.id, { interactionMode: "research" });
    const plain = await w.make("destination");
    const moved = await continueThread(w.ctx, { threadId: marked.id, destinationThreadId: plain.id });
    expect(moved.threadId).toBe(plain.id);
    expect((await w.store.readThreadRecord(plain.id))?.researchPicker).toBe(true);
    const other = await w.make("unmarked");
    const elsewhere = await w.make("elsewhere");
    await continueThread(w.ctx, { threadId: other.id, destinationThreadId: elsewhere.id });
    expect((await w.store.readThreadRecord(elsewhere.id))?.researchPicker).toBeUndefined();
  });

  it("ends its session so a background task cannot wake it, and leaves every other thread's session alone", async () => {
    const w = await world();
    const old = await w.make("old");
    const other = await w.make("still live");
    for (const thread of [old, other]) {
      const turn = (await sendTurn(w.store, thread.id, { prompt: "Work" })).turn;
      await completeTurn(w.store, thread.id, turn.id, { text: "Done." });
    }
    const calls = watch(w);
    const continued = await continueThread(w.ctx, { threadId: old.id });
    expect(calls.stopped).toEqual([old.id]);
    expect(calls.stopped).not.toContain(other.id);
    expect(calls.stopped).not.toContain(continued.threadId);
  });

  it("refuses while a turn is still open on it, stopping or creating nothing", async () => {
    const w = await world();
    const old = await w.make("old");
    const running = (await sendTurn(w.store, old.id, { prompt: "Work" })).turn;
    const calls = watch(w, ["watcher"]);
    const before = await w.store.listThreadIds();
    // MXN-372: a manual continue beside an active turn would start a second
    // worker in the same checkout, so the server refuses before touching it.
    await expect(continueThread(w.ctx, { threadId: old.id })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(calls.taskStops).toEqual([]);
    expect(calls.stopped).toEqual([]);
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readActivities(old.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    // The same call goes through once the turn settles.
    await completeTurn(w.store, old.id, running.id, { text: "Done." });
    const continued = await continueThread(w.ctx, { threadId: old.id });
    expect(calls.stopped).toEqual([old.id]);
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(old.id);
  });

  it("ends the orchestrator's session but not a running child's, which moves to the new thread", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    await sendTurn(w.store, child.id, { prompt: "Build it" });
    const turn = (await sendTurn(w.store, parent.id, { prompt: "Plan" })).turn;
    await completeTurn(w.store, parent.id, turn.id, { text: "Delegated." });
    const calls = watch(w);
    const continued = await continueThread(w.ctx, { threadId: parent.id });
    expect(calls.stopped).toEqual([parent.id]);
    expect((await w.store.readDelegations()).find((row) => row.id === "d1")?.parentThreadId).toBe(continued.threadId);
  });
});

describe("a manual continue with an active turn (MXN-372)", () => {
  it("refuses a running parent and a running delegated child, each naming its own turn", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const parentRunning = (await sendTurn(w.store, parent.id, { prompt: "Plan" })).turn;
    const childRunning = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    const before = await w.store.listThreadIds();

    await expect(continueThread(w.ctx, { threadId: parent.id })).rejects.toThrow("has an active turn");
    await expect(continueThread(w.ctx, { threadId: child.id })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(await w.store.listThreadIds()).toEqual(before);
    for (const id of [parent.id, child.id]) {
      expect((await w.store.readActivities(id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    }

    // Each goes through once its own turn settles; the other thread's turn does not matter.
    await completeTurn(w.store, parent.id, parentRunning.id, { text: "Delegated." });
    const continued = await continueThread(w.ctx, { threadId: parent.id });
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(parent.id);
    await completeTurn(w.store, child.id, childRunning.id, { text: "Done." });
    await flushTurnRunners();
  });

  it("still continues an idle thread with scheduled work", async () => {
    const w = await world();
    const source = await w.make("solo");
    const first = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, first.id, { text: "Done for now." });
    // Queued for later is not running: an idle thread with schedules still continues.
    await sendTurn(w.store, source.id, { prompt: "Later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });

    const continued = await continueThread(w.ctx, { threadId: source.id });
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(source.id);
    expect(openTurn(await w.store.readTurns(continued.threadId))).not.toBeNull();
    // The handoff landed: its claim is gone, so the old thread takes work again.
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    await flushTurnRunners();
  });

  it("two overlapping continues on a running source both refuse, creating nothing", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const before = await w.store.listThreadIds();

    // One shared run, rejected before any reservation: both callers see the
    // refusal and neither leaves a destination or a note behind.
    const outcomes = await Promise.allSettled([continueThread(w.ctx, { threadId: source.id }), continueThread(w.ctx, { threadId: source.id })]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    for (const outcome of outcomes) expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "THREAD_BUSY" });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    await interruptTurn(w.store, source.id, running.id);
  });

  it("a send that lands first refuses the continue with no side effects", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const before = await w.store.listThreadIds();

    // Admission won: the refusal lands before any note, destination or claim.
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    await interruptTurn(w.store, source.id, running.id);
  });

  it("a reservation failure after the claim still releases the source at once", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done for now." });
    const before = await w.store.listThreadIds();

    // Fail the continuation note: after the claim record is written, before
    // the reservation returns. The cleanup owns the whole reservation, so
    // the registered token and the record are both released.
    const realAppend = w.store.appendLedger.bind(w.store);
    let failOnce = true;
    w.store.appendLedger = ((...args: Parameters<typeof w.store.appendLedger>) => {
      if (failOnce && args[1] === "activity") {
        failOnce = false;
        return Promise.reject(new Error("injected ledger failure"));
      }
      return realAppend(...args);
    }) as typeof w.store.appendLedger;
    try {
      await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toThrow("injected ledger failure");
    } finally {
      delete (w.store as unknown as Record<string, unknown>).appendLedger;
    }
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);

    // Admission works immediately — no registered token blocks it — and a
    // retry of the same continue lands.
    const sent = await sendTurn(w.store, source.id, { prompt: "Work after failure" });
    expect(sent.turn.status).toBe("running");
    await interruptTurn(w.store, source.id, sent.turn.id);
    const continued = await continueThread(w.ctx, { threadId: source.id });
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(source.id);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    await flushTurnRunners();
    for (const threadId of [source.id, continued.threadId]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("refuses admission while the handoff is in flight, then lets the old thread work again", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done for now." });
    // A due scheduled turn: queued, so the source is idle and continuable.
    const later = (await sendTurn(w.store, source.id, { prompt: "Later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })).turn;
    await w.store.withThreadLock(source.id, () => w.store.updateTurn(source.id, later.id, { scheduledFor: new Date(Date.now() - 60_000).toISOString() }));

    // Hold the destination's session setup open: the handoff is in flight
    // from the first setup call until the gate releases.
    let releaseSetup!: () => void;
    let enteredSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
    const enteredGate = new Promise<void>((resolve) => { enteredSetup = resolve; });
    const inner = w.ctx.driverFor;
    const blockingCtx: OperationContext = {
      ...w.ctx,
      driverFor: (id) => {
        const driver = inner(id);
        if (id !== "codex") return driver;
        // A copy with the prototype intact: spreading a class instance
        // would drop its methods.
        const blocking = Object.create(Object.getPrototypeOf(driver), Object.getOwnPropertyDescriptors(driver));
        blocking.startSession = (input: Parameters<TurnDriver["startSession"]>[0]) => {
          enteredSetup();
          return Effect.flatMap(Effect.promise(() => setupGate), () => (driver.startSession as TurnDriver["startSession"])(input));
        };
        return blocking;
      },
    };
    const continuing = continueThread(blockingCtx, { threadId: source.id });
    await enteredGate;

    // The continuation won: its claim stands, the destination exists, and
    // nothing may start on the source — plain sends, background wake-ups
    // and scheduled admission alike.
    expect((await w.store.readThreadRecord(source.id))?.continueClaim?.token).toEqual(expect.any(String));
    expect(openTurn(await w.store.readTurns(source.id))).toBeNull();
    expect(await w.store.listThreadIds()).toHaveLength(2);
    // Age the live claim past the stale-claim TTL: the handoff is still
    // running here, so admission still refuses — liveness is the
    // registration, not the clock.
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({
        ...current,
        continueClaim: { ...current.continueClaim!, at: new Date(Date.now() - 120_000).toISOString() },
        updatedAt: w.store.nowIso(),
      });
    });
    expect((await w.store.readThreadRecord(source.id))?.continueClaim?.token).toEqual(expect.any(String));
    await expect(sendTurn(w.store, source.id, { prompt: "Racing send" })).rejects.toThrow("being continued");
    await expect(
      startBackgroundTurn(w.store, source.id, { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }),
    ).rejects.toThrow("being continued");
    expect(await w.store.readTurns(source.id)).toHaveLength(2);
    expect(await runDueScheduledTurn(blockingCtx, source.id)).toBe(false);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === later.id)?.status).toBe("queued");

    // The handoff lands: the claim clears and the old thread takes work
    // again — a fresh send starts, and once it settles the due turn the
    // window held back is admitted.
    releaseSetup();
    const continued = await continuing;
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    const followUp = await sendTurn(w.store, source.id, { prompt: "After the handoff" });
    expect(followUp.turn.status).toBe("running");
    await interruptTurn(w.store, source.id, followUp.turn.id);
    expect(await runDueScheduledTurn(blockingCtx, source.id)).toBe(true);
    await flushTurnRunners();
    for (const threadId of [source.id, continued.threadId]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("heals a dead continuation claim instead of blocking sends", async () => {
    const w = await world();
    const source = await w.make("solo");
    const old = new Date(Date.now() - 3_600_000).toISOString();
    // A stale claim from a handoff that died with its process (pid 1 is
    // alive on this host, so this pins the age backstop, not liveness).
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, continueClaim: { token: "dead", pid: 1, host: os.hostname(), at: old }, updatedAt: w.store.nowIso() });
    });
    const sent = await sendTurn(w.store, source.id, { prompt: "Work" });
    expect(sent.turn.status).toBe("running");
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    // A fresh claim from a dead process on this host heals the same way.
    await interruptTurn(w.store, source.id, sent.turn.id);
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, continueClaim: { token: "dead", pid: 999_999_999, host: os.hostname(), at: new Date().toISOString() }, updatedAt: w.store.nowIso() });
    });
    const resumed = await sendTurn(w.store, source.id, { prompt: "Work again" });
    expect(resumed.turn.status).toBe("running");
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    await interruptTurn(w.store, source.id, resumed.turn.id);
  });

  it("still blocks sends on a fresh claim its host cannot judge", async () => {
    const w = await world();
    const source = await w.make("solo");
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, continueClaim: { token: "remote", pid: 1, host: "another-machine", at: new Date().toISOString() }, updatedAt: w.store.nowIso() });
    });
    await expect(sendTurn(w.store, source.id, { prompt: "Work" })).rejects.toThrow("being continued");
    expect((await w.store.readThreadRecord(source.id))?.continueClaim?.token).toBe("remote");
  });

  it("refuses a plain send under a live claim without touching usage protection", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done for now." });
    const recovery = (await sendTurn(w.store, source.id, { prompt: "Later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })).turn;
    expect(recovery.status).toBe("queued");
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, usagePause: { provider: "codex", windows: [], resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, phase: "waiting", handoff: false, recoveryTurnId: recovery.id }, updatedAt: w.store.nowIso() });
    });
    // A live manual-continuation claim stands on the source.
    const token = w.store.newId();
    trackContinuation(token);
    try {
      await w.store.withThreadLock(source.id, async () => {
        const current = (await w.store.readThreadRecord(source.id))!;
        await w.store.writeThreadRecord({ ...current, continueClaim: { token, pid: process.pid, host: os.hostname(), at: new Date().toISOString() }, updatedAt: w.store.nowIso() });
      });
      // The plain send would release the hold and start a turn: refused
      // before it writes anything.
      await expect(sendTurn(w.store, source.id, { prompt: "Work now" })).rejects.toMatchObject({ code: "THREAD_BUSY" });
      const record = (await w.store.readThreadRecord(source.id))!;
      expect(record.usagePause).toMatchObject({ provider: "codex", phase: "waiting", recoveryTurnId: recovery.id });
      expect(record.settledAt).toBeNull();
      const turns = await w.store.readTurns(source.id);
      expect(turns.find((t) => t.id === recovery.id)).toMatchObject({ status: "queued" });
      expect(turns.filter((t) => t.queue?.removed === true)).toHaveLength(0);
      // A queued delivery still goes through behind the claim.
      const queued = await sendTurn(w.store, source.id, { prompt: "Queued", delivery: "queue" });
      expect(queued.turn.status).toBe("queued");
      await interruptTurn(w.store, source.id, queued.turn.id);
    } finally {
      untrackContinuation(token);
    }
  });

  it("prepares a queued handoff past a dead claim instead of deferring it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const queued = (await sendTurn(w.store, source.id, { prompt: "Handoff", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    expect(queued.status).toBe("queued");
    // A dead claim (crashed handoff, unregistered token): the queue pass
    // heals it and prepares the handoff instead of deferring the entry.
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, continueClaim: { token: "dead", pid: 999_999_999, host: os.hostname(), at: new Date(Date.now() - 3_600_000).toISOString() }, updatedAt: w.store.nowIso() });
    });
    await prepareQueuedHandoff(w.ctx, source.id, queued.id, Date.now());
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    const after = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
    expect(after.status).toBe("completed");
    expect(after.handoff).toBeDefined();
    expect(await w.store.readThreadRecord(after.handoff!.destinationThreadId)).not.toBeNull();
    await flushTurnRunners();
    for (const id of [source.id, after.handoff!.destinationThreadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("refuses a manual continue on a stuck unknown-status turn", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await w.store.withThreadLock(source.id, () => w.store.updateTurn(source.id, running.id, { status: "mystery" as "queued" }));
    const before = await w.store.listThreadIds();
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readActivities(source.id)).filter((a) => a.kind === "thread.continued")).toHaveLength(0);
  });

  it("admits a send right after a failed claim clear, without waiting out the TTL", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done for now." });
    // Fail only the claim-clearing write: the handoff lands, but its record
    // keeps a claim whose owner is already gone.
    const realWrite = w.store.writeThreadRecord.bind(w.store);
    let failedOnce = false;
    w.store.writeThreadRecord = (async (record: StoredThread) => {
      if (!failedOnce && record.id === source.id && record.continueClaim == null) {
        const current = await w.store.readThreadRecord(source.id);
        if (current?.continueClaim) {
          failedOnce = true;
          throw new Error("injected clear failure");
        }
      }
      return realWrite(record);
    }) as typeof w.store.writeThreadRecord;
    try {
      const continued = await continueThread(w.ctx, { threadId: source.id });
      expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(source.id);
    } finally {
      delete (w.store as unknown as Record<string, unknown>).writeThreadRecord;
    }
    expect(failedOnce).toBe(true);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).not.toBeNull();
    // Admission heals the dead claim at once instead of stalling to the TTL.
    const sent = await sendTurn(w.store, source.id, { prompt: "Work again" });
    expect(sent.turn.status).toBe("running");
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    await interruptTurn(w.store, source.id, sent.turn.id);
    await flushTurnRunners();
    for (const id of [source.id]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("refuses a manual continue while an agent continuation is in flight on a running source", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    // The agent's run is in flight (not awaited): the manual request must not
    // join it — no shared destination, no skipped busy check, no claim.
    const agent = continueThread(w.ctx, { threadId: source.id, byAgent: true });
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({ code: "THREAD_BUSY" });
    // The refused manual wrote nothing: the source carries no claim.
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    const continued = await agent;
    expect((await w.store.readThreadRecord(continued.threadId))?.continuedFrom).toBe(source.id);
    await interruptTurn(w.store, source.id, running.id);
    await flushTurnRunners();
    for (const id of [source.id, continued.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("runs a manual continue after an in-flight automatic one on the same destination, starting one turn", async () => {
    const w = await world();
    const source = await w.make("solo");
    // Automatic recovery in flight (not awaited) on an idle source: the
    // manual request waits for it, then rejoins its destination instead of
    // racing a second handoff beside it.
    const auto = continueThread(w.ctx, { threadId: source.id, automatic: true });
    const manual = await continueThread(w.ctx, { threadId: source.id });
    const landed = await auto;
    expect(manual.threadId).toBe(landed.threadId);
    // Exactly one destination, and its first turn started exactly once.
    expect((await w.store.listThreadIds()).filter((id) => id !== source.id)).toEqual([landed.threadId]);
    expect(await w.store.readTurns(landed.threadId)).toHaveLength(1);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    await flushTurnRunners();
    for (const id of [source.id, landed.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("gives a later agent request the agent's destination while a manual waits on it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const agent = continueThread(w.ctx, { threadId: source.id, byAgent: true });
    const manual = continueThread(w.ctx, { threadId: source.id });
    // Non-manual requests keep joining the in-flight agent run, even while
    // a manual waits on it — the agent's destination, not a rejection.
    const second = await continueThread(w.ctx, { threadId: source.id, byAgent: true });
    const landed = await agent;
    expect(second.threadId).toBe(landed.threadId);
    await expect(manual).rejects.toMatchObject({ code: "THREAD_BUSY" });
    await interruptTurn(w.store, source.id, running.id);
    await flushTurnRunners();
    for (const id of [source.id, landed.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("holds a stored queued handoff behind a live claim instead of preparing beside it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const queued = (await sendTurn(w.store, source.id, { prompt: "Handoff", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    expect(queued.status).toBe("queued");
    const before = await w.store.listThreadIds();
    // A live manual continuation claims the source: the queue pass leaves the
    // entry queued and creates no second thread.
    const token = w.store.newId();
    trackContinuation(token);
    try {
      await w.store.withThreadLock(source.id, async () => {
        const current = (await w.store.readThreadRecord(source.id))!;
        await w.store.writeThreadRecord({ ...current, continueClaim: { token, pid: process.pid, host: os.hostname(), at: new Date().toISOString() }, updatedAt: w.store.nowIso() });
      });
      await runWorkQueue(w.ctx);
      expect(await w.store.listThreadIds()).toEqual(before);
      const waiting = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
      expect(waiting.status).toBe("queued");
      expect((await w.store.readThreadRecord(source.id))?.continueClaim?.token).toBe(token);
    } finally {
      untrackContinuation(token);
    }
    // Once the claim clears, the next pass prepares the handoff.
    await w.store.withThreadLock(source.id, async () => {
      const current = (await w.store.readThreadRecord(source.id))!;
      await w.store.writeThreadRecord({ ...current, continueClaim: null, updatedAt: w.store.nowIso() });
    });
    await runWorkQueue(w.ctx);
    const after = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
    expect(after.status).toBe("completed");
    expect(after.handoff).toBeDefined();
    expect(await w.store.readThreadRecord(after.handoff!.destinationThreadId)).not.toBeNull();
    await flushTurnRunners();
    for (const id of [source.id, after.handoff!.destinationThreadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("refuses a wakeSettled send under a live claim without touching settlement", async () => {
    const w = await world();
    const source = await w.make("solo");
    await settleThread(w.store, source.id);
    const before = (await w.store.readThreadRecord(source.id))!;
    expect(before.settledAt).not.toBeNull();
    // A live manual continuation claims the settled source.
    const token = w.store.newId();
    trackContinuation(token);
    try {
      await w.store.withThreadLock(source.id, async () => {
        const current = (await w.store.readThreadRecord(source.id))!;
        await w.store.writeThreadRecord({ ...current, continueClaim: { token, pid: process.pid, host: os.hostname(), at: new Date().toISOString() }, updatedAt: w.store.nowIso() });
      });
      await expect(sendTurn(w.store, source.id, { prompt: "Wake", wakeSettled: true })).rejects.toMatchObject({ code: "THREAD_BUSY" });
      const after = (await w.store.readThreadRecord(source.id))!;
      expect(after.settledAt).toBe(before.settledAt);
      expect(after.settledOverride).toBe(before.settledOverride);
      expect(await w.store.readTurns(source.id)).toHaveLength(0);
    } finally {
      untrackContinuation(token);
    }
  });

  it("refuses a manual continue when a turn hides in an unreadable ledger line", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const before = await w.store.listThreadIds();
    // Replace the running turn's row with malformed JSON: nothing readable
    // remains, and Continue is the first turn reader after the corruption.
    const file = w.store.turnsFile(source.id);
    const rows = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    const replaced = rows.map((line) => (line.includes(running.id) ? "{corrupt" : line));
    expect(replaced).not.toEqual(rows);
    await writeFile(file, `${replaced.join("\n")}\n`, "utf8");
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({ code: "TURNS_LEDGER_CORRUPT" });
    // The manual reservation refused before any claim, note or destination
    // exists; a send sees the same refusal.
    await expect(sendTurn(w.store, source.id, { prompt: "More" })).rejects.toMatchObject({ code: "TURNS_LEDGER_CORRUPT" });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect((await w.store.readActivities(source.id)).filter((a) => a.kind === "thread.continued")).toHaveLength(0);
    await interruptTurn(w.store, source.id, running.id).catch(() => undefined);
    await flushTurnRunners();
    for (const id of [source.id]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
  });

  it("refuses a manual continue when the active turn hides in a persistently torn tail", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Work" })).turn;
    const before = await w.store.listThreadIds();
    // Replace the running turn's row — the last line — with a torn tail: no
    // trailing newline. The first sight only notes it as pending, so read
    // once to persist it; the reservation's read is then the confirming
    // second sight and fails closed.
    const file = w.store.turnsFile(source.id);
    const rows = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    const index = rows.findIndex((line) => line.includes(running.id));
    expect(index).toBe(rows.length - 1);
    const replaced = [...rows.slice(0, index), "{torn"];
    await writeFile(file, replaced.join("\n"), "utf8");
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({ code: "TURNS_LEDGER_CORRUPT" });
    await expect(sendTurn(w.store, source.id, { prompt: "More" })).rejects.toMatchObject({ code: "TURNS_LEDGER_CORRUPT" });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect((await w.store.readActivities(source.id)).filter((a) => a.kind === "thread.continued")).toHaveLength(0);
    await interruptTurn(w.store, source.id, running.id).catch(() => undefined);
    await flushTurnRunners();
    for (const id of [source.id]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id).catch(() => undefined);
      }
    }
  });

  it("leaves a queued handoff queued when its continue joins another run, then prepares it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const queued = (await sendTurn(w.store, source.id, { prompt: "Handoff", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    expect(queued.status).toBe("queued");
    // Start the queue pass first: an automatic run and a manual request both
    // in flight behind it cannot settle before it reaches continueThread.
    const preparing = prepareQueuedHandoff(w.ctx, source.id, queued.id, Date.now());
    const auto = continueThread(w.ctx, { threadId: source.id, automatic: true });
    const manual = continueThread(w.ctx, { threadId: source.id });
    // The manual waits on the automatic run while the queue pass calls
    // continueThread: it joins the automatic destination, which is not this
    // entry's own, so the entry stays queued with nothing prepared.
    await preparing;
    const waiting = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
    expect(waiting.status).toBe("queued");
    expect((await w.store.readActivities(source.id)).filter((a) => a.kind === "handoff.prepared")).toHaveLength(0);
    const autoLanded = await auto;
    const manualLanded = await manual;
    expect(manualLanded.threadId).toBe(autoLanded.threadId);
    // Once both landed, the next pass prepares the entry against its own
    // destination.
    await prepareQueuedHandoff(w.ctx, source.id, queued.id, Date.now());
    const after = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
    expect(after.status).toBe("completed");
    expect(after.handoff).toBeDefined();
    expect(after.handoff!.destinationThreadId).not.toBe(autoLanded.threadId);
    expect(await w.store.readThreadRecord(after.handoff!.destinationThreadId)).not.toBeNull();
    await flushTurnRunners();
    for (const id of [source.id, autoLanded.threadId, after.handoff!.destinationThreadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("refuses an agent continue while a manual handoff is in flight", async () => {
    const w = await world();
    const source = await w.make("solo");
    const manual = continueThread(w.ctx, { threadId: source.id });
    // The agent's request must not join the manual run: it is refused with
    // a classified handoff contention, not a plain busy turn.
    const failure = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isContinuationBusy(failure)).toBe(true);
    const landed = await manual;
    expect((await w.store.readThreadRecord(landed.threadId))?.continuedFrom).toBe(source.id);
    await flushTurnRunners();
    for (const id of [source.id, landed.threadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });

  it("leaves a queued handoff queued when the queue pass races a manual run before its claim exists", async () => {
    const w = await world();
    const source = await w.make("solo");
    const queued = (await sendTurn(w.store, source.id, { prompt: "Handoff", queue: parseQueuePolicy({ conditions: [], continuation: "stored" }) })).turn;
    expect(queued.status).toBe("queued");
    // Gate the manual run's first source read: its map entry installs
    // synchronously while its claim can never exist yet.
    const realRead = w.store.readThreadRecord.bind(w.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    w.store.readThreadRecord = (async (id: string) => {
      if (id === source.id && !gated) { gated = true; await gate; }
      return realRead(id);
    }) as typeof w.store.readThreadRecord;
    const manual = continueThread(w.ctx, { threadId: source.id });
    // The queued handoff's own continue call lands on the in-flight manual
    // run: a classified contention refusal, with no persisted claim anywhere.
    const contention = await continueThread(w.ctx, { threadId: source.id, destinationThreadId: w.store.newId() }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isContinuationBusy(contention)).toBe(true);
    try {
      // The queue pass hits the same contention: the entry stays queued with
      // nothing prepared, instead of failing as a genuine handoff error.
      await runWorkQueue(w.ctx);
      const waiting = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
      expect(waiting.status).toBe("queued");
      expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
      expect((await w.store.readActivities(source.id)).filter((a) => a.kind === "handoff.prepared")).toHaveLength(0);
    } finally {
      release();
      delete (w.store as unknown as Record<string, unknown>).readThreadRecord;
    }
    const landed = await manual;
    expect((await w.store.readThreadRecord(landed.threadId))?.continuedFrom).toBe(source.id);
    // Once the manual handoff lands, the next pass admits the entry against
    // its own destination.
    await runWorkQueue(w.ctx);
    const after = (await w.store.readTurns(source.id)).find((t) => t.id === queued.id)!;
    expect(after.status).toBe("completed");
    expect(after.handoff).toBeDefined();
    expect(await w.store.readThreadRecord(after.handoff!.destinationThreadId)).not.toBeNull();
    await flushTurnRunners();
    for (const id of [source.id, landed.threadId, after.handoff!.destinationThreadId]) {
      for (const turn of await w.store.readTurns(id)) {
        if (turn.status === "running") await interruptTurn(w.store, id, turn.id);
      }
    }
  });
});

describe("a task's notices after hand-offs (MXN-389)", () => {
  it("drops a superseded child's queued settle and reports the successor to the new parent", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: child.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const done = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, done.id, { text: "Done." });

    // The settle is batched for the old parent, durably.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    // The child hands off, then the orchestrator hands off too, taking both
    // rows to the new parent.
    const successor = await continueThread(w.ctx, { threadId: child.id });
    const nextParent = await continueThread(w.ctx, { threadId: parent.id });
    const successorTurn = (await w.store.readTurns(successor.threadId))[0]!;
    await completeTurn(w.store, successor.threadId, successorTurn.id, { text: "Done after the handoff." });
    await queueTaskNotification(w.ctx, nextParent.threadId, successor.threadId);

    // A restart replays both durable batches: the old parent hears nothing
    // about the superseded child, and the new parent hears the successor once.
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTaskNotifications(w.ctx, nextParent.threadId);
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    const heard = await notificationsIn(w, nextParent.threadId);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(`taskId ${successor.threadId}`);
    // The successor's own notice names the original task as its origin; no
    // second notice is delivered for the superseded child itself.
    expect(heard[0]).not.toContain(`(taskId ${child.id}`);
  }, 30_000);
});

describe("a long continuation chain (MXN-389)", () => {
  it("resolves a task by its original id through more than twenty hand-offs", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const threads = [];
    for (let index = 0; index <= 20; index += 1) threads.push(await w.make(`link ${index}`));
    const now = new Date().toISOString();
    for (let index = 0; index <= 20; index += 1) {
      await w.store.appendDelegation({
        id: `d${index}`,
        parentThreadId: parent.id,
        childThreadId: threads[index]!.id,
        prompt: "work",
        status: "running",
        ...(index < 20 ? { continuedIn: threads[index + 1]!.id } : {}),
        ...(index === 0 ? { idempotencyKey: "retry-key" } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }

    // task_status by the original id reads the final child.
    expect((await describeTask(w.ctx, parent.id, threads[0]!.id)).child.id).toBe(threads[20]!.id);
    // Task control reaches it too.
    expect((await cancelTask(w.ctx, parent.id, threads[0]!.id)).child.id).toBe(threads[20]!.id);
    // An idempotent delegation retry answers with the task as it stands.
    expect((await delegate(w.ctx, { parentThreadId: parent.id, task: "work", idempotencyKey: "retry-key" })).child.id).toBe(threads[20]!.id);

    // A cycle and a missing successor terminate without exposing an
    // intermediate, superseded child.
    await w.store.updateDelegation("d20", { continuedIn: threads[0]!.id });
    await expect(describeTask(w.ctx, parent.id, threads[0]!.id)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    // Removing the cycle leaves a missing successor, which also terminates.
    const rows = await w.store.readDelegations();
    await writeFile(path.join(w.root, "delegations.jsonl"), rows.map((row) => {
      if (row.id !== "d20") return JSON.stringify(row);
      const { continuedIn: _cycle, ...rest } = row;
      return JSON.stringify(rest);
    }).join("\n") + "\n", "utf8");
    await w.store.updateDelegation("d19", { continuedIn: "gone-thread" });
    await expect(describeTask(w.ctx, parent.id, threads[0]!.id)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("a superseded settle and its successor (MXN-389)", () => {
  async function reviewTaskWithSettle(w: Awaited<ReturnType<typeof world>>, parentId: string) {
    const child = await createThread(w.store, {
      projectId: "p",
      title: "review login",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      interactionMode: "review",
    });
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parentId, childThreadId: child.id, prompt: "Review it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const reviewed = (await sendTurn(w.store, child.id, { prompt: "Review it" })).turn;
    await completeTurn(w.store, child.id, reviewed.id, { text: "One nit in the login form.\n\nVERDICT: FIX FIRST" });
    // Batched durably for the parent; the successor's own callback is lost.
    await queueTaskNotification(w.ctx, parentId, child.id);
    return child;
  }

  it("regenerates the dropped settle for a successor that already finished", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await reviewTaskWithSettle(w, parent.id);
    const successor = await continueThread(w.ctx, { threadId: child.id });
    const [opening] = await w.store.readTurns(successor.threadId);
    await completeTurn(w.store, successor.threadId, opening!.id, { text: "Re-checked the login form.\n\nVERDICT: FIX FIRST" });

    // No callback queued the successor's notice: replaying the durable batch
    // must regenerate it instead of dropping the parent's only report.
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    const heard = await notificationsIn(w, parent.id);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(`taskId ${successor.threadId}`);
    expect(heard[0]).toContain("Review verdict: FIX FIRST");
  }, 30_000);

  it("leaves a successor that is still running to report its own settle", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await reviewTaskWithSettle(w, parent.id);
    const successor = await continueThread(w.ctx, { threadId: child.id });

    // The successor has not settled: dropping the superseded settle is right,
    // and its own settle brings the report.
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await notificationsIn(w, parent.id)).toEqual([]);

    const [opening] = await w.store.readTurns(successor.threadId);
    await completeTurn(w.store, successor.threadId, opening!.id, { text: "Re-checked the login form.\n\nVERDICT: FIX FIRST" });
    await queueTaskNotification(w.ctx, parent.id, successor.threadId);
    await flushTaskNotifications(w.ctx, parent.id);
    const heard = await notificationsIn(w, parent.id);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(`taskId ${successor.threadId}`);
  }, 30_000);
});

describe("durable settle notices across a restart or hand-off (MXN-389)", () => {
  /** A review task whose settle notice is batched under its parent, with no callback left to run. */
  async function settledReview(w: Awaited<ReturnType<typeof world>>, parentId: string) {
    const child = await createThread(w.store, {
      projectId: "p",
      title: "review login",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      interactionMode: "review",
    });
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parentId, childThreadId: child.id, prompt: "Review it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const reviewed = (await sendTurn(w.store, child.id, { prompt: "Review it" })).turn;
    await completeTurn(w.store, child.id, reviewed.id, { text: "One nit in the login form.\n\nVERDICT: FIX FIRST" });
    await queueTaskNotification(w.ctx, parentId, child.id);
    return child;
  }

  it("recovers a settle whose notice was never queued, without the predecessor batch", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await settledReview(w, parent.id);
    const successor = await continueThread(w.ctx, { threadId: child.id });
    // Flushing while the successor runs drops the predecessor's settle.
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await notificationsIn(w, parent.id)).toEqual([]);

    // The successor persists its verdict; the process dies before the run
    // callback queues anything. Reopen: the obligation is on the row.
    const [opening] = await w.store.readTurns(successor.threadId);
    await completeTurn(w.store, successor.threadId, opening!.id, { text: "Re-checked the login form.\n\nVERDICT: FIX FIRST" });
    await recoverTaskNotifications(w.ctx);
    const heard = await notificationsIn(w, parent.id);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(`taskId ${successor.threadId}`);
    expect(heard[0]).toContain("Review verdict: FIX FIRST");
    expect((await describeTask(w.ctx, parent.id, child.id)).review).toMatchObject({ verdict: "FIX FIRST" });
  }, 30_000);

  it("admits a settle to the parent that owns the task when a hand-off lands first", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await settledReview(w, parent.id);
    const [reviewed] = await w.store.readTurns(child.id);

    // Pause after the final delegation lookup (the flush's last read of the
    // parent, before admission), continue the parent, then resume.
    const realTurns = w.store.readTurns.bind(w.store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let parentReads = 0;
    w.store.readTurns = async (threadId: string) => {
      const turns = await realTurns(threadId);
      if (threadId === parent.id) {
        parentReads += 1;
        if (parentReads === 2) {
          entered();
          await gate;
        }
      }
      return turns;
    };
    try {
      const flushing = flushTaskNotifications(w.ctx, parent.id);
      await paused;
      const nextParent = await continueThread(w.ctx, { threadId: parent.id });
      release();
      await flushing;
      await flushTaskNotifications(w.ctx, parent.id);
      await flushTaskNotifications(w.ctx, nextParent.threadId);
      expect(await notificationsIn(w, parent.id)).toEqual([]);
      const heard = await notificationsIn(w, nextParent.threadId);
      expect(heard).toHaveLength(1);
      expect(heard[0]).toContain(`taskId ${child.id}`);
    } finally {
      w.store.readTurns = realTurns;
    }
    expect(reviewed).toBeDefined();
  }, 30_000);

  it("delivers a successor's verdict once when a stale batch is replayed", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await settledReview(w, parent.id);
    const successor = await continueThread(w.ctx, { threadId: child.id });
    const nextParent = await continueThread(w.ctx, { threadId: parent.id });
    const [opening] = await w.store.readTurns(successor.threadId);
    await completeTurn(w.store, successor.threadId, opening!.id, { text: "Re-checked the login form.\n\nVERDICT: FIX FIRST" });
    await queueTaskNotification(w.ctx, nextParent.threadId, successor.threadId);
    await flushTaskNotifications(w.ctx, nextParent.threadId);
    expect(await notificationsIn(w, nextParent.threadId)).toHaveLength(1);

    // Replaying the predecessor's stale batch regenerates the successor's
    // notice; the delivered identity keeps it from posting a second time.
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTaskNotifications(w.ctx, nextParent.threadId);
    await recoverTaskNotifications(w.ctx);
    expect(await notificationsIn(w, nextParent.threadId)).toHaveLength(1);
  }, 30_000);
});
