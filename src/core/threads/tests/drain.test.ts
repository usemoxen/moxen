/**
 * The pre-restart drain (MXN-377): while the shared server drains for a
 * restart, nothing new starts — sends that would run now are refused,
 * admission admits nothing — and what waits keeps its place and its times,
 * so the next server runs it. Pinned here at the core paths the drain gates.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CliConfig } from "../../types.js";
import { driverKindOfInstance } from "../../types.js";
import { openThreadStore, type ThreadStore } from "../store.js";
import { createThread, completeTurn, interruptTurn, redeliverOrphanedSteers, sendTurn, settleThread } from "../threads.js";
import { executeTurn, type TurnDriver } from "../execute.js";
import { actOnLongThread, compactMidTurn, delegate, recoverOrphanedTurn, runDueScheduledTurn, runWorkQueue, type OperationContext } from "../operations.js";
import { isDraining, setDraining } from "../drain.js";
import { UsageProtection } from "../../usage/protection.js";
import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { rmTempAsync } from "../../testing/tmp.js";
import type { QueuePolicy } from "../queue.js";

const MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" } as const;
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  // The drain flag is process-wide: no test leaves it on for the next one.
  setDraining(false);
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-drain-"));
  cleanup.push(() => rmTempAsync(root));
  const store = await openThreadStore(root);
  const thread = await createThread(store, {
    projectId: "p",
    title: "Drain",
    modelSelection: { ...MODEL },
    env: { mode: "local", path: root, branch: null },
  });
  return { store, thread, root };
}

/** A driver that records what it was asked to run, and finishes at once. */
function driver(sent: string[]): TurnDriver {
  return {
    hasSession: () => Effect.succeed(true),
    startSession: () => Effect.succeed({}),
    sendTurn: (input) => {
      sent.push(input.prompt);
      return Effect.succeed({ threadId: input.threadId, turnId: `native-${sent.length}` });
    },
    interruptTurn: () => Effect.void,
    streamEvents: Stream.never,
    awaitTurn: async () => ({ status: "completed" as const, text: "done", usage: null, error: null }),
  };
}

function context(store: ThreadStore, root: string, turnDriver: TurnDriver): OperationContext {
  return { store, storeRoot: root, config: {} as CliConfig, driverFor: () => turnDriver };
}

const queuePolicy = (): QueuePolicy => ({ conditions: [], held: false, order: Date.now(), sequential: true, continuation: "same-thread" });

describe("a drain refuses what would start", () => {
  it("refuses a fresh send with a draining state, and takes sends again once it lifts", async () => {
    const { store, thread } = await setup();
    setDraining(true);
    expect(isDraining()).toBe(true);
    await expect(sendTurn(store, thread.id, { prompt: "during the drain" })).rejects.toMatchObject({
      code: "SERVER_DRAINING",
      message: expect.stringContaining("restarting"),
    });
    // Nothing was written: the refused send leaves no turn behind.
    expect((await store.readTurns(thread.id)).map((turn) => turn.status)).toEqual([]);
    setDraining(false);
    const after = await sendTurn(store, thread.id, { prompt: "after the drain" });
    expect(after.turn.status).toBe("running");
  });

  it("keeps waiting sends durable, with their times untouched", async () => {
    const { store, thread, root } = await setup();
    setDraining(true);
    const at = "2030-01-01T00:00:00Z";
    const scheduled = await sendTurn(store, thread.id, { prompt: "scheduled during the drain", scheduledFor: at });
    expect(scheduled.turn).toMatchObject({ status: "queued", scheduledFor: "2030-01-01T00:00:00.000Z", scheduleReason: "user" });
    // Admission admits nothing while the drain lasts: a queue entry that
    // would run now waits too, exactly as it was.
    const entry = await sendTurn(store, thread.id, { prompt: "queued during the drain", queue: { ...queuePolicy(), requestId: "drain:entry" } });
    expect(entry.turn).toMatchObject({ status: "queued" });
    const sent: string[] = [];
    expect(await runDueScheduledTurn(context(store, root, driver(sent)), thread.id, Date.now())).toBe(false);
    expect(sent).toEqual([]);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === scheduled.turn.id)).toMatchObject({
      status: "queued",
      scheduledFor: "2030-01-01T00:00:00.000Z",
    });
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === entry.turn.id)).toMatchObject({ status: "queued" });
  });

  it("still lets a steer reach the running turn, which the drain lets finish", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    expect(first.turn.status).toBe("running");
    setDraining(true);
    const steered = await sendTurn(store, thread.id, { prompt: "a mid-turn note", delivery: "steer" });
    expect(steered.delivery).toBe("steered");
    expect(steered.turn.id).toBe(first.turn.id);
  });
});

