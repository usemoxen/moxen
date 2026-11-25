import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import {
  describeTask,
  flushTaskNotifications,
  queueTaskNotification,
  recoverTaskNotifications,
  startTurn,
  taskNotificationOf,
  type OperationContext,
} from "../operations.js";
import { openThreadStore } from "../store.js";
import { completeTurn, createThread, sendTurn } from "../threads.js";

afterEach(() => vi.useRealTimers());

const WORKER_REPORT = "THE WORKER'S REPORT";

/** A driver whose compaction turn waits for the test, as a real one still summarising does. */
function scriptedDriver(reports: ReadonlyMap<string, string>, holdCompaction: () => Promise<void>): TurnDriver {
  const sessions = new Set<string>();
  const prompts = new Map<string, string>();
  let turns = 0;
  return {
    hasSession: (threadId: string) => Effect.succeed(sessions.has(threadId)),
    startSession: (input: { threadId: string }) => Effect.sync(() => {
      sessions.add(input.threadId);
      return {};
    }),
    sendTurn: (input: { threadId: string; prompt: string }) => Effect.sync(() => {
      turns += 1;
      const turnId = `driver-turn-${turns}`;
      prompts.set(turnId, input.prompt);
      return { threadId: input.threadId, turnId };
    }),
    interruptTurn: () => Effect.void,
    awaitTurn: async (_threadId: string, turnId: string) => {
      const prompt = prompts.get(turnId) ?? "";
      if (prompt === "/compact") await holdCompaction();
      return { status: "completed" as const, text: reports.get(prompt) ?? `Completed: ${prompt}`, usage: null, error: null };
    },
    streamEvents: Stream.never as TurnDriver["streamEvents"],
    backgroundTasks: () => [],
  };
}

