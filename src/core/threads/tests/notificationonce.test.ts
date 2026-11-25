import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import { openThreadStore } from "../store.js";
import {
  completeTurn,
  createThread,
  interruptTurn,
  redeliverUnconfirmedSteers,
  sendTurn,
} from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import {
  flushTaskNotifications,
  queueTaskNotification,
  recoverTaskNotifications,
  revertThread,
  sendTaskMessage,
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
  it("reports once when the parent's running turn takes it mid-turn", async () => {
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

    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    expect(orchestrating.turn.status).toBe("running");
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    // The notice keeps its own framing, in the text the turn receives...
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain("<task-notification>");
    // ...and in the ledger, as a notice rather than a user message.
    const [notice] = await noticesIn(w, parent.id);
    expect(notice?.turnId).toBe(orchestrating.turn.id);
    expect(notice?.notification?.tasks[0]).toMatchObject({ taskId: child.id });

    // The provider confirmed the push: the settle is not sent again, and the
    // same settle filed again (a watcher, a client) is not reported twice.
    expect(w.driverFor("codex").takeUnconfirmedSteers?.(parent.id)).toEqual([]);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await flushTurnRunners();
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);
    expect(steered).toHaveLength(1);
  }, 30_000);

  it("reaches the parent when the provider takes the steer and never delivers it", async () => {
    const steered: string[] = [];
    const w = await world({
      leaveTurnsRunning: true,
      steering: { codex: "drops" },
      onSteer: (_threadId, text) => void steered.push(text),
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(steered).toHaveLength(1);

    // The turn ends without the provider ever confirming the push: the settle
    // must still reach the parent, sent again as a turn of its own.
    const [notice] = await noticesIn(w, parent.id);
    const copies = await redeliverUnconfirmedSteers(w.store, parent.id, orchestrating.turn.id, [
      { messageId: notice!.id, text: notice!.text, images: [] },
    ]);
    expect(copies).toHaveLength(1);
    await flushTurnRunners();
    const delivered = (await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain(child.id);

    // Once it has arrived, nothing files it again.
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await flushTurnRunners();
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id)).toHaveLength(1);
  }, 30_000);

  it("files a durable turn instead of steering when the provider cannot say what arrived", async () => {
    const steered: string[] = [];
    const w = await world({
      leaveTurnsRunning: true,
      steering: { codex: "unreported" },
      onSteer: (_threadId, text) => void steered.push(text),
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    // A push this driver never reports on cannot be a notice's delivery.
    expect(steered).toEqual([]);
    const [notice] = await noticesIn(w, parent.id);
    expect(notice?.turnId).not.toBe(orchestrating.turn.id);
    const queued = (await w.store.readTurns(parent.id)).find((turn) => turn.id === notice?.turnId);
    expect(queued?.status).toBe("queued");

    // Queued work runs, so the parent reads it: once.
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await flushTurnRunners();
    const delivered = (await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id);
    expect(delivered).toHaveLength(1);
  }, 30_000);

  it("keeps a notice the running turn refused and files it once the turn ends", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "fails" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    const orchestrating = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    // The push was refused: the recorded steer never reached the turn, and the
    // entry stays durable rather than being acknowledged and dropped.
    expect((await noticesIn(w, parent.id)).map((message) => message.turnId)).toEqual([orchestrating.turn.id]);

    // The turn ends: the held notice is filed as a turn of its own, with no
    // further trigger from the test.
    await interruptTurn(w.store, parent.id, orchestrating.turn.id);
    await expect.poll(
      async () => (await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id).length,
      { timeout: 10_000, interval: 50 },
    ).toBe(1);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== orchestrating.turn.id)).toHaveLength(1);
  }, 30_000);

  it("does not report a settle twice when the process died before forgetting the batch", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);

    // The window between the notice landing in the ledger and the batch entry
    // being forgotten: the entry is still on disk, as a crash leaves it.
    await writeFile(path.join(w.root, "task-notification-batches.json"), JSON.stringify({ [parent.id]: [{ child: child.id }] }), "utf8");

    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);
    // The ledger, not the marker, is what recovery reconciles against.
    const reopened = await openThreadStore(w.root);
    const restarted: OperationContext = { ...w.ctx, store: reopened, driverFor: w.driverFor };
    await recoverTaskNotifications(restarted);
    await flushTurnRunners();
    expect((await reopened.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(1);
  }, 30_000);

  it("reports a task's next settle after its turns were reverted and it was woken", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);

    // Back to no turns at all, then fresh work settles: a new settle, not a
    // repeat of the one already reported.
    await revertThread(w.ctx, child.id, 0);
    const sent = await sendTaskMessage(w.ctx, parent.id, child.id, "Try again.", true);
    expect(sent.outcome).toBe("started");
    await flushTurnRunners();
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const both = await noticesIn(w, parent.id);
    expect(both).toHaveLength(2);
    expect(both[1]!.notification?.tasks[0]).toMatchObject({ taskId: child.id, status: "completed" });
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

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toHaveLength(1);

    // A restart: a fresh store over the same root, and the settle filed again —
    // via the queue and via the startup recovery. Both leave the one report.
    const reopened = await openThreadStore(w.root);
    const restarted: OperationContext = { ...w.ctx, store: reopened, driverFor: w.driverFor };
    await queueTaskNotification(restarted, parent.id, child.id);
    await recoverTaskNotifications(restarted);
    await flushTaskNotifications(restarted, parent.id);
    await flushTurnRunners();
    expect((await reopened.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(1);
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