describe("a drain holds what a settle would promote", () => {
  it("requeues the promotion a settle would run instead of starting it", async () => {
    const { store, thread, root } = await setup();
    const sent: string[] = [];
    const turnDriver = driver(sent);
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    const behind = await sendTurn(store, thread.id, { prompt: "queued behind", delivery: "queue" });
    expect(behind.turn).toMatchObject({ status: "queued", delivery: "queued" });
    setDraining(true);
    await executeTurn({ store, driver: turnDriver, threadId: thread.id, storeTurnId: first.turn.id, prompt: "first" });
    // The settling turn finished, and only it was ever sent: the promotion
    // went back to the queue, held for the admission path, message and all.
    expect(sent).toEqual(["first"]);
    const held = (await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id);
    expect(held).toMatchObject({ status: "queued", heldAtSettle: true });
    // Once the drain lifts, admission runs exactly what it held.
    setDraining(false);
    expect(await runDueScheduledTurn(context(store, root, turnDriver), thread.id, Date.now())).toBe(true);
    await settleRuns();
    expect(sent).toEqual(["first", "queued behind"]);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id)?.status).toBe("completed");
  });
});

// -- finding 2: a steer a stopped turn never confirmed -------------------------

describe("a drain never loses a steer a stopped turn never confirmed", () => {
  it("saves the redelivery copy as queued work instead of swallowing it", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    await sendTurn(store, thread.id, { prompt: "STEER-ME", delivery: "steer" });
    setDraining(true);
    const stopped = await interruptTurn(store, thread.id, first.turn.id);
    expect(stopped.turn?.status).toBe("interrupted");
    // The provider never confirmed the steer, so it goes out again — and a
    // drain must not lose it: the copy is durable queued work.
    const copies = await redeliverOrphanedSteers(store, thread.id, first.turn.id);
    expect(copies).toHaveLength(1);
    const saved = (await store.readTurns(thread.id)).find((turn) => turn.id === copies[0]);
    expect(saved).toMatchObject({ status: "queued" });
    const messages = await store.readMessages(thread.id);
    expect(messages.some((message) => message.turnId === saved!.id && message.text === "STEER-ME")).toBe(true);
    expect((await store.readActivities(thread.id)).some((row) => row.kind === "steer.redelivered")).toBe(true);
  });

  it("keeps a queued send on an idle thread rather than refusing it", async () => {
    const { store, thread } = await setup();
    setDraining(true);
    const queued = await sendTurn(store, thread.id, { prompt: "queued while draining", delivery: "queue" });
    expect(queued.turn).toMatchObject({ status: "queued", heldAtSettle: true, delivery: "queued" });
  });
});

// -- finding 6: an interrupted turn promotes nothing while draining --------------

describe("a drain's interruptions promote nothing", () => {
  it("an interrupted running turn holds its queued follower", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    const behind = await sendTurn(store, thread.id, { prompt: "queued behind", delivery: "queue" });
    expect(store.claimRun(first.turn.id)).toBe(true);
    setDraining(true);
    await interruptTurn(store, thread.id, first.turn.id);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id)).toMatchObject({
      status: "queued",
      heldAtSettle: true,
    });
  });

  it("a turn that completes while draining holds its queued follower", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    const behind = await sendTurn(store, thread.id, { prompt: "queued behind", delivery: "queue" });
    expect(store.claimRun(first.turn.id)).toBe(true);
    setDraining(true);
    await completeTurn(store, thread.id, first.turn.id, { text: "done" });
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === behind.turn.id)).toMatchObject({
      status: "queued",
      heldAtSettle: true,
    });
  });
});

// -- gate-position pins: a refused send changes nothing else ----------------------

