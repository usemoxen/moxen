/**
 * Antigravity delegation and automatic prompts (LOCAL-006): off by default,
 * Google's consumer sign-in covers only prompts the user types themselves.
 * Delegation is refused before anything is created; automatic prompts are
 * held in the existing queue/notice machinery and delivered with the user's
 * next message or when the setting turns on. The user's own sends always run.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CliError } from "../../errors.js";
import { testHarness } from "../../testing/harness.js";
import type { ThreadStore } from "../store.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import type { ProviderRuntimeEvent } from "../../providers/spi.js";
import type { TurnDriver } from "../execute.js";
import { COMPACT_PROMPT, COMPACTED_CONTINUE_PROMPT } from "../longthreads.js";
import { parseQueuePolicy } from "../queue.js";
import {
  actOnLongThread,
  compactMidTurn,
  continueOwnThread,
  continueThread,
  delegate,
  flushTaskNotifications,
  queueAgentMessage,
  queueTaskNotification,
  readWorkQueue,
  recoverOrphanedTurn,
  recoverTaskNotifications,
  runWorkQueue,
  sendTaskMessage,
  startTurn,
  type OperationContext,
} from "../operations.js";
import { completeTurn, createThread, interruptTurn, sendTurn } from "../threads.js";

async function world(clock?: () => number) {
  const w = await testHarness(clock === undefined ? {} : { clock });
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: w.store,
    storeRoot: w.root,
    config: w.config,
    driverFor: (instance) => {
      const kind = driverKindOfInstance(instance)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = (w.drivers[kind] ?? w.drivers.codex!)();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const make = (instanceId: string, model = "test-model", title = `Work on ${instanceId}`) =>
    createThread(w.store, { projectId: "p", title, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId, model } });
  const allow = (on: boolean) => {
    w.config.providers = { ...w.config.providers, antigravity: { ...w.config.providers?.antigravity, allowUnsupportedUse: on } };
  };
  return { ...w, ctx, make, allow };
}

/** A notifying delegation row plus a finished turn on the child, as a settled task reports. */
async function settledTask(w: Awaited<ReturnType<typeof world>>, parentId: string, childId: string): Promise<void> {
  const now = new Date().toISOString();
  await w.store.appendDelegation({ id: `d-${childId}`, parentThreadId: parentId, childThreadId: childId, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
  const turn = (await sendTurn(w.store, childId, { prompt: "Do it" })).turn;
  await completeTurn(w.store, childId, turn.id, { text: "Done." });
}

const batchesFile = (root: string) => path.join(root, "task-notification-batches.json");
const readBatches = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(batchesFile(root), "utf8").catch(() => "{}")) as Record<string, unknown>;

describe("Antigravity delegation refused while off", () => {
  it("creates nothing — no thread, no worktree, no delegation row — and names the setting", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const before = await w.store.listThreadIds();
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", isolation: "worktree" }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF", message: expect.stringContaining("providers.antigravity.allowUnsupportedUse") });
    expect(await w.store.listThreadIds()).toEqual(before);
    expect(await w.store.readDelegations()).toEqual([]);
    // A dry run is refused too: it must not plan a delegation that cannot start.
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", dryRun: true }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
  });

  it.each(["antigravity", "antigravity/work", "agy"])("covers every account id (%s), inheriting the parent's selection", async (instanceId) => {
    const w = await world();
    const parent = await w.make(instanceId, "gemini-4-neon");
    await expect(delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", isolation: "shared" }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    expect(await w.store.readDelegations()).toEqual([]);
  });

  it("allows the delegation when the setting is on", async () => {
    const w = await world();
    const parent = await w.make("codex");
    w.allow(true);
    const delegated = await delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", provider: "antigravity", model: "gemini-4-neon", isolation: "shared" });
    await settleRuns();
    expect((await w.store.readThreadRecord(delegated.child.id))?.modelSelection.instanceId).toBe("antigravity");
    expect((await w.store.readDelegations()).some((row) => row.childThreadId === delegated.child.id)).toBe(true);
  });

  it("leaves other providers alone while off", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const delegated = await delegate(w.ctx, { parentThreadId: parent.id, task: "Build it", title: "build", isolation: "shared" });
    await settleRuns();
    expect(delegated.modelSelection.instanceId).toBe("codex");
  });

  it("refuses an agent's task_send and wake to an Antigravity task", async () => {
    const w = await world();
    const parent = await w.make("codex");
    const child = await w.make("antigravity", "gemini-4-neon");
    await settledTask(w, parent.id, child.id);
    await expect(sendTaskMessage(w.ctx, parent.id, child.id, "Keep going", true))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    w.allow(true);
    const sent = await sendTaskMessage(w.ctx, parent.id, child.id, "Keep going", true);
    await settleRuns();
    expect(sent.outcome).toBe("started");
  });

  it("refuses an agent's thread_continue onto Antigravity, but not the user's own Continue", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    await expect(continueOwnThread(w.ctx, { threadId: thread.id, summary: "Handing off." }))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_DELEGATION_OFF" });
    // The user's palette action is their own choice, not delegation.
    const continued = await continueThread(w.ctx, { threadId: thread.id });
    await settleRuns();
    expect((await w.store.readThreadRecord(continued.threadId))?.modelSelection.instanceId).toBe("antigravity");
  });
});

