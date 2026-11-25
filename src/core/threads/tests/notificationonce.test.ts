import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import { openThreadStore } from "../store.js";
import { completeTurn, createThread, interruptTurn, redeliverUnconfirmedSteers, sendTurn } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import {
  flushTaskNotifications,
  queueTaskNotification,
  recoverTaskNotifications,
  startTurn,
  taskNotificationOf,
  type OperationContext,
} from "../operations.js";
import { taskNotificationText } from "../notify.js";

async function world(options: Parameters<typeof testHarness>[0] = {}) {
  const harness = await testHarness(options);
  const drivers = new Map<string, TurnDriver>();
  const driverFor = (instanceId: string): TurnDriver => {
    const kind = driverKindOfInstance(instanceId)!;
    let driver = drivers.get(kind);
    if (!driver) {
      driver = harness.drivers[kind]!();
      drivers.set(kind, driver);
    }
    return driver;
  };
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: harness.config, driverFor };
  const make = (title: string) =>
    createThread(harness.store, {
      projectId: "p",
      title,
      env: { mode: "local", path: harness.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
  return { ...harness, ctx, driverFor, make };
}

type World = Awaited<ReturnType<typeof world>>;

async function delegate(w: World, parentThreadId: string, childThreadId: string): Promise<void> {
  const now = w.store.nowIso();
  await w.store.appendDelegation({
    id: `d-${childThreadId}`,
    parentThreadId,
    childThreadId,
    prompt: "Build it",
    status: "running",
    notify: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** A child that ran one turn and settled, with nobody holding its session here. */
async function settleChild(w: World, childThreadId: string, text = "Build it"): Promise<void> {
  const turn = (await sendTurn(w.store, childThreadId, { prompt: text })).turn;
  await completeTurn(w.store, childThreadId, turn.id, { text: "Done." });
}

async function noticesIn(w: World, threadId: string) {
  return (await w.store.readMessages(threadId)).filter((message) => message.origin === "task-notification");
}

describe("a task's settle is reported once", () => {
  it("reports once when the parent's running turn took it and the unconfirmed steer is redelivered", async () => {
    const steered: string[] = [];
    const w = await world({
      leaveTurnsRunning: true,
      steering: { codex: "delivers" },
      onSteer: (_threadId, text) => void steered.push(text),
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    // Mid-turn delivery: the parent's turn runs here, so the notice steers into it.
    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    expect(orchestrating.turn.status).toBe("running");
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(steered).toHaveLength(1);
    // The runtime notice keeps its own framing, in the text the turn receives...
    expect(steered[0]).toContain("<task-notification>");
    // ...and in the ledger, as a notice rather than a user message.
    const [notice] = await noticesIn(w, parent.id);
    expect(notice?.turnId).toBe(orchestrating.turn.id);
    expect(notice?.notification?.tasks[0]).toMatchObject({ taskId: child.id });

    // The provider never confirmed the steer. Redelivery leaves a notice alone:
    // the parent already read it, and a copy would report the same settle twice.
    const copies = await redeliverUnconfirmedSteers(w.store, parent.id, orchestrating.turn.id, [
      { messageId: notice!.id, text: notice!.text, images: [] },
    ]);
    expect(copies).toEqual([]);

    // The parent's turn ends and the same settle reaches the queue again (a
    // watcher, an orphan recovery, a client re-filing it). Now the parent is
    // idle, so the old code filed a turn of its own for the notice it had.
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await flushTurnRunners();
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);
    expect(steered).toHaveLength(1);
  }, 30_000);

  it("reports once through its own turn, a failed background check and a restart", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    // No session holds the child here, so the background check fails: nothing
    // can be said about work still running.
    await settleChild(w, child.id);
    expect((await taskNotificationOf(w.ctx, child.id))?.backgroundUnknown).toBe(true);

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const first = await noticesIn(w, parent.id);
    expect(first).toHaveLength(1);
    // The failed check is reported in that one notice, not by announcing again.
    expect(first[0]!.text).toContain("could not verify");

    // Filed again while the app is running: acknowledged, so nothing goes out.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);

    // A restart: a fresh store over the same root, and the settle filed again —
    // via the queue and via the startup recovery. Both find the marker.
    const reopened = await openThreadStore(w.root);
    const restarted: OperationContext = { ...w.ctx, store: reopened, driverFor: w.driverFor };
    await queueTaskNotification(restarted, parent.id, child.id);
    await recoverTaskNotifications(restarted);
    await flushTaskNotifications(restarted, parent.id);
    await flushTurnRunners();
    expect((await reopened.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(1);
  }, 30_000);

  it("keeps a notice the running turn refused and files it as its own turn once", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "fails" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    expect(orchestrating.turn.status).toBe("running");
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    // The push was refused: the steer is recorded on the running turn, which
    // never read it. The entry stays durable rather than being acknowledged.
    expect((await noticesIn(w, parent.id)).map((message) => message.turnId)).toEqual([orchestrating.turn.id]);

    // The parent's next flush files it as a turn of its own, once.
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await flushTurnRunners();
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = (await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id);
    expect(delivered).toHaveLength(1);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id)).toHaveLength(1);
  }, 30_000);

  it("reports a task's last turn, not the idle hours since it was created", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    const first = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, child.id, first.id, { text: "Halfway." });
    await w.store.updateTurn(child.id, first.id, {
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
    });
    // Three hours idle between rounds, then one short turn that finishes it.
    const last = (await sendTurn(w.store, child.id, { prompt: "Finish it" })).turn;
    await completeTurn(w.store, child.id, last.id, { text: "Done." });
    await w.store.updateTurn(child.id, last.id, {
      createdAt: "2026-01-01T03:00:00.000Z",
      startedAt: "2026-01-01T03:00:00.000Z",
      completedAt: "2026-01-01T03:02:00.000Z",
    });

    const task = await taskNotificationOf(w.ctx, child.id);
    expect(task?.durationMs).toBe(2 * 60_000);
    const text = taskNotificationText([task!]);
    expect(text).toContain("2m");
    expect(text).not.toContain("3h");
  }, 30_000);
});