describe("a drain's refusal leaves the rest of the thread untouched", () => {
  it("does not wake a settled thread it refused to send to", async () => {
    const { store, thread } = await setup();
    const first = await sendTurn(store, thread.id, { prompt: "first" });
    await completeTurn(store, thread.id, first.turn.id, { text: "done" });
    await settleThread(store, thread.id);
    expect((await store.readThreadRecord(thread.id))?.settledAt).not.toBeNull();
    setDraining(true);
    await expect(sendTurn(store, thread.id, { prompt: "wake up", wakeSettled: true })).rejects.toMatchObject({ code: "SERVER_DRAINING" });
    expect((await store.readThreadRecord(thread.id))?.settledAt).not.toBeNull();
    expect((await store.readTurns(thread.id)).map((turn) => turn.status)).toEqual(["completed"]);
  });

  it("does not release a usage hold it refused to continue", async () => {
    const { store, thread } = await setup();
    await sendTurn(store, thread.id, { prompt: "first" });
    const pause = { provider: "claude", windows: [], resetsAt: null, order: 1, phase: "waiting" as const, handoff: false };
    await store.withThreadLock(thread.id, async () => {
      const record = (await store.readThreadRecord(thread.id))!;
      await store.writeThreadRecord({ ...record, usagePause: pause });
    });
    setDraining(true);
    await expect(sendTurn(store, thread.id, { prompt: "carry on" })).rejects.toMatchObject({ code: "SERVER_DRAINING" });
    expect((await store.readThreadRecord(thread.id))?.usagePause).toMatchObject({ phase: "waiting" });
    expect((await store.readThreadRecord(thread.id))?.usageProtectionOverride).toBeUndefined();
  });
});

// -- findings 3-5: the automatic maintenance paths during a drain ----------------

/** A harness whose operations run on the real fake drivers, one per provider kind. */
async function operatingContext(config: Partial<CliConfig> = {}, sent: string[] = []) {
  const harness = await testHarness({ onSendTurn: (turn) => sent.push(turn.prompt) });
  const perKind = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: { ...harness.config, ...config } as CliConfig,
    driverFor: (id) => {
      const kind = driverKindOfInstance(id)!;
      let found = perKind.get(kind);
      if (!found) {
        found = harness.drivers[kind]!();
        perKind.set(kind, found);
      }
      return found;
    },
  };
  return { ...harness, ctx, sent };
}

