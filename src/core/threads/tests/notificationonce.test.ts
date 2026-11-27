import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CliError } from "../../errors.js";
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
import { setDraining } from "../drain.js";
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

/** The durable batch file: what a flush kept for a later one. */
async function readBatches(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "task-notification-batches.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
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

  it("files a notice for an idle parent whose turn ended before the steer left", async () => {
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

    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    expect(live.turn.status).toBe("running");

    // The flush sees the parent running and decides to steer. The parent's own
    // turn then ends while that decision is still being made — the window the
    // steer's liveness check opens — so the steer finds no turn to ride. The
    // notice must not be stranded on the now-idle parent until a user message.
    const driver = w.driverFor("codex");
    const hasSession = driver.hasSession.bind(driver);
    let parentLooks = 0;
    driver.hasSession = (threadId: string): ReturnType<NonNullable<TurnDriver["hasSession"]>> =>
      Effect.flatMap(Effect.promise(async () => {
        if (threadId === parent.id) {
          parentLooks += 1;
          if (parentLooks === 1) await interruptTurn(w.store, parent.id, live.turn.id);
        }
      }), () => hasSession(threadId));

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    // Nothing was steered: the turn it was going to ride was already over.
    expect(steered).toEqual([]);
    // The notice goes out as a turn of its own, with no further trigger.
    await expect.poll(
      async () => (await noticesIn(w, parent.id)).filter((message) => message.turnId !== live.turn.id).length,
      { timeout: 10_000, interval: 50 },
    ).toBe(1);
    await flushTurnRunners();
    expect(await readBatches(w.root)).toEqual({});

    // Once only: a later flush, and the restart's recovery, find nothing left.
    await flushTaskNotifications(w.ctx, parent.id);
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== live.turn.id)).toHaveLength(1);
    expect(steered).toEqual([]);
  }, 30_000);

  it("files a notice for an idle parent the steer's own delivery found ended", async () => {
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

    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    // The send's own gate passed and its steer row is written; the turn ends
    // while the steer's final gate reads the target, so the steer never leaves.
    const readTurns = w.store.readTurns.bind(w.store);
    let armed = false;
    let ended = false;
    vi.spyOn(w.store, "readTurns").mockImplementation(async (threadId, options) => {
      if (armed && !ended && threadId === parent.id && (await w.store.readMessages(parent.id)).some((row) => row.origin === "task-notification")) {
        ended = true;
        await interruptTurn(w.store, parent.id, live.turn.id);
      }
      return await readTurns(threadId, options);
    });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    armed = true;
    await flushTaskNotifications(w.ctx, parent.id);
    expect(steered).toEqual([]);
    await expect.poll(
      async () => (await noticesIn(w, parent.id)).filter((message) => message.turnId !== live.turn.id).length,
      { timeout: 10_000, interval: 50 },
    ).toBe(1);
    await flushTurnRunners();
    expect(await readBatches(w.root)).toEqual({});
    // The staged steer never arrived, so it left no second copy behind.
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId === live.turn.id)).toEqual([]);
  }, 30_000);

  it("keeps a notice Antigravity's policy holds, with no turn filed and no retry armed", async () => {
    const steered: string[] = [];
    const w = await world({
      leaveTurnsRunning: true,
      steering: { antigravity: "delivers" },
      onSteer: (_threadId, text) => void steered.push(text),
    });
    const parent = await createThread(w.store, {
      projectId: "p",
      title: "orchestrator",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    // Opted in for the user's own turn, then opted out: the live turn is
    // Moxen's own (an automatic prompt), so the policy refuses the steer
    // whatever the turn does. Nothing may be filed for it, and nothing retried.
    w.config.providers = { ...w.config.providers, antigravity: { allowUnsupportedUse: true } };
    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate.", origin: "task-message" });
    w.config.providers = { ...w.config.providers, antigravity: { allowUnsupportedUse: false } };

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id).catch(() => undefined);
    // The turn ends while the parent is idle; the policy still holds.
    await interruptTurn(w.store, parent.id, live.turn.id);
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await flushTurnRunners();
    expect(await noticesIn(w, parent.id)).toEqual([]);
    expect((await w.store.readTurns(parent.id)).some((turn) => turn.origin === "task-notification")).toBe(false);
    expect(steered).toEqual([]);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);
  }, 30_000);

  it("dispatches nothing during a restart's drain, keeping the notice for the next server", async () => {
    const steered: string[] = [];
    const sent: string[] = [];
    const w = await world({
      leaveTurnsRunning: true,
      steering: { codex: "delivers" },
      onSteer: (_threadId, text) => void steered.push(text),
      onSendTurn: (input) => void sent.push(input.prompt),
    });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);

    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    // The parent's turn ends as a restart's drain begins, the window the
    // steer's final gate covers: the notice can neither steer nor be run.
    const driver = w.driverFor("codex");
    const hasSession = driver.hasSession.bind(driver);
    let looked = false;
    driver.hasSession = (threadId: string): ReturnType<NonNullable<TurnDriver["hasSession"]>> =>
      Effect.flatMap(Effect.promise(async () => {
        if (threadId === parent.id && !looked) {
          looked = true;
          await interruptTurn(w.store, parent.id, live.turn.id);
          setDraining(true);
        }
      }), () => hasSession(threadId));

    try {
      await queueTaskNotification(w.ctx, parent.id, child.id);
      await flushTaskNotifications(w.ctx, parent.id).catch(() => undefined);
      await flushTurnRunners();
      // Nothing steered, and no prompt reached the provider: whatever the
      // flush kept is durable work the next server reads, never a dispatch.
      expect(steered).toEqual([]);
      expect(sent.filter((prompt) => prompt.includes("<task-notification>"))).toEqual([]);
      // It waits as durable queued work, not as a running turn the drain
      // would have to stop.
      expect((await w.store.readTurns(parent.id)).filter((turn) => turn.origin === "task-notification")).toMatchObject([{ status: "queued" }]);
    } finally {
      setDraining(false);
    }

    // The next server delivers it — once, and only once.
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== live.turn.id)).toHaveLength(1);
    await recoverTaskNotifications(w.ctx);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((message) => message.turnId !== live.turn.id)).toHaveLength(1);
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

  it("does not retry a refused steer while the parent is still running", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "fails" } });
    const driver = w.driverFor("codex");
    const steer = vi.fn(driver.steerTurn!);
    driver.steerTurn = steer;
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    const attemptsBeforeIdle = steer.mock.calls.length;
    await interruptTurn(w.store, parent.id, live.turn.id);
    await expect.poll(async () => (await noticesIn(w, parent.id)).filter((row) => row.turnId !== live.turn.id).length).toBe(1);
    expect(attemptsBeforeIdle).toBe(1);
  });

  it("retries a refused steer even if the parent ended before the refusal came back", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "fails" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    w.driverFor("codex").steerTurn = () => Effect.tryPromise({
      try: async () => {
        await interruptTurn(w.store, parent.id, live.turn.id);
        throw new Error("No running turn");
      },
      catch: (cause) => new CliError("STEER_FAILED", "Steer refused", { cause }),
    });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await expect.poll(async () => (await noticesIn(w, parent.id)).filter((row) => row.turnId !== live.turn.id).length).toBe(1);
  });

  it("keeps the child compaction watcher when a different notice in the same batch is refused", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "fails" } });
    const parent = await w.make("orchestrator");
    const ready = await w.make("ready task");
    const compacting = await w.make("compacting task");
    await settleChild(w, ready.id);
    await settleChild(w, compacting.id);
    const maintenance = await sendTurn(w.store, compacting.id, { prompt: "/compact" });
    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    await queueTaskNotification(w.ctx, parent.id, ready.id);
    await queueTaskNotification(w.ctx, parent.id, compacting.id);
    await flushTaskNotifications(w.ctx, parent.id);

    // Finishing the parent retries only the refused notice. A later child
    // settle must still wake its own entry without a manual flush.
    await interruptTurn(w.store, parent.id, live.turn.id);
    await expect.poll(async () => (await w.store.readTurns(parent.id)).filter((turn) => turn.origin === "task-notification").length, { timeout: 5_000 }).toBe(1);
    const [retry] = (await w.store.readTurns(parent.id)).filter((turn) => turn.origin === "task-notification");
    await interruptTurn(w.store, parent.id, retry!.id);
    await completeTurn(w.store, compacting.id, maintenance.turn.id, { text: "Compacted." });
    await expect.poll(async () => (await noticesIn(w, parent.id)).find((message) => message.notification?.tasks.some((task) => task.taskId === compacting.id))?.notification?.tasks[0]?.settleTurnId, { timeout: 5_000 }).not.toBeUndefined();
    const [work] = await w.store.readTurns(compacting.id);
    expect((await noticesIn(w, parent.id)).find((message) => message.notification?.tasks.some((task) => task.taskId === compacting.id))?.notification?.tasks[0]?.settleTurnId).toBe(work?.id);
  });

  it("recovers a notice when persisting the steer activity failed after the message write", async () => {
    const w = await world({ leaveTurnsRunning: true, steering: { codex: "delivers" } });
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    const live = await startTurn(w.ctx, { threadId: parent.id, prompt: "Orchestrate." });
    const driver = w.driverFor("codex");
    const steer = vi.fn(driver.steerTurn!);
    driver.steerTurn = steer;
    const append = w.store.appendLedger.bind(w.store);
    const fault = vi.spyOn(w.store, "appendLedger").mockImplementation(async (id, ledger, row) => {
      if (id === parent.id && ledger === "activity" && (row as { kind: string }).kind === "turn.steered") {
        throw new Error("steer activity write failed");
      }
      await append(id, ledger, row);
    });
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await expect(flushTaskNotifications(w.ctx, parent.id)).rejects.toThrow("steer activity write failed");
    fault.mockRestore();
    expect(steer).not.toHaveBeenCalled();
    expect((await noticesIn(w, parent.id)).map((row) => row.turnId)).toEqual([live.turn.id]);
    await interruptTurn(w.store, parent.id, live.turn.id);
    await flushTurnRunners();

    const restarted = { ...w.ctx, store: await openThreadStore(w.root) };
    await recoverTaskNotifications(restarted);
    await recoverTaskNotifications(restarted);
    expect((await restarted.store.readTurns(parent.id)).filter((row) => row.origin === "task-notification")).toHaveLength(1);
  });

  it("remembers a delivered settle after 200 newer notices", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await settleChild(w, child.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const [old] = await noticesIn(w, parent.id);
    const [turn] = await w.store.readTurns(parent.id);
    expect(old?.notification?.tasks[0]?.taskId).toBe(child.id);
    const newerTurns = Array.from({ length: 200 }, () => ({ ...turn!, id: w.store.newId(), messageId: w.store.newId() }));
    const newerMessages = newerTurns.map((newer, index) => ({
      ...old!, id: newer.messageId, turnId: newer.id,
      notification: { tasks: [{ ...old!.notification!.tasks[0]!, taskId: `newer-task-${index}` }] },
    }));
    await w.store.withThreadLock(parent.id, async () => {
      await w.store.rewriteLedger(parent.id, "turns", [turn!, ...newerTurns]);
      await w.store.rewriteLedger(parent.id, "messages", [...await w.store.readMessages(parent.id), ...newerMessages]);
    });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect((await noticesIn(w, parent.id)).filter((row) => row.notification?.tasks.some((task) => task.taskId === child.id))).toHaveLength(1);
  });

  it("watches a child that settles between the background snapshot and the follow-up watch", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegate(w, parent.id, child.id);
    await settleChild(w, child.id);
    const driver = w.driverFor("codex");
    vi.spyOn(driver, "hasSession").mockReturnValue(Effect.succeed(true));
    let captured = false;
    let followedUp = false;
    Object.assign(driver, { backgroundTasks: (id: string) => {
      if (id !== child.id || followedUp) return [];
      captured = true;
      return [{ taskId: "background", description: "Build", command: null, startedAt: null }];
    } });
    const readThread = w.store.readThreadRecord.bind(w.store);
    vi.spyOn(w.store, "readThreadRecord").mockImplementation(async (id) => {
      if (id === child.id && captured && !followedUp) {
        followedUp = true;
        await settleChild(w, child.id, "Finish background work");
      }
      return await readThread(id);
    });

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(followedUp).toBe(true);
    await expect.poll(async () => (await noticesIn(w, parent.id)).map((row) => row.notification?.tasks[0]?.background.length), { timeout: 5_000 }).toEqual([1, 0]);
    await flushTurnRunners();
  });

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