describe("Antigravity automatic prompts held while off", () => {
  it("holds a task notice and delivers it exactly once with the user's next message", async () => {
    const w = await world();
    const parent = await w.make("antigravity", "gemini-4-neon");
    const child = await w.make("codex");
    await settledTask(w, parent.id, child.id);

    await queueTaskNotification(w.ctx, parent.id, child.id);
    // The batch flush (timer or restart) keeps it: no turn starts on the idle parent.
    await flushTaskNotifications(w.ctx, parent.id);
    await settleRuns();
    expect((await w.store.readTurns(parent.id)).length).toBe(0);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);

    // A restart replays the batch and still holds it.
    await recoverTaskNotifications(w.ctx);
    expect((await w.store.readTurns(parent.id)).length).toBe(0);

    // The user's own message runs, and the notice rides out with it.
    const user = await startTurn(w.ctx, { threadId: parent.id, prompt: "Continue please" });
    expect(user.turn.status).toBe("running");
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();

    const notices = (await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification");
    expect(notices).toHaveLength(1);
    const noticeTurns = (await w.store.readTurns(parent.id)).filter((turn) => turn.origin === "task-notification");
    expect(noticeTurns).toHaveLength(1);
    expect(noticeTurns[0]!.status).toBe("completed");
    expect(await readBatches(w.root)).not.toHaveProperty(parent.id);
  });

  it("releases a held task notice when the setting turns on", async () => {
    const w = await world();
    const parent = await w.make("antigravity", "gemini-4-neon");
    const child = await w.make("codex");
    await settledTask(w, parent.id, child.id);
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect((await w.store.readTurns(parent.id)).length).toBe(0);

    w.allow(true);
    await recoverTaskNotifications(w.ctx);
    await settleRuns();
    const notices = (await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification");
    expect(notices).toHaveLength(1);
  });

  it("holds an agent-queued message; the user's message runs while off, then the held one is admitted", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    const queued = await queueAgentMessage(w.ctx, thread.id, { message: "Check the logs" });
    expect(queued.status).toBe("queued");
    expect(queued.waitingFor.join(" ")).toContain("providers.antigravity.allowUnsupportedUse");

    // The admission pass does not start it on its own.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("queued");

    // The user's own message runs while off.
    const user = await startTurn(w.ctx, { threadId: thread.id, prompt: "Go on" });
    expect(user.turn.status).toBe("running");
    await settleRuns();
    // With a user turn behind it, the held message is admitted and runs once.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("completed");
  });

  it("releases a held agent message when the setting turns on", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    const queued = await queueAgentMessage(w.ctx, thread.id, { message: "Check the logs" });
    expect(queued.status).toBe("queued");
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turnId)?.status).toBe("completed");
  });

  it("holds an agent-queued message that moved with a manual continue once the gate is off again", async () => {
    const w = await world();
    // With the setting on, an agent message queues as ordinary traffic;
    // while off it queues as a wake-up instead, which never moves.
    w.allow(true);
    const source = await w.make("antigravity", "gemini-4-neon");
    const first = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, first.id, { text: "Done." });
    const queued = await queueAgentMessage(w.ctx, source.id, {
      message: "Check the logs",
      conditions: [{ type: "entry", threadId: source.id, turnId: first.id }],
    });
    expect(queued.status).toBe("queued");
    expect(queued.waitingFor.join(" ")).not.toContain("providers.antigravity.allowUnsupportedUse");

    // The gate goes back off, then the user continues in a new thread: the
    // queued agent message moves with it like any ordinary entry.
    w.allow(false);
    const continued = await continueThread(w.ctx, { threadId: source.id });
    const destination = continued.threadId;
    const moved = (await w.store.readTurns(destination)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"));
    expect(moved).toBeDefined();
    // The message's origin traveled with the move.
    expect((await w.store.readMessages(destination)).find((message) => message.id === moved!.messageId)?.origin).toBe("agent-message");

    // The handoff turn settles, but the moved entry stays queued: on an
    // Antigravity thread the gate holds it like any queue entry.
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(destination)).find((turn) => turn.id === moved!.id)?.status).toBe("queued");
    const blocked = (await readWorkQueue(w.ctx)).find((entry) => entry.turnId === moved!.id)!.blocked.join(" ");
    expect(blocked).toContain("providers.antigravity.allowUnsupportedUse");

    // Turning the setting back on releases the moved entry.
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(destination)).find((turn) => turn.id === moved!.id)?.status).toBe("completed");
  });

  it("never reads the generated handoff of the move as fresh user consent, even stamped in the same millisecond", async () => {
    // One fixed millisecond: the continuation writes its handoff turn and the
    // transfer copy at the same instant, so a tie can never masquerade as a
    // later user send. Released only when the clock and the ledger both move.
    const instant = Date.parse("2025-06-01T12:00:00.000Z");
    const w = await world(() => instant);
    w.allow(true);
    const source = await w.make("antigravity", "gemini-4-neon");
    const first = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, first.id, { text: "Done." });
    const queued = await queueAgentMessage(w.ctx, source.id, {
      message: "Check the logs",
      conditions: [{ type: "entry", threadId: source.id, turnId: first.id }],
    });
    expect(queued.status).toBe("queued");

    // The gate goes off, then the user continues: the handoff turn and the
    // moved agent entry are stamped in the same millisecond, and the handoff
    // turn carries no origin of its own.
    w.allow(false);
    const continued = await continueThread(w.ctx, { threadId: source.id });
    const destination = continued.threadId;
    const afterMove = await w.store.readTurns(destination);
    const handoffTurn = afterMove[0]!;
    const moved = afterMove.find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    expect(moved).toBeDefined();
    expect(Date.parse(handoffTurn.createdAt)).toBe(Date.parse(moved.createdAt));
    expect(handoffTurn.origin).toBeUndefined();

    // No new user message: the move's own generated handoff is not consent,
    // so the moved entry stays held once the handoff settles.
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(destination)).find((turn) => turn.id === moved.id)?.status).toBe("queued");
    const entry = (await readWorkQueue(w.ctx)).find((candidate) => candidate.turnId === moved.id)!;
    expect(entry.blocked.join(" ")).toContain("providers.antigravity.allowUnsupportedUse");

    // A genuine user message still reads as fresh on the same frozen
    // millisecond: it is appended after the held entry, and the ledger
    // order — not the timestamp tie — proves it later.
    const user = (await sendTurn(w.store, destination, { prompt: "Go on" })).turn;
    expect(Date.parse(user.createdAt)).toBe(Date.parse(moved.createdAt));
    await completeTurn(w.store, destination, user.id, { text: "Done." });
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(destination)).find((turn) => turn.id === moved.id)?.status).toBe("completed");
  });
});