describe("a drain holds back the automatic maintenance", () => {
  it("defers an automatic hand-off's first turn instead of leaving an empty continuation", async () => {
    const { store, ctx, sent } = await operatingContext({ ui: { autoHandoff: "auto" } });
    const source = await createThread(store, { projectId: "p", title: "src", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const kid = await createThread(store, { projectId: "p", title: "kid", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const now = store.nowIso();
    await store.appendDelegation({ id: "d-kid", parentThreadId: source.id, childThreadId: kid.id, prompt: "x", status: "running", notify: true, createdAt: now, updatedAt: now });
    const kidTurn = await sendTurn(store, kid.id, { prompt: "kid work" });
    await completeTurn(store, kid.id, kidTurn.turn.id, { text: "kid done" });
    await store.updateDelegation("d-kid", { status: "completed" });
    const turn = await sendTurn(store, source.id, { prompt: "Read the repo" });
    await store.appendLedger(source.id, "activity", { id: store.newId(), threadId: source.id, turnId: turn.turn.id, kind: "context-window.updated", summary: "ctx", payload: { usedTokens: 120_000, maxTokens: 200_000 }, createdAt: store.nowIso() });
    await completeTurn(store, source.id, turn.turn.id, { text: "reply" });
    const before = await store.listThreadIds();
    setDraining(true);
    const action = await actOnLongThread(ctx, source.id).catch(() => null);
    // The hand-off still happens — into a turn that waits for the drain,
    // not into a "(continued)" thread with nothing in it.
    expect(action).toMatchObject({ kind: "handoff" });
    const made = (await store.listThreadIds()).filter((id) => !before.includes(id));
    expect(made).toHaveLength(1);
    const carried = (await store.readTurns(made[0]!)).filter((candidate) => candidate.status === "queued" && candidate.heldAtSettle === true);
    expect(carried).toHaveLength(1);
    // Work can start again: the held first turn runs, and a later look sees
    // the line already handed off rather than creating a second destination.
    setDraining(false);
    await runWorkQueue(ctx);
    await settleRuns();
    expect(sent.some((prompt) => prompt.includes("Read the repo"))).toBe(true);
    expect((await store.readTurns(made[0]!)).find((candidate) => candidate.id === carried[0]!.id)?.status).toBe("completed");
    await actOnLongThread(ctx, source.id);
    expect((await store.listThreadIds()).filter((id) => !before.includes(id))).toHaveLength(1);
  });

  it("refuses to stop a running turn for a mid-turn compaction", async () => {
    const { store, ctx } = await operatingContext({ providers: { claude: { autoCompact: "auto" } } });
    const t = await createThread(store, { projectId: "p", title: "c", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const earlier = await sendTurn(store, t.id, { prompt: "earlier" });
    await completeTurn(store, t.id, earlier.turn.id, { text: "earlier reply" });
    const long = await sendTurn(store, t.id, { prompt: "long task" });
    setDraining(true);
    expect(await compactMidTurn(ctx, t.id, { usedTokens: 170_000, maxTokens: 200_000, cachedInputTokens: null, autoCompactThreshold: null, compactsAutomatically: null })).toBe(false);
    expect((await store.readTurns(t.id)).find((candidate) => candidate.id === long.turn.id)?.status).toBe("running");
  });

  it("keeps a pending usage wrap-up pending, without parking an error on it", async () => {
    const { store, ctx, sent } = await operatingContext({ usageProtection: "auto", usageRecovery: "sequential" });
    const guard = new UsageProtection(async () => ctx);
    const t = await createThread(store, { projectId: "p", title: "held", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
    await sendTurn(store, t.id, { prompt: "Finish" });
    await settleRuns();
    await guard.protect(t.id);
    expect((await store.readThreadRecord(t.id))?.usagePause?.phase).toBe("pending");
    setDraining(true);
    await guard.tick().catch(() => undefined);
    expect((await store.readThreadRecord(t.id))?.usagePause).toMatchObject({ phase: "pending" });
    expect(((await store.readThreadRecord(t.id))?.usagePause ?? { error: null }).error ?? null).toBeNull();
    // Once work can start again the wrap-up goes out — the drain was a
    // passing condition, not a broken thread.
    setDraining(false);
    await guard.tick();
    await settleRuns();
    expect(sent.some((prompt) => prompt.startsWith("wrap")) || (await store.readTurns(t.id)).some((candidate) => candidate.origin === "usage-protection")).toBe(true);
    guard.close();
  });

  it("refuses a delegation before it creates anything", async () => {
    const { store, ctx } = await operatingContext();
    const parent = await createThread(store, { projectId: "p", title: "parent", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
    await sendTurn(store, parent.id, { prompt: "orchestrate" });
    const before = await store.listThreadIds();
    const delegations = await store.readDelegations();
    setDraining(true);
    await expect(delegate(ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "codex", model: "gpt-6.1-sol", wait: false })).rejects.toMatchObject({ code: "SERVER_DRAINING" });
    expect(await store.listThreadIds()).toEqual(before);
    expect(await store.readDelegations()).toEqual(delegations);
  });
});

// -- finding 2: an orphan recovered during a drain starts nothing ------------------

/** The pid of a process that has already exited, as a crash leaves behind. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/**
 * A thread whose running turn was left owned by a dead process, with work
 * queued behind it and a steer the dead turn never confirmed.
 */
async function orphanWithFollower(ctx: OperationContext) {
  const t = await createThread(ctx.store, {
    projectId: "p",
    title: "orphan",
    env: { mode: "local", path: ctx.storeRoot, branch: null },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  });
  const orphan = await sendTurn(ctx.store, t.id, { prompt: "the dead turn" });
  await sendTurn(ctx.store, t.id, { prompt: "STEER-ME", delivery: "steer" });
  const behind = await sendTurn(ctx.store, t.id, { prompt: "queued behind", delivery: "queue" });
  await ctx.store.updateTurn(t.id, orphan.turn.id, { owner: { pid: await deadPid(), host: os.hostname() } });
  return { threadId: t.id, orphanTurnId: orphan.turn.id, behindTurnId: behind.turn.id };
}

describe("a drain holds back an orphan's recovery", () => {
  it("reconciles the orphan and keeps its queued follower for the next server", async () => {
    const { store, ctx, sent } = await operatingContext();
    const { threadId, orphanTurnId, behindTurnId } = await orphanWithFollower(ctx);
    setDraining(true);
    expect(await recoverOrphanedTurn(ctx, threadId)).toBe(true);
    // Nothing was dispatched: the follower waits for the next server's
    // admission, exactly as a settle's promotion does during the drain.
    expect(sent).toEqual([]);
    const turns = await store.readTurns(threadId);
    expect(turns.find((turn) => turn.id === orphanTurnId)?.status).toBe("interrupted");
    expect(turns.find((turn) => turn.id === behindTurnId)).toMatchObject({ status: "queued", heldAtSettle: true });
    // Never promoted at all: the follower's row is not taken `running` and
    // handed back, it stays exactly where it waited.
    expect((await store.readActivities(threadId)).some((row) => row.kind === "turn.promoted")).toBe(false);
    // The steer the stopped turn never confirmed is durable queued work, not
    // a copy the drain swallowed.
    const copy = turns.find((turn) => turn.id !== orphanTurnId && turn.id !== behindTurnId);
    expect(copy).toMatchObject({ status: "queued" });
    const messages = await store.readMessages(threadId);
    expect(messages.some((message) => message.turnId === copy!.id && message.text === "STEER-ME")).toBe(true);
    // Once the drain lifts, admission runs the held work in order.
    setDraining(false);
    await runWorkQueue(ctx);
    await settleRuns();
    expect(sent.some((prompt) => prompt.includes("queued behind"))).toBe(true);
  });

  it("sends nothing when the drain begins after the recovery promoted", async () => {
    const { store, ctx, sent } = await operatingContext();
    const { threadId, behindTurnId } = await orphanWithFollower(ctx);
    // Recovery promoted the follower and started preparing its run; the
    // drain begins inside that preparation. The claimed turn goes back to
    // the queue for the next server instead of being dispatched.
    const drainingCtx: OperationContext = {
      ...ctx,
      driverFor: (instanceId) => {
        setDraining(true);
        return ctx.driverFor(instanceId);
      },
    };
    expect(await recoverOrphanedTurn(drainingCtx, threadId)).toBe(true);
    expect(sent).toEqual([]);
    expect((await store.readTurns(threadId)).find((turn) => turn.id === behindTurnId)).toMatchObject({ status: "queued", heldAtSettle: true });
  });
});

// -- finding 3: a compaction whose first read outlived the drain's start ----------

describe("a drain holds back a mid-turn compaction it started waiting on", () => {
  /** A store whose first `readThreadRecord` waits on the test's gate. */
  function gatedStore(store: ThreadStore): { store: ThreadStore; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "readThreadRecord") {
          return async (threadId: string) => {
            await gate;
            return await target.readThreadRecord(threadId);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { store: gated, release };
  }

  it("does not stop the running turn when the drain starts while its read is pending", async () => {
    const { store, ctx } = await operatingContext({ providers: { claude: { autoCompact: "auto" } } });
    const t = await createThread(store, { projectId: "p", title: "c", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const earlier = await sendTurn(store, t.id, { prompt: "earlier" });
    await completeTurn(store, t.id, earlier.turn.id, { text: "earlier reply" });
    const long = await sendTurn(store, t.id, { prompt: "long task" });
    const gated = gatedStore(store);
    const pending = compactMidTurn({ ...ctx, store: gated.store }, t.id, { usedTokens: 170_000, maxTokens: 200_000, cachedInputTokens: null, autoCompactThreshold: null, compactsAutomatically: null });
    setDraining(true);
    gated.release();
    expect(await pending).toBe(false);
    expect((await store.readTurns(t.id)).find((turn) => turn.id === long.turn.id)?.status).toBe("running");
  });

  it("never stops the turn that replaced the one it decided about", async () => {
    const { store, ctx } = await operatingContext({ providers: { claude: { autoCompact: "auto" } } });
    const t = await createThread(store, { projectId: "p", title: "c", env: { mode: "local", path: ctx.storeRoot, branch: null }, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } });
    const earlier = await sendTurn(store, t.id, { prompt: "earlier" });
    await completeTurn(store, t.id, earlier.turn.id, { text: "earlier reply" });
    const long = await sendTurn(store, t.id, { prompt: "long task" });
    const gated = gatedStore(store);
    const pending = compactMidTurn({ ...ctx, store: gated.store }, t.id, { usedTokens: 170_000, maxTokens: 200_000, cachedInputTokens: null, autoCompactThreshold: null, compactsAutomatically: null });
    // The turn the compaction was called for ends on its own, and a fresh
    // one takes its place before the compaction's read comes back.
    await interruptTurn(store, t.id, long.turn.id);
    const replacement = await sendTurn(store, t.id, { prompt: "the replacement" });
    gated.release();
    expect(await pending).toBe(false);
    expect((await store.readTurns(t.id)).find((turn) => turn.id === replacement.turn.id)?.status).toBe("running");
  });
});
