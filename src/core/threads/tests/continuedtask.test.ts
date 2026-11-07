import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { createThread, deleteThread, sendTurn, openTurn, completeTurn, interruptTurn, updateThreadMeta } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { continueThread, flushTaskNotifications, queueTaskNotification, runningTasksNote, type OperationContext } from "../operations.js";
import { driverKindOfInstance } from "../../types.js";

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

  it("stops the background tasks it can name, and keeps the session, while a turn is still open on it", async () => {
    const w = await world();
    const old = await w.make("old");
    await sendTurn(w.store, old.id, { prompt: "Work" });
    const calls = watch(w, ["watcher"]);
    await continueThread(w.ctx, { threadId: old.id });
    expect(calls.taskStops).toEqual([`${old.id}:watcher`]);
    expect(calls.stopped).toEqual([]);
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
