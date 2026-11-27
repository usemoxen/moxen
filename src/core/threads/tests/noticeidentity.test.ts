import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, completeTurn, failTurn, sendTurn } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { driverKindOfInstance } from "../../types.js";
import {
  continueThread,
  flushTaskNotifications,
  queueTaskNotification,
  recoverTaskNotifications,
  scheduleUsageContinue,
  type OperationContext,
} from "../operations.js";

/**
 * Barriers and injected I/O failures on the batch file's writes. They let a
 * test stand in for another process between a flush's snapshot and its
 * acknowledgement, and fail the acknowledgement itself.
 */
const batchIo = vi.hoisted(() => ({
  failuresLeft: 0,
  failWhen: null as null | ((text: string) => boolean),
  afterWrite: null as null | ((text: string) => void),
}));

vi.mock("../../infra/atomic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/atomic.js")>();
  return {
    ...actual,
    writeAtomic: async (file: string, text: string): Promise<void> => {
      const batchFile = file.endsWith("task-notification-batches.json");
      if (batchFile && batchIo.failuresLeft > 0 && (batchIo.failWhen?.(text) ?? true)) {
        batchIo.failuresLeft -= 1;
        throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      }
      await actual.writeAtomic(file, text);
      if (batchFile) batchIo.afterWrite?.(text);
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  batchIo.failuresLeft = 0;
  batchIo.failWhen = null;
  batchIo.afterWrite = null;
  resetUsageLimitsForTests();
});

async function world() {
  const harness = await testHarness();
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
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

type W = Awaited<ReturnType<typeof world>>;

async function delegateNotifying(w: W, parentId: string, childId: string): Promise<void> {
  const now = w.store.nowIso();
  await w.store.appendDelegation({
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

/** Hold a thread so its notices stay durable without arming a batch timer. */
async function hold(w: W, threadId: string, provider = "codex"): Promise<void> {
  const record = await w.store.readThreadRecord(threadId);
  await w.store.writeThreadRecord({
    ...record!,
    usagePause: { provider, windows: [], phase: "waiting", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), order: 1, handoff: false },
  });
}

async function release(w: W, threadId: string): Promise<void> {
  await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(threadId))!, usagePause: null });
}

async function notificationsIn(w: W, threadId: string): Promise<string[]> {
  return (await w.store.readMessages(threadId)).filter((message) => message.origin === "task-notification").map((message) => message.text);
}

/** The durable batches with each notice's identity dropped: these tests pin which notices wait, not their internal ids. */
async function batchesOf(w: W): Promise<Record<string, { child: string }[]>> {
  const raw = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8").catch(() => "{}")) as Record<
    string,
    { child: string; id?: string }[]
  >;
  return Object.fromEntries(Object.entries(raw).map(([parent, entries]) => [parent, entries.map(({ id: _id, ...rest }) => rest)]));
}

async function settle(w: W, threadId: string, prompt: string, text: string): Promise<void> {
  const turn = (await sendTurn(w.store, threadId, { prompt })).turn;
  await completeTurn(w.store, threadId, turn.id, { text });
}

describe("a destination flush against a notice it never read", () => {
  it("keeps a notice a handoff moved into its batch while it was acknowledging", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const destination = await w.make("continuation");
    const existing = await w.make("existing task");
    const incoming = await w.make("incoming task");
    await delegateNotifying(w, destination.id, existing.id);
    await delegateNotifying(w, source.id, incoming.id);
    await settle(w, existing.id, "Build it", "Done.");
    await settle(w, incoming.id, "Build it", "Done.");
    // Held: both notices are durable, and neither arms a timer.
    await hold(w, destination.id);
    await hold(w, source.id);
    await queueTaskNotification(w.ctx, destination.id, existing.id);
    await queueTaskNotification(w.ctx, source.id, incoming.id);

    await release(w, destination.id);
    await release(w, source.id);
    // The destination's flush takes its batch, and the handoff lands in the
    // gap before it delivers: the restore point is the flush's own read of
    // the delegations, after its snapshot and before its acknowledgement.
    let moved!: () => void;
    const moveWritten = new Promise<void>((resolve) => {
      moved = resolve;
    });
    batchIo.afterWrite = (text) => {
      if (text.includes(incoming.id)) moved();
    };
    let handoff!: Promise<unknown>;
    const readDelegations = w.store.readDelegations.bind(w.store);
    let armed = true;
    const spy = vi.spyOn(w.store, "readDelegations").mockImplementation(async () => {
      const rows = await readDelegations();
      if (armed) {
        armed = false;
        handoff = continueThread(w.ctx, { threadId: source.id, destinationThreadId: destination.id });
        await moveWritten;
      }
      return rows;
    });
    try {
      await flushTaskNotifications(w.ctx, destination.id);
    } finally {
      spy.mockRestore();
    }
    await handoff;

    const durable = await batchesOf(w);
    expect(durable[destination.id]?.map((entry) => entry.child)).toEqual([incoming.id]);
    await flushTaskNotifications(w.ctx, destination.id);
    await flushTurnRunners();
    const notes = await notificationsIn(w, destination.id);
    expect(notes).toHaveLength(2);
    expect(notes.join("\n")).toContain(incoming.id);
  });

  it("keeps a later settle of the same task that lands while the first is being acknowledged", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    await settle(w, child.id, "Build it", "Done.");
    await hold(w, parent.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await release(w, parent.id);

    // Another process queues this task's next settle into the batch file after
    // the flush took its snapshot: the durable entries are shared state. The
    // restore point is the flush's own read of the delegations, after the
    // snapshot and before the acknowledgement.
    const readDelegations = w.store.readDelegations.bind(w.store);
    let armed = true;
    const spy = vi.spyOn(w.store, "readDelegations").mockImplementation(async () => {
      const rows = await readDelegations();
      if (armed) {
        armed = false;
        const file = path.join(w.root, "task-notification-batches.json");
        const batches = JSON.parse(await readFile(file, "utf8")) as Record<string, { child: string; id?: string }[]>;
        await writeFile(
          file,
          `${JSON.stringify({ ...batches, [parent.id]: [...(batches[parent.id] ?? []), { child: child.id, id: "settle:later" }] })}\n`,
        );
      }
      return rows;
    });
    try {
      await flushTaskNotifications(w.ctx, parent.id);
    } finally {
      spy.mockRestore();
    }
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);

    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(2);
    expect(await batchesOf(w)).toEqual({});
  });
});