/** A delegated task on a thread long enough that its settle compacts it. */
async function world(holdCompaction: () => Promise<void>) {
  const harness = await testHarness();
  const reports = new Map([["Build it", WORKER_REPORT]]);
  const scripted = scriptedDriver(reports, holdCompaction);
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: {
      ...harness.config,
      providers: {
        ...harness.config.providers,
        codex: { ...harness.config.providers?.codex, compaction: "auto", compactAt: "50%", handoff: "off" },
      },
    },
    driverFor: (id) => {
      // The parent and the task both run on the scripted codex driver.
      if (driverKindOfInstance(id) === "codex") return scripted;
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

async function delegated(store: Awaited<ReturnType<typeof world>>["store"], parentId: string, childId: string): Promise<void> {
  const now = store.nowIso();
  await store.appendDelegation({
    id: `d-${childId}`,
    parentThreadId: parentId,
    childThreadId: childId,
    prompt: "Build it",
    status: "running",
    notify: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** A context reading past the compact line, recorded the way the turn runner records one. */
async function pastTheLine(w: Awaited<ReturnType<typeof world>>, childId: string): Promise<void> {
  await w.store.appendLedger(childId, "activity", {
    id: "window-1",
    threadId: childId,
    turnId: null,
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: 900, maxTokens: 1_000 },
    createdAt: w.store.nowIso(),
  });
}

async function notificationsIn(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<string[]> {
  return (await w.store.readMessages(threadId))
    .filter((message) => message.origin === "task-notification")
    .map((message) => message.text);
}

async function waitForNotifications(w: Awaited<ReturnType<typeof world>>, threadId: string, count: number): Promise<string[]> {
  let found: string[] = [];
  for (let waited = 0; waited < 10_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushTurnRunners();
    found = await notificationsIn(w, threadId);
    if (found.length >= count) break;
  }
  return found;
}

/** The durable sidecar batch, as a restarted server reads it back. */
async function batchesOnDisk(w: Awaited<ReturnType<typeof world>>): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8")) as Record<string, unknown>;
}

/** The pid of a process that has already exited, as a crash leaves behind. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/**
 * A delegated task whose work turn settled and reported, and whose `/compact`
 * turn is still `running` — the state a process death mid-compaction leaves.
 * No runner exists for either turn, so the child is never touched again: only
 * a recovery can settle it.
 */
async function taskMidCompaction(w: Awaited<ReturnType<typeof world>>, owner: "dead" | "live") {
  const parent = await w.make("orchestrator");
  const child = await w.make("task");
  await delegated(w.store, parent.id, child.id);
  const work = await sendTurn(w.store, child.id, { prompt: "Build it" });
  await completeTurn(w.store, child.id, work.turn.id, { text: WORKER_REPORT });
  const compact = await sendTurn(w.store, child.id, { prompt: "/compact" });
  await w.store.updateTurn(child.id, compact.turn.id, {
    status: "running",
    owner: { pid: owner === "dead" ? await deadPid() : process.pid, host: os.hostname() },
  });
  return { parent, child, compactTurnId: compact.turn.id };
}

/** Poll for the parent's durable batch to come back, as a re-filed entry would. */
async function batchReappears(w: Awaited<ReturnType<typeof world>>, parentId: string, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await batchesOnDisk(w))[parentId] !== undefined) return true;
  }
  return false;
}

describe("a delegated task that compacts after its turn settles", () => {
  it("reports once, with the worker's report, after the compaction ends instead of dropping the notice (MXN-351)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const w = await world(() => held);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegated(w.store, parent.id, child.id);
    await pastTheLine(w, child.id);

    const started = await startTurn(w.ctx, { threadId: child.id, prompt: "Build it" });
    await started.run;
    // The settle compacted the task and the compaction is still running.
    expect((await w.store.readTurns(child.id)).some((turn) => turn.status === "running")).toBe(true);

    // The batch flushes while that maintenance turn runs: it must wait, not be dropped.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(0);

    release();
    await flushTurnRunners();
    const delivered = await waitForNotifications(w, parent.id, 1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(WORKER_REPORT);
    expect(delivered[0]).not.toContain("Completed: /compact");

    // Exactly once: another flush has nothing left to send.
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  }, 30_000);

  it("reads the worker's report, not the compaction's, when the compaction already finished (MXN-351)", async () => {
    const w = await world(async () => undefined);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegated(w.store, parent.id, child.id);
    await pastTheLine(w, child.id);

    const started = await startTurn(w.ctx, { threadId: child.id, prompt: "Build it" });
    await started.run;
    await flushTurnRunners();
    // task_status and the notification headline both read the task's last turn.
    expect((await taskNotificationOf(w.ctx, child.id))?.headline).toBe(WORKER_REPORT);
    expect((await describeTask(w.ctx, parent.id, child.id)).task.summary).toBe(WORKER_REPORT);
    // The task compacted, and the turn that did it is marked maintenance.
    const turns = await w.store.readTurns(child.id);
    expect(turns.some((turn) => turn.maintenance === true && turn.status === "completed")).toBe(true);

    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(WORKER_REPORT);
    expect(delivered[0]).not.toContain("Completed: /compact");

    // An older ledger carries no marker; the prompt still identifies the compaction.
    await w.store.rewriteLedger(child.id, "turns", (await w.store.readTurns(child.id)).map((turn) => ({ ...turn, maintenance: undefined })));
    expect((await taskNotificationOf(w.ctx, child.id))?.headline).toBe(WORKER_REPORT);
  }, 30_000);

  it("keeps a kept-back notice on disk, so a restart delivers it once the compaction ends (MXN-351)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const w = await world(() => held);
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegated(w.store, parent.id, child.id);
    await pastTheLine(w, child.id);

    const started = await startTurn(w.ctx, { threadId: child.id, prompt: "Build it" });
    await started.run;

    // The flush comes due mid-compaction. The entry must survive in the durable
    // batch, not only in this process's watcher: a restart has no watcher, and
    // the notice would otherwise be lost for good.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await batchesOnDisk(w)).toEqual({ [parent.id]: [{ child: child.id }] });

    // Restart while the compaction still runs: the recovery re-reads the batch,
    // finds the task with work in flight, and leaves the entry alone.
    const restarted = await openThreadStore(w.root);
    const restartedCtx: OperationContext = { ...w.ctx, store: restarted };
    await recoverTaskNotifications(restartedCtx);
    expect(await notificationsIn(w, parent.id)).toHaveLength(0);
    expect(await batchesOnDisk(w)).toEqual({ [parent.id]: [{ child: child.id }] });

    // Once the compaction ends the notice goes out, with the worker's report.
    release();
    await flushTurnRunners();
    const delivered = await waitForNotifications(w, parent.id, 1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(WORKER_REPORT);
    expect(delivered[0]).not.toContain("Completed: /compact");
    expect(await batchesOnDisk(w)).toEqual({});

    // Replaying the recovery of a batch already delivered finds nothing left.
    await recoverTaskNotifications(restartedCtx);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  }, 30_000);

  it("reconciles a task left mid-compaction by a dead process, so the restart still reports (MXN-351)", async () => {
    const w = await world(async () => undefined);
    const { parent, child, compactTurnId } = await taskMidCompaction(w, "dead");

    // The flush that came due before the process died kept the entry durable.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await batchesOnDisk(w)).toEqual({ [parent.id]: [{ child: child.id }] });
    expect(await notificationsIn(w, parent.id)).toHaveLength(0);

    // The restart replays that batch on its own store — no shared event bus,
    // and no runner will ever settle the orphan — so the recovery itself must
    // reconcile the child before deciding it still has work.
    const restarted = await openThreadStore(w.root);
    await recoverTaskNotifications({ ...w.ctx, store: restarted });

    const delivered = await notificationsIn(w, parent.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(WORKER_REPORT);
    expect((await w.store.readTurns(child.id)).find((turn) => turn.id === compactTurnId)?.status).toBe("interrupted");
    expect((await w.store.readActivities(child.id)).some((row) => row.kind === "turn.orphaned")).toBe(true);
    expect(await batchesOnDisk(w)).toEqual({});
  }, 30_000);

  it("does not refile a kept-back notice a flush already delivered, so the parent hears once (MXN-351)", async () => {
    const w = await world(async () => undefined);
    const { parent, child, compactTurnId } = await taskMidCompaction(w, "live");

    // Deferred while the compaction runs: the entry is durable and the watcher
    // is waiting on the child's next terminal event.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await batchesOnDisk(w)).toEqual({ [parent.id]: [{ child: child.id }] });

    // The compaction settles in the ledger, and the flush wins: it delivers the
    // notice and deletes the entry, before the settle's event has been heard.
    await w.store.updateTurn(child.id, compactTurnId, { status: "completed", completedAt: w.store.nowIso() });
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
    expect(await batchesOnDisk(w)).toEqual({});

    // The watcher now hears the settle it was waiting for. Its entry is gone,
    // so its wake must be a no-op: filing a fresh one would report the same
    // settle a second time.
    w.store.emit(child.id, "turn-completed");
    expect(await batchReappears(w, parent.id, 1_000)).toBe(false);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
  }, 30_000);
});