describe("Antigravity usage recovery and compaction held while off", () => {
  /** A context reading past every compaction line, appended as the driver reports it. */
  async function longReading(w: Awaited<ReturnType<typeof world>>, threadId: string, turnId: string, usedTokens: number): Promise<void> {
    await w.store.appendLedger(threadId, "activity", {
      id: w.store.newId(),
      threadId,
      turnId,
      kind: "context-window.updated",
      summary: `${usedTokens} / 200000 tokens in context`,
      payload: { usedTokens, maxTokens: 200_000 },
      createdAt: w.store.nowIso(),
    });
  }

  /** Turn Moxen's own compaction on for Antigravity (the gate itself stays off unless turned on). */
  const compactAuto = (w: Awaited<ReturnType<typeof world>>): void => {
    w.config.providers = { ...w.config.providers, antigravity: { ...w.config.providers?.antigravity, compaction: "auto" } };
  };

  it("holds a persisted usage-protection recovery instead of starting it while off", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    // The recovery the protection coordinator resumes from its checkpoint
    // (protection.ts): a usageControl continue, marked at its source.
    const recovery = await sendTurn(w.store, thread.id, {
      prompt: "The usage allowance has reset. Resume the unfinished task from your wrap-up.",
      origin: "usage-continue",
      usageControl: true,
    }, w.config);
    expect(recovery.turn.status).toBe("queued");
    expect((await w.store.readMessages(thread.id)).find((message) => message.turnId === recovery.turn.id)?.origin).toBe("usage-continue");
    // The setting on lets the same recovery run, as today.
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === recovery.turn.id)?.status).toBe("completed");
  });

  it("holds the automatic /compact of a long Antigravity thread while off, instead of starting it", async () => {
    const w = await world();
    compactAuto(w);
    const thread = await w.make("antigravity", "gemini-4-neon");
    const { turn } = await sendTurn(w.store, thread.id, { prompt: "Read everything." });
    await longReading(w, thread.id, turn.id, 170_000);
    await completeTurn(w.store, thread.id, turn.id, { text: "Done." });
    expect(await actOnLongThread(w.ctx, thread.id)).toEqual({ kind: "compact", reason: "auto" });
    // The compaction prompt Moxen authored never starts: it is held as a
    // wake-up for the user's next message, like any automatic prompt.
    const compact = (await w.store.readTurns(thread.id)).find((t) => t.origin === "compaction");
    expect(compact?.status).toBe("queued");
    expect((await w.store.readTurns(thread.id)).some((t) => t.status === "running")).toBe(false);
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === compact?.id)?.status).not.toBe("queued");
  });

  /**
   * A driver whose "Do a long job." turn never ends until aborted: an
   * earlier turn settles normally (so the thread has a reply), the long one
   * stalls, and any later turn (a /compact) completes once released.
   */
  function longTurnDriver(prompts: string[], hooks: { interrupt?: () => void; release?: (() => void)[] } = {}) {
    const events = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const promptOf = new Map<string, string>();
    let turns = 0;
    let usedTokens = 60_000;
    const setUsedTokens = (tokens: number): void => {
      usedTokens = tokens;
    };
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input: { threadId: string; prompt: string }) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          turns += 1;
          const turnId = `driver-turn-${turns}`;
          promptOf.set(turnId, input.prompt);
          return { threadId: input.threadId, turnId };
        }),
      interruptTurn: () => {
        hooks.interrupt?.();
        return Effect.void;
      },
      awaitTurn: (async (_threadId: string, turnId: string, signal?: AbortSignal) => {
        const prompt = promptOf.get(turnId) ?? "";
        if (prompt === "Do a long job.") {
          await new Promise<never>((_, reject) => {
            const abort = () => reject(new CliError("TURN_ABORTED", "stopped", {}));
            if (signal?.aborted === true) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (prompt.includes("/compact") && hooks.release) await new Promise<void>((resolve) => hooks.release!.push(resolve));
        return { status: "completed", text: "ok", usage: { input: 1, cacheRead: 0, cacheCreate: 0, output: 1, thinking: 0 }, error: null } as never;
      }) as never,
      resumeCursor: () => "cursor",
      contextUsage: async () => ({ usedTokens, maxTokens: 200_000, costUsd: null }) as never,
      streamEvents: Stream.fromQueue(events),
    } as unknown as TurnDriver;
    const report = (threadId: string) => void Effect.runSync(Queue.offer(events, { type: "token-usage.updated", provider: "antigravity", threadId, usage: {} } as never));
    return { driver, report, setUsedTokens };
  }

  /** The harness context with Moxen compaction on for Antigravity, and a thread with one settled reply. */
  async function compactingWorld(driver: TurnDriver, allow: boolean) {
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { compaction: "auto", ...(allow ? { allowUnsupportedUse: true } : {}) } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Long job",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    // A settled earlier turn, so the thread has a reply for the plan to see.
    await startTurn(ctx, { threadId: thread.id, prompt: "Earlier work.", onEvent: () => undefined });
    await settleRuns();
    return { w, ctx, thread };
  }

  it("does not interrupt a running Antigravity turn for a compaction whose follow-up could not run", async () => {
    const prompts: string[] = [];
    let interrupts = 0;
    const { driver } = longTurnDriver(prompts, { interrupt: () => { interrupts += 1; } });
    const { w, ctx, thread } = await compactingWorld(driver, false);
    const started = await startTurn(ctx, { threadId: thread.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Do a long job."), { timeout: 10_000 });
    // A running turn past the line is left running: the /compact and its
    // follow-up are automatic prompts the off gate holds.
    expect(await compactMidTurn(ctx, thread.id, { usedTokens: 170_000, maxTokens: 200_000 } as never)).toBe(false);
    expect(interrupts).toBe(0);
    expect((await w.store.readTurns(thread.id)).some((turn) => turn.id === started.turn.id && turn.status === "running")).toBe(true);
    await interruptTurn(w.store, thread.id);
    await settleRuns();
  });

  it("holds the post-compaction continuation when the setting turns off mid-flight", async () => {
    const prompts: string[] = [];
    const release: (() => void)[] = [];
    const { driver, report, setUsedTokens } = longTurnDriver(prompts, { release });
    const { w, ctx, thread } = await compactingWorld(driver, true);
    await startTurn(ctx, { threadId: thread.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Do a long job."), { timeout: 10_000 });
    // While the setting is on, the mid-turn compaction runs as today: the
    // turn is stopped, and its /compact prompt goes out.
    setUsedTokens(170_000);
    report(thread.id);
    await vi.waitFor(() => expect(prompts.some((prompt) => prompt.includes(COMPACT_PROMPT))).toBe(true), { timeout: 10_000 });
    // The user opts out while the compaction turn is still in flight.
    ctx.config.providers = { ...ctx.config.providers, antigravity: { compaction: "auto" } };
    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    // The follow-up resume is an automatic prompt too: it is held, and the
    // driver never sees it.
    expect(prompts.some((prompt) => prompt.includes(COMPACTED_CONTINUE_PROMPT))).toBe(false);
    const turns = await w.store.readTurns(thread.id);
    expect(turns.some((turn) => turn.origin === "compaction" && turn.status === "queued")).toBe(true);
  });
});

describe("queued Antigravity model handoffs while off", () => {
  it("completes a user-queued model handoff on the stored summary instead of stalling, and holds an automatic one untouched", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    // The user queued the handoff and chose model summarization.
    const userHandoff = await sendTurn(w.store, thread.id, {
      prompt: "Do the work",
      queue: { ...parseQueuePolicy({ conditions: [], continuation: "model" }), requestId: "user-handoff" },
    }, w.config);
    await runWorkQueue(w.ctx);
    await settleRuns();
    const prepared = (await w.store.readTurns(thread.id)).find((t) => t.id === userHandoff.turn.id);
    expect(prepared?.status).toBe("completed");
    expect(prepared?.handoff?.fallback).toBe(true);
    expect((await w.store.readTurns(thread.id)).some((t) => t.origin === "handoff-summary")).toBe(false);
    expect(await w.store.readThreadRecord(prepared?.handoff?.destinationThreadId ?? "none")).not.toBeNull();

    // An app-authored handoff on the same gate is held before preparation
    // touches anything: no summary prompt, no destination, no handoff row.
    const other = await w.make("antigravity", "gemini-4-neon");
    const autoHandoff = await sendTurn(w.store, other.id, {
      prompt: "Keep going",
      origin: "agent-message",
      queue: { ...parseQueuePolicy({ conditions: [], continuation: "model", automatic: true }), requestId: "auto-handoff" },
    }, w.config);
    await runWorkQueue(w.ctx);
    await settleRuns();
    const held = (await w.store.readTurns(other.id)).find((t) => t.id === autoHandoff.turn.id);
    expect(held?.status).toBe("queued");
    expect(held?.handoff).toBeUndefined();
    expect((await w.store.readTurns(other.id)).some((t) => t.origin === "handoff-summary")).toBe(false);

    // An automatic stored handoff into Antigravity is held before any
    // preparation too, model summary or not.
    const storedThread = await w.make("antigravity", "gemini-4-neon");
    const storedHandoff = await sendTurn(w.store, storedThread.id, {
      prompt: "Keep going",
      origin: "agent-message",
      queue: { ...parseQueuePolicy({ conditions: [], continuation: "stored", automatic: true }), requestId: "auto-stored" },
    }, w.config);
    await runWorkQueue(w.ctx);
    await settleRuns();
    const storedHeld = (await w.store.readTurns(storedThread.id)).find((t) => t.id === storedHandoff.turn.id);
    expect(storedHeld?.status).toBe("queued");
    expect(storedHeld?.handoff).toBeUndefined();
  });

  it("completes a user-queued model handoff from an Antigravity source to another provider on the stored summary", async () => {
    const w = await world();
    const thread = await w.make("antigravity", "gemini-4-neon");
    // The user queued a model-summary handoff onto another provider: the
    // summary prompt would run on the Antigravity source, where the gate
    // holds it, so the handoff must complete on its stored summary.
    const crossProvider = await sendTurn(w.store, thread.id, {
      prompt: "Do the work",
      modelSelection: { instanceId: "codex", model: "test-model" },
      queue: { ...parseQueuePolicy({ conditions: [], continuation: "model" }), requestId: "cross-provider" },
    }, w.config);
    await runWorkQueue(w.ctx);
    await settleRuns();
    const prepared = (await w.store.readTurns(thread.id)).find((t) => t.id === crossProvider.turn.id);
    expect(prepared?.status).toBe("completed");
    expect(prepared?.handoff?.fallback).toBe(true);
    expect((await w.store.readTurns(thread.id)).some((t) => t.origin === "handoff-summary")).toBe(false);
    const destination = await w.store.readThreadRecord(prepared?.handoff?.destinationThreadId ?? "none");
    expect(destination?.modelSelection.instanceId).toBe("codex");
  });
});
describe("Antigravity orphan recovery held while off", () => {
  /** The pid of a process that has already exited, as a crash leaves behind. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));
    return child.pid!;
  }

  it("interrupts the orphan but never dispatches the follow-up queued behind it", async () => {
    const w = await world();
    // Queued while the setting was on, which is how task_send reaches an
    // Antigravity task at all; the restart below comes back with it off.
    w.allow(true);
    const parent = await w.make("codex");
    const child = await w.make("antigravity", "gemini-4-neon");
    const now = w.store.nowIso();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    // The child is compacting, and the follow-up queues behind that turn.
    const compact = (await sendTurn(w.store, child.id, { prompt: "/compact" })).turn;
    const follow = await sendTaskMessage(w.ctx, parent.id, child.id, "Now the follow-up", false);
    expect(follow.outcome).toBe("queued");
    // The process running the compaction then dies mid-turn.
    await w.store.updateTurn(child.id, compact.id, { owner: { pid: await deadPid(), host: os.hostname() } });
    // A durable notice for the pair is what makes the startup recovery look at
    // this child; the flush keeps it back while the task still has work.
    await queueTaskNotification(w.ctx, parent.id, child.id);
    await flushTaskNotifications(w.ctx, parent.id);
    expect(await readBatches(w.root)).toEqual({ [parent.id]: [{ child: child.id }] });

    // The restart comes back with automatic prompts off, and recovers the
    // orphan. Interrupting it is right; running the queued follow-up is not.
    w.allow(false);
    await recoverTaskNotifications(w.ctx);
    await settleRuns();
    const statusOf = async (id: string) => (await w.store.readTurns(child.id)).find((turn) => turn.id === id)?.status;
    expect(await statusOf(compact.id)).toBe("interrupted");
    expect(await statusOf(follow.turnId)).toBe("queued");
    // Nor did admission start it on its own.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(await statusOf(follow.turnId)).toBe("queued");
    expect((await w.store.readMessages(child.id)).some((message) => message.text.includes("Now the follow-up") && message.role === "assistant")).toBe(false);

    // The setting turning on releases it, and only then does it run.
    w.allow(true);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(await statusOf(follow.turnId)).toBe("completed");
  }, 30_000);
});

describe("Antigravity dispatch gate at every path (LOCAL-034)", () => {
  /** The owner identity of a process that has already exited, as a crash leaves behind. */
  async function deadOwner(): Promise<{ pid: number; host: string }> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));
    return { pid: child.pid!, host: os.hostname() };
  }

  /** The pid of a process that has already exited, as a crash leaves behind. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));
    return child.pid!;
  }

  /**
   * A driver that records every prompt it is handed, stalls on one named
   * prompt until released, and takes steers mid-turn where `withSteer` says
   * the provider could — as Antigravity does for a turn it never confirmed.
   */
  function recordingDriver(hooks: {
    prompts: string[];
    steers: string[];
    stall?: string;
    release: (() => void)[];
    withSteer?: boolean;
    /** When set, every steer is attempted and recorded here, then rejected by the driver. */
    steerAttempts?: string[];
  }) {
    const promptOf = new Map<string, string>();
    let turns = 0;
    const driver: TurnDriver = {
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: (input: { threadId: string; prompt: string }) =>
        Effect.sync(() => {
          hooks.prompts.push(input.prompt);
          turns += 1;
          const turnId = `driver-turn-${turns}`;
          promptOf.set(turnId, input.prompt);
          return { threadId: input.threadId, turnId };
        }),
      ...(hooks.withSteer === true
        ? {
            steerTurn: (threadId: string, text: string) =>
              hooks.steerAttempts === undefined
                ? Effect.sync(() => { hooks.steers.push(text); })
                : Effect.tryPromise(async () => { hooks.steerAttempts!.push(text); throw new Error("steer rejected by the driver"); }),
          }
        : {}),
      interruptTurn: () => Effect.void,
      awaitTurn: (async (_threadId: string, turnId: string, signal?: AbortSignal) => {
        const prompt = promptOf.get(turnId) ?? "";
        if (prompt === hooks.stall) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve();
            else {
              hooks.release.push(resolve);
              signal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        }
        return { status: "completed", text: `Completed: ${prompt}`, usage: { input: 1, cacheRead: 0, cacheCreate: 0, output: 2, thinking: 0 }, error: null } as never;
      }) as never,
      resumeCursor: () => "cursor",
      streamEvents: Stream.never,
    } as unknown as TurnDriver;
    return driver;
  }

  it("holds a task notice redelivered standalone when the live turn it steered into died", async () => {
    const prompts: string[] = [];
    const steers: string[] = [];
    const driver = recordingDriver({ prompts, steers, release: [], withSteer: true });
    const w = await testHarness({ drivers: { antigravity: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    const make = (instanceId: string, model = "test-model", title = `Work on ${instanceId}`) =>
      createThread(w.store, { projectId: "p", title, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId, model } });
    const parent = await make("antigravity", "gemini-4-neon");
    const child = await make("codex");
    // A notifying delegation row plus a finished turn on the child, as a settled task reports.
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });

    // The user's own turn runs with the setting off; the notice steers into it.
    const live = (await sendTurn(w.store, parent.id, { prompt: "Do a long job." })).turn;
    await queueTaskNotification(ctx, parent.id, child.id);
    await flushTaskNotifications(ctx, parent.id);
    expect(steers.length).toBe(1);
    const notice = steers[0]!;

    // The turn's owner dies before confirming the steer: the notice would be
    // redelivered standalone, with no live user turn left to ride.
    await w.store.updateTurn(parent.id, live.id, { owner: { pid: await deadPid(), host: os.hostname() } });
    await recoverOrphanedTurn(ctx, parent.id);
    await settleRuns();

    // The driver never receives it: the exception only ever held while a live
    // user turn could carry it. The copy keeps its text, held for admission.
    expect(prompts.some((prompt) => prompt.includes(notice.slice(0, 40)))).toBe(false);
    const copy = (await w.store.readTurns(parent.id)).find((turn) => turn.origin === "task-notification" && turn.id !== live.id);
    expect(copy?.status).toBe("queued");

    // A user send releases it, exactly once, as with any held automatic entry.
    await startTurn(ctx, { threadId: parent.id, prompt: "Please continue" });
    await settleRuns();
    await runWorkQueue(ctx);
    await settleRuns();
    const released = (await w.store.readTurns(parent.id)).find((turn) => turn.origin === "task-notification" && turn.id !== live.id);
    expect(released?.status).toBe("completed");
  });

  it("holds a task message queued while the setting was on when it is dispatched after it turned off", async () => {
    const prompts: string[] = [];
    const release: (() => void)[] = [];
    const driver = recordingDriver({ prompts, steers: [], stall: "Do a long job.", release });
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Long job",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });

    // The user's turn runs; with the setting on, a task message queues behind it.
    await startTurn(ctx, { threadId: thread.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Do a long job."), { timeout: 10_000 });
    const queued = await sendTurn(w.store, thread.id, { prompt: "Task follow-up", delivery: "queue", origin: "task-message" });
    expect(queued.turn.status).toBe("queued");

    // The setting goes off before the turn settles; the promotion and dispatch
    // that follow must not hand the queued message to the driver.
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } };
    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    await runWorkQueue(ctx);
    await settleRuns();
    expect(prompts.some((prompt) => prompt.includes("Task follow-up"))).toBe(false);
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");

    // The message is intact and runs once the setting is back on.
    expect((await w.store.readMessages(thread.id)).some((message) => message.turnId === queued.turn.id && message.text.includes("Task follow-up"))).toBe(true);
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    await runWorkQueue(ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("completed");
  });

  it.each(["manual first", "task message first"])(
    "keeps a user's queued message runnable beside a task message the gate holds (%s)",
    async (order) => {
      // Both queue while the setting is on, behind a turn whose owner then dies;
      // the recovery comes back with the setting off, so the task message is
      // held but the manual message must still run, on its own and with its
      // own text — never merged into the held entry.
      const w = await world();
      w.allow(true);
      const parent = await w.make("codex");
      const child = await w.make("antigravity", "gemini-4-neon");
      const now = w.store.nowIso();
      await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
      const live = (await sendTurn(w.store, child.id, { prompt: "Do a long job." })).turn;
      const manual = order === "manual first"
        ? await sendTurn(w.store, child.id, { prompt: "My own words", delivery: "queue" })
        : null;
      const follow = await sendTaskMessage(w.ctx, parent.id, child.id, "Now the follow-up", false);
      expect(follow.outcome).toBe("queued");
      const manualTurn = manual ?? (await sendTurn(w.store, child.id, { prompt: "My own words", delivery: "queue" }));
      await w.store.updateTurn(child.id, live.id, { owner: { pid: await deadPid(), host: os.hostname() } });

      w.allow(false);
      await recoverOrphanedTurn(w.ctx, child.id);
      await settleRuns();
      await runWorkQueue(w.ctx);
      await settleRuns();

      const statusOf = async (id: string) => (await w.store.readTurns(child.id)).find((turn) => turn.id === id)?.status;
      // The user's message ran, alone; the task message was never folded into
      // the turn that ran. It was queued after the manual message when the
      // manual came first, so it stays held; queued before it, the manual
      // message is the fresh consent that releases it, as with any held entry.
      expect(await statusOf(manualTurn.turn.id)).toBe("completed");
      expect(await statusOf(follow.turnId)).toBe(order === "manual first" ? "queued" : "completed");
      expect((await w.store.readTurns(child.id)).filter((turn) => turn.id === manualTurn.turn.id)).toHaveLength(1);
      expect((await w.store.readMessages(child.id)).some((message) => message.turnId === manualTurn.turn.id && message.text === "My own words")).toBe(true);
      expect((await w.store.readMessages(child.id)).some((message) => message.turnId === manualTurn.turn.id && message.text.includes("Now the follow-up"))).toBe(false);
      // Released by the setting, the held task message runs too.
      w.allow(true);
      await runWorkQueue(w.ctx);
      await settleRuns();
      expect(await statusOf(follow.turnId)).toBe("completed");
    },
    30_000,
  );
  /**
   * A driver that records prompts, stalls on one named prompt, accepts steers
   * where asked, and lets the test flip the setting mid-session (`onSession`
   * runs as the session starts, inside the window before the prompt is sent).
   */
  function raceDriver(hooks: {
    prompts: string[];
    steers: string[];
    stall?: string;
    release: (() => void)[];
    withSteer?: boolean;
    onSession?: () => void;
    /** Runs (awaited) before `startSession` resolves: a session start that stalls. */
    sessionStall?: () => Promise<void>;
    /** Runs (awaited) inside every `hasSession`: where a live turn can die mid-flush. */
    onHasSession?: () => Promise<void> | void;
  }) {
    const promptOf = new Map<string, string>();
    const sessions = new Set<string>();
    let turns = 0;
    const driver: TurnDriver = {
      hasSession: (threadId: string) => Effect.tryPromise(async () => { await hooks.onHasSession?.(); return sessions.has(threadId); }),
      startSession: (input: { threadId: string }) => Effect.tryPromise(async () => { sessions.add(input.threadId); hooks.onSession?.(); if (hooks.sessionStall) await hooks.sessionStall(); return {}; }),
      sendTurn: (input: { threadId: string; prompt: string }) =>
        Effect.sync(() => {
          hooks.prompts.push(input.prompt);
          turns += 1;
          const turnId = `driver-turn-${turns}`;
          promptOf.set(turnId, input.prompt);
          return { threadId: input.threadId, turnId };
        }),
      ...(hooks.withSteer === true
        ? { steerTurn: (threadId: string, text: string) => Effect.sync(() => { hooks.steers.push(text); }) }
        : {}),
      interruptTurn: () => Effect.void,
      awaitTurn: (async (_threadId: string, turnId: string, signal?: AbortSignal) => {
        const prompt = promptOf.get(turnId) ?? "";
        if (prompt.includes(hooks.stall ?? "\0stall-none")) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve();
            else {
              hooks.release.push(resolve);
              signal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
        }
        return { status: "completed", text: `Completed: ${prompt}`, usage: { input: 1, cacheRead: 0, cacheCreate: 0, output: 2, thinking: 0 }, error: null } as never;
      }) as never,
      resumeCursor: () => "cursor",
      streamEvents: Stream.never,
    } as unknown as TurnDriver;
    return driver;
  }

  it("keeps manual and automatic queued messages in separate turn rows on Antigravity, even opted in", async () => {
    const prompts: string[] = [];
    const release: (() => void)[] = [];
    const driver = raceDriver({ prompts, steers: [], stall: "Do a long job.", release });
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Long job",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });

    // Both queue behind the live turn while opted in; promotion batches plain
    // queued messages. On Antigravity the batch must keep provenance apart, so
    // a later opt-out can never find the user's message inside a held turn —
    // either queue order.
    await startTurn(ctx, { threadId: thread.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Do a long job."), { timeout: 10_000 });
    const manual = await sendTurn(w.store, thread.id, { prompt: "My own words", delivery: "queue" });
    const follow = await sendTurn(w.store, thread.id, { prompt: "Now the follow-up", delivery: "queue", origin: "task-message" });
    expect(manual.turn.status).toBe("queued");
    expect(follow.turn.status).toBe("queued");

    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    const statusOf = async (id: string) => (await w.store.readTurns(thread.id)).find((turn) => turn.id === id)?.status;
    expect(await statusOf(manual.turn.id)).toBe("completed");
    expect(await statusOf(follow.turn.id)).toBe("completed");
    // No dispatch ever carried the user's words together with the task message.
    expect(prompts.some((prompt) => prompt.includes("My own words") && prompt.includes("Now the follow-up"))).toBe(false);

    // The opt-out order too: the task message ahead, folded into nothing.
    const second = await createThread(w.store, {
      projectId: "p",
      title: "Long job 2",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    await startTurn(ctx, { threadId: second.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => { expect(prompts.filter((prompt) => prompt === "Do a long job.").length).toBe(2); }, { timeout: 10_000 });
    const followFirst = await sendTurn(w.store, second.id, { prompt: "Now the follow-up", delivery: "queue", origin: "task-message" });
    const manualSecond = await sendTurn(w.store, second.id, { prompt: "My own words too", delivery: "queue" });
    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    expect((await w.store.readTurns(second.id)).find((turn) => turn.id === followFirst.turn.id)?.status).toBe("completed");
    expect((await w.store.readTurns(second.id)).find((turn) => turn.id === manualSecond.turn.id)?.status).toBe("completed");
    expect(prompts.some((prompt) => prompt.includes("My own words too") && prompt.includes("Now the follow-up"))).toBe(false);
  }, 30_000);

  it("rechecks the gate at the send boundary: an opt-out during session start never reaches the driver", async () => {
    const prompts: string[] = [];
    const release: (() => void)[] = [];
    let flipOnSessionStart = false;
    const driver = raceDriver({ prompts, steers: [], release, onSession: () => { if (flipOnSessionStart) ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } }; } });
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Agent message",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });

    // The message is admitted and starts while opted in; the user opts out
    // while the session is starting. The recheck at the send boundary must
    // hold it: the driver never sees the prompt, and it is durably requeued.
    flipOnSessionStart = true;
    const queued = await queueAgentMessage(ctx, thread.id, { message: "Check the logs" });
    expect(queued.status).toBe("running");
    await settleRuns();
    expect(prompts.some((prompt) => prompt.includes("Check the logs"))).toBe(false);
    const turn = (await w.store.readTurns(thread.id)).find((candidate) => candidate.id === queued.turnId);
    expect(turn?.status).toBe("queued");

    // Fresh user consent or the setting releases it, as with any held entry.
    flipOnSessionStart = false;
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    await runWorkQueue(ctx);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((candidate) => candidate.id === queued.turnId)?.status).toBe("completed");
  }, 30_000);

  it("holds a task notice when the only live Antigravity turn is an automatic one, and steers it into the user's turn", async () => {
    const prompts: string[] = [];
    const steers: string[] = [];
    const release: (() => void)[] = [];
    const driver = raceDriver({ prompts, steers, stall: "Automatic task work", release, withSteer: true });
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const parent = await createThread(w.store, {
      projectId: "p",
      title: "Parent",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });
    const child = await createThread(w.store, {
      projectId: "p",
      title: "Child",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "codex", model: "test-model" },
    });

    // A task message keeps the parent running an automatic turn; the user
    // opts out. The notice exception needs a live USER turn to ride — with
    // only an automatic one, the notice stays durable: no steer, no turn.
    await startTurn(ctx, { threadId: parent.id, prompt: "Automatic task work", origin: "task-message", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Automatic task work"), { timeout: 10_000 });
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } };
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });
    await queueTaskNotification(ctx, parent.id, child.id);
    await flushTaskNotifications(ctx, parent.id);
    expect(steers.length).toBe(0);
    expect((await w.store.readTurns(parent.id)).some((turn) => turn.origin === "task-notification")).toBe(false);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);

    // The automatic turn ends, and the user's own turn is the ride the
    // exception needs: the notice steers into it, and only then.
    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    await startTurn(ctx, { threadId: parent.id, prompt: "Please continue", onEvent: () => undefined });
    await vi.waitFor(() => expect(steers.length).toBe(1), { timeout: 10_000 });
    await settleRuns();
  }, 30_000);


  it("reads the setting after the gate's reads resolve, not before them", async () => {
    const prompts: string[] = [];
    const sessionReleases: (() => void)[] = [];
    let sessionStarted = false;
    const w = await testHarness({ drivers: { antigravity: () => raceDriver({ prompts, steers: [], release: [], onSession: () => { sessionStarted = true; }, sessionStall: () => new Promise<void>((resolve) => sessionReleases.push(resolve)) }) } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => w.drivers.antigravity!() };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Live read",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });

    // The setting flips off inside the gate's own first store read — the read
    // the decision is made from — with every earlier check passing on the old
    // setting. The decision must still see it; the driver must not see the prompt.
    const GATE_READ = 3;
    let armed = false;
    let threadReads = 0;
    const liveStore = new Proxy(w.store, {
      get(target: ThreadStore, prop: string | symbol) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== "readThreadRecord" || typeof value !== "function") {
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        const readThread = value as (threadId: string) => Promise<unknown>;
        return async (threadId: string) => {
          const thread = await readThread.call(target, threadId);
          if (armed) {
            threadReads += 1;
            if (threadReads === GATE_READ) {
              armed = false;
              ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } };
            }
          }
          return thread;
        };
      },
    });
    const liveCtx: OperationContext = { ...ctx, store: liveStore as typeof w.store };
    const queuing = queueAgentMessage(liveCtx, thread.id, { message: "Check the logs" });
    await vi.waitFor(() => expect(sessionStarted).toBe(true), { timeout: 10_000 });
    armed = true;
    for (const resolve of sessionReleases.splice(0)) resolve();
    await queuing;
    await settleRuns();

    expect(prompts.some((prompt) => prompt.includes("Check the logs"))).toBe(false);
    const waitQueued = (await w.store.readTurns(thread.id)).find((turn) => turn.origin === "agent-message");
    expect(waitQueued?.status).toBe("queued");
  }, 30_000);

  it("hands the turns queued behind a denied dispatch back, so the user's follow-up runs on its own", async () => {
    const prompts: string[] = [];
    const sessionReleases: (() => void)[] = [];
    let sessionStarted = false;
    const driver = raceDriver({ prompts, steers: [], release: [], onSession: () => { sessionStarted = true; }, sessionStall: () => new Promise<void>((resolve) => sessionReleases.push(resolve)) });
    const w = await testHarness({ drivers: { antigravity: () => driver, codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const thread = await createThread(w.store, {
      projectId: "p",
      title: "Hand back",
      env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" },
    });

    // The agent message starts and its session start stalls; the user's message
    // queues behind it. The user opts out; the release reaches the send,
    // which the gate denies — and the user's message must not be stranded.
    const queuing = queueAgentMessage(ctx, thread.id, { message: "Check the logs" });
    await vi.waitFor(() => expect(sessionStarted).toBe(true), { timeout: 10_000 });
    const manual = await sendTurn(w.store, thread.id, { prompt: "Please continue", delivery: "queue" });
    expect(manual.turn.status).toBe("queued");
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } };
    for (const resolve of sessionReleases.splice(0)) resolve();
    await queuing;
    await settleRuns();

    const statusOf = async (id: string) => (await w.store.readTurns(thread.id)).find((turn) => turn.id === id)?.status;
    expect(await statusOf(manual.turn.id)).toBe("completed");
    expect(prompts.some((prompt) => prompt.includes("Please continue"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("Check the logs"))).toBe(false);
    expect(await statusOf((await w.store.readTurns(thread.id)).find((turn) => turn.origin === "agent-message")!.id)).toBe("queued");
  }, 30_000);

  it("steers no notice from a context whose captured setting is on, when the live supplier says off", async () => {
    const prompts: string[] = [];
    const steers: string[] = [];
    const release: (() => void)[] = [];
    const driver = raceDriver({ prompts, steers, stall: "Automatic task work", release, withSteer: true });
    const w = await testHarness({ drivers: { antigravity: () => driver } });
    const driversMap = new Map<string, TurnDriver>();
    const ctx: OperationContext = {
      store: w.store, storeRoot: w.root, config: w.config,
      driverFor: (instance) => { const kind = driverKindOfInstance(instance)!; let d = driversMap.get(kind); if (!d) { d = kind === "antigravity" ? driver : (w.drivers[kind] ?? w.drivers.codex!)(); driversMap.set(kind, d); } return d; },
    };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const parent = await createThread(w.store, { projectId: "p", title: "Parent", env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } });
    const child = await createThread(w.store, { projectId: "p", title: "Child", env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "codex", model: "test-model" } });

    // A task message keeps an automatic turn live; the user opts out.
    await startTurn(ctx, { threadId: parent.id, prompt: "Automatic task work", origin: "task-message", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Automatic task work"), { timeout: 10_000 });
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: false } };

    // The flush runs with a captured context whose config says on, while its
    // own live supplier says off: the notice must stay durable.
    const staleCtx: OperationContext = {
      ...ctx,
      config: { ...ctx.config, providers: { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } } },
      providersInForce: () => ctx.config.providers,
    };
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });
    await queueTaskNotification(staleCtx, parent.id, child.id);
    await flushTaskNotifications(staleCtx, parent.id);
    expect(steers.length).toBe(0);
    // The gate's refusal wrote nothing — no turn row and no message row — and
    // it armed no watcher or timer: nothing fires on its own while the
    // parent has not changed, and the batch waits for the user or the setting.
    expect((await w.store.readTurns(parent.id)).some((turn) => turn.origin === "task-notification")).toBe(false);
    expect((await w.store.readMessages(parent.id)).some((message) => message.origin === "task-notification")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(steers.length).toBe(0);
    expect((await w.store.readTurns(parent.id)).some((turn) => turn.origin === "task-notification")).toBe(false);
    expect((await w.store.readMessages(parent.id)).some((message) => message.origin === "task-notification")).toBe(false);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);

    // The automatic turn ends and the user's own turn rides the notice.
    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
    await startTurn(ctx, { threadId: parent.id, prompt: "Please continue", onEvent: () => undefined });
    await vi.waitFor(() => expect(steers.length).toBe(1), { timeout: 10_000 });
    await settleRuns();
  }, 30_000);

  it("refuses a steer whose target died before the driver took it: nothing is sent, nothing is recorded, and the notice stays durable", async () => {
    const prompts: string[] = [];
    const steers: string[] = [];
    const release: (() => void)[] = [];
    let armed = false;
    let hasSessionCalls = 0;
    let live: { readonly id: string } | null = null;
    const w = await testHarness({});
    const driver = raceDriver({
      prompts, steers, stall: "User work", release, withSteer: true,
      onHasSession: async () => {
        if (armed && live !== null) {
          hasSessionCalls += 1;
          // The second look is the steer delivery's own: the turn it targets dies there.
          if (hasSessionCalls === 2) await interruptTurn(w.store, parent.id, live!.id);
        }
      },
    });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    ctx.config.providers = { ...ctx.config.providers, antigravity: { allowUnsupportedUse: true } };
    const parent = await createThread(w.store, { projectId: "p", title: "Parent", env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } });
    const child = await createThread(w.store, { projectId: "p", title: "Child", env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "codex", model: "test-model" } });

    // The parent's own turn is stalled live; the notice's flush decides on it.
    // Between the decision and the driver's steer, the turn dies — the steer
    // must be refused and the notice kept durable, not steered into nothing.
    live = (await startTurn(ctx, { threadId: parent.id, prompt: "User work", onEvent: () => undefined })).turn;
    await vi.waitFor(() => expect(prompts).toContain("User work"), { timeout: 10_000 });
    armed = true;
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });
    await queueTaskNotification(ctx, parent.id, child.id);
    // The target turn dies between the flush's decision and the send, so the
    // steered start throws before any ledger row is written: the flush never
    // reaches its batch delete, and nothing is sent and nothing is recorded.
    await flushTaskNotifications(ctx, parent.id).catch(() => undefined);
    expect(steers.length).toBe(0);
    expect((await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(0);
    // Nothing re-fires on its own either: no watcher, no timer.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(steers.length).toBe(0);
    expect((await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(0);
    expect(await readBatches(w.root)).toHaveProperty(parent.id);

    // The notice rides the next live user turn.
    armed = false;
    const retry = await startTurn(ctx, { threadId: parent.id, prompt: "User work again", onEvent: () => undefined });
    await vi.waitFor(() => expect(steers.length).toBe(1), { timeout: 10_000 });
    await interruptTurn(w.store, parent.id, retry.turn.id);
    await settleRuns();
  }, 30_000);

  it("forgets the batch after a steered delivery the driver rejected, and arms no repeating retry", async () => {
    const prompts: string[] = [];
    const steerAttempts: string[] = [];
    const release: (() => void)[] = [];
    const driver = recordingDriver({ prompts, steers: [], stall: "Do a long job.", release, withSteer: true, steerAttempts });
    const w = await testHarness({ drivers: { codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    const make = (title: string) =>
      createThread(w.store, { projectId: "p", title, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "codex", model: "test-model" } });
    const parent = await make("Rejected steer parent");
    const child = await make("Rejected steer child");

    // The user's turn is live and stalled; the notice's only path is the steer.
    await startTurn(ctx, { threadId: parent.id, prompt: "Do a long job.", onEvent: () => undefined });
    await vi.waitFor(() => expect(prompts).toContain("Do a long job."), { timeout: 10_000 });
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });

    // One flush, one delivery attempt, and the driver rejects the steer. The
    // batch is then forgotten (the unconfirmed steer row is the notice's own
    // durable redelivery), and no watcher or timer may re-fire the flush on
    // its own while nothing changed: no retry loop, no extra ledger rows.
    await queueTaskNotification(ctx, parent.id, child.id);
    await flushTaskNotifications(ctx, parent.id);
    expect(steerAttempts).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(steerAttempts).toHaveLength(1);
    expect((await w.store.readMessages(parent.id)).filter((message) => message.origin === "task-notification")).toHaveLength(1);
    expect(await readBatches(w.root)).toEqual({});

    for (const resolve of release.splice(0)) resolve();
    await settleRuns();
  }, 30_000);

  it("delivers a rejected steer's notice exactly once, through its redelivery", async () => {
    const prompts: string[] = [];
    const steerAttempts: string[] = [];
    const release: (() => void)[] = [];
    const driver = recordingDriver({ prompts, steers: [], stall: "Do a long job.", release, withSteer: true, steerAttempts });
    const w = await testHarness({ drivers: { codex: () => driver } });
    const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: () => driver };
    const make = (title: string) =>
      createThread(w.store, { projectId: "p", title, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: "codex", model: "test-model" } });
    const parent = await make("Once only parent");
    const child = await make("Once only child");

    // The user's own turn is live; the notice steers into it, and the driver
    // rejects the steer after its ledger row was written — unconfirmed,
    // exactly the row a crash's orphan recovery later redelivers.
    const live = (await sendTurn(w.store, parent.id, { prompt: "Do a long job." })).turn;
    expect(live.status).toBe("running");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: `d-${child.id}`, parentThreadId: parent.id, childThreadId: child.id, prompt: "Do it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const childTurn = (await sendTurn(w.store, child.id, { prompt: "Do it" })).turn;
    await completeTurn(w.store, child.id, childTurn.id, { text: "Done." });
    await queueTaskNotification(ctx, parent.id, child.id);
    await flushTaskNotifications(ctx, parent.id);
    expect(steerAttempts).toHaveLength(1);

    // The stalled turn's owner dies; recovery interrupts it and redelivers the
    // unconfirmed steer as a queued turn of its own, which runs: the notice
    // reaches the driver once. The batch was already forgotten by the
    // rejected steer's flush, so no later flush may deliver it twice.
    await w.store.updateTurn(parent.id, live!.id, { owner: await deadOwner() });
    await recoverOrphanedTurn(ctx, parent.id);
    await settleRuns();
    const copy = (await w.store.readTurns(parent.id)).find((turn) => turn.origin === "task-notification" && turn.id !== live!.id);
    expect(copy?.status).toBe("completed");
    const noticeText = (await w.store.readMessages(parent.id)).find((message) => message.turnId === copy!.id)?.text ?? "";
    expect(noticeText.length).toBeGreaterThan(0);
    const marker = noticeText.slice(0, 40);
    expect(prompts.filter((prompt) => prompt.includes(marker))).toHaveLength(1);

    // Any later flush — a watcher timer, a user send, a restart's recovery —
    // must find nothing left to deliver: the batch was forgotten with the
    // rejected steer, and the notice reached the driver exactly once.
    await flushTaskNotifications(ctx, parent.id);
    await settleRuns();
    expect(prompts.filter((prompt) => prompt.includes(marker))).toHaveLength(1);
    expect(steerAttempts).toHaveLength(1);
    expect(await readBatches(w.root)).toEqual({});
  }, 30_000);
});
