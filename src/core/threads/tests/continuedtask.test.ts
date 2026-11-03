import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { continueThread, queueTaskNotification, runningTasksNote, TASK_NOTIFICATION_BATCH_MS, type OperationContext } from "../operations.js";
import { driverKindOfInstance } from "../../types.js";

afterEach(() => vi.useRealTimers());

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
    await new Promise((resolve) => setTimeout(resolve, TASK_NOTIFICATION_BATCH_MS + 300));
    await flushTurnRunners();
    const sent = await notificationsIn(w, parent.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`taskId ${continued.threadId}, continued from taskId ${child.id}`);
    expect(sent[0]).not.toContain(`(taskId ${child.id}`);
  }, 15_000);

  it("leaves a thread that was not delegated without a delegation row", async () => {
    const w = await world();
    const thread = await w.make("solo");
    const turn = (await sendTurn(w.store, thread.id, { prompt: "Work" })).turn;
    await completeTurn(w.store, thread.id, turn.id, { text: "Done for now." });
    await continueThread(w.ctx, { threadId: thread.id });
    expect(await w.store.readDelegations()).toEqual([]);
  });
});

describe("an orchestrator continued in a new thread", () => {
  it("takes its running tasks along: listed in the handoff, reporting to the new thread", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const running = await w.make("still running");
    const done = await w.make("already done");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "r", parentThreadId: parent.id, childThreadId: running.id, prompt: "A", status: "running", notify: true, createdAt: now, updatedAt: now });
    await w.store.appendDelegation({ id: "d", parentThreadId: parent.id, childThreadId: done.id, prompt: "B", status: "completed", createdAt: now, updatedAt: now });
    const turn = (await sendTurn(w.store, parent.id, { prompt: "Orchestrate" })).turn;
    await completeTurn(w.store, parent.id, turn.id, { text: "Waiting on tasks." });

    const continued = await continueThread(w.ctx, { threadId: parent.id });
    const rows = await w.store.readDelegations();
    expect(rows.find((row) => row.id === "r")?.parentThreadId).toBe(continued.threadId);
    expect(rows.find((row) => row.id === "d")?.parentThreadId).toBe(parent.id);
    const prompt = (await w.store.readMessages(continued.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain(`"still running" (taskId ${running.id})`);
    expect(prompt).not.toContain(done.id);
    await flushTurnRunners();

    // A notification batched for the old parent before the move still reaches the new one.
    queueTaskNotification(w.ctx, parent.id, running.id);
    await new Promise((resolve) => setTimeout(resolve, 2 * TASK_NOTIFICATION_BATCH_MS + 300));
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    expect((await notificationsIn(w, continued.threadId)).join("\n")).toContain(`taskId ${running.id}`);
  }, 15_000);

  it("adds no note when no task is running", () => {
    expect(runningTasksNote([])).toBe("");
  });
});