describe("a flush whose acknowledgement write failed", () => {
  it("does not report the delivered notice again after a restart", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    await settle(w, child.id, "Build it", "Done.");
    await hold(w, parent.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await release(w, parent.id);

    // The notice goes out, then the write that forgets it fails with EIO: an
    // acknowledgement only fails on the write that empties the batch.
    batchIo.failWhen = (text) => Object.keys(JSON.parse(text) as Record<string, unknown>).length === 0;
    batchIo.failuresLeft = 1;
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
    // The entry is still on disk because the acknowledgement never landed.
    expect((await batchesOf(w))[parent.id]).toHaveLength(1);

    // A restart replays the file: what already went out must not go again.
    await recoverTaskNotifications(w.ctx);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toHaveLength(1);
    expect(await batchesOf(w)).toEqual({});
  });
});

describe("a pause notice for a task that moved with its parent", () => {
  it("reports it to the parent that adopted the task, naming the live continuation", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const child = await w.make("task");
    await delegateNotifying(w, parent.id, child.id);
    const stopped = (await sendTurn(w.store, child.id, { prompt: "Build it" })).turn;
    await failTurn(w.store, child.id, stopped.id, { error: "Usage limit reached." });
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt }]);
    // Held: the pause notice waits durably on the parent instead of timing out
    // of its batch window, and the task's own continue is queued behind it.
    await hold(w, parent.id);
    const continued = await scheduleUsageContinue(w.ctx, child.id, stopped.id, resetsAt);
    expect(continued).not.toBeNull();
    await hold(w, child.id);
    expect((await batchesOf(w))[parent.id]).toHaveLength(1);

    // The task continues into a thread that inherits its hold...
    const taskNext = await continueThread(w.ctx, { threadId: child.id, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await w.store.readThreadRecord(taskNext.threadId))?.usagePause).toMatchObject({ phase: "waiting" });
    // ...and then the parent carries on in its own new thread.
    await release(w, parent.id);
    const parentNext = await continueThread(w.ctx, { threadId: parent.id });

    // The allowance is back: nothing is held any more.
    resetUsageLimitsForTests();
    await flushTaskNotifications(w.ctx, parent.id);
    await flushTaskNotifications(w.ctx, parentNext.threadId);
    await flushTurnRunners();
    expect(await notificationsIn(w, parent.id)).toEqual([]);
    const delivered = await notificationsIn(w, parentNext.threadId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("paused for usage");
    expect(delivered[0]).toContain(taskNext.threadId);
  });
});

describe("a notice a handoff carries", () => {
  it("keeps its identity from the old parent's batch to the new one's", async () => {
    const w = await world();
    const source = await w.make("orchestrator");
    const destination = await w.make("continuation");
    const child = await w.make("task");
    await delegateNotifying(w, source.id, child.id);
    await settle(w, child.id, "Build it", "Done.");
    await hold(w, source.id);
    await queueTaskNotification(w.ctx, source.id, child.id);
    const before = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8")) as Record<string, { id: string; child: string }[]>;
    expect(before[source.id]).toHaveLength(1);
    await release(w, source.id);

    // Stop the handoff after its move and before its first turn: the notice
    // sits in the destination's batch exactly as the move left it.
    const readTurns = w.store.readTurns.bind(w.store);
    let arrived!: () => void;
    const atMove = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let armed = true;
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation(async (threadId, options) => {
      const turns = await readTurns(threadId, options);
      if (armed && threadId === destination.id && turns.length === 0) {
        armed = false;
        arrived();
        await gate;
      }
      return turns;
    });
    const handoff = continueThread(w.ctx, { threadId: source.id, destinationThreadId: destination.id });
    try {
      await atMove;
      const after = JSON.parse(await readFile(path.join(w.root, "task-notification-batches.json"), "utf8")) as Record<string, { id: string; child: string }[]>;
      expect(after[source.id]).toBeUndefined();
      expect(after[destination.id]?.map((entry) => entry.child)).toEqual([child.id]);
      // Identity survives the move, so a replay or a refusal that reads it
      // later still names the same notice.
      expect(after[destination.id]?.[0]?.id).toBe(before[source.id]![0]!.id);
    } finally {
      proceed();
      await handoff;
      spy.mockRestore();
    }
    await flushTaskNotifications(w.ctx, destination.id);
    await flushTurnRunners();
    expect(await notificationsIn(w, source.id)).toEqual([]);
    expect(await notificationsIn(w, destination.id)).toHaveLength(1);
  });
});
