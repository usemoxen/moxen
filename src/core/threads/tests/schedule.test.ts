import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CliConfig } from "../../types.js";
import { resetUsageLimitsForTests, recordUsageWindows } from "../../usage/limits.js";
import { MAX_USAGE_CONTINUES, autoContinuesAt, scheduleUsageContinue, type OperationContext } from "../operations.js";
import { toThreadEnvelope } from "../project.js";
import { armScheduledTurn, armedScheduleCount, onScheduledTurnDue } from "../schedule.js";
import { openThreadStore } from "../store.js";
import { completeTurn, createThread, holdPromotedTurn, interruptTurn, isHeldTurn, promoteDueScheduledTurn, sendTurn, turnPrompt, updateThreadMeta } from "../threads.js";
import { queueAdmission } from "../queue.js";
import { USAGE_CONTINUE_PROMPT } from "../views.js";

const MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  onScheduledTurnDue(null);
  resetUsageLimitsForTests();
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

async function setup(clock?: () => number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "moxen-schedule-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await openThreadStore(root, clock ? { clock } : {});
  const thread = await createThread(store, {
    projectId: "p",
    title: "Scheduled",
    modelSelection: MODEL,
    env: { mode: "local", path: root, branch: null },
  });
  return { store, thread, root };
}

describe("scheduled messages", () => {
  it("queue until their time even on an idle thread, and say when", async () => {
    let now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const sent = await sendTurn(store, thread.id, { prompt: "later", scheduledFor: "2026-09-25T12:00:00Z" });
    expect(sent.turn).toMatchObject({ status: "queued", delivery: "queued", scheduledFor: "2026-09-25T12:00:00.000Z", scheduleReason: "user" });
    expect((await store.readActivities(thread.id)).at(-1)).toMatchObject({ kind: "turn.scheduled", payload: { scheduledFor: "2026-09-25T12:00:00.000Z" } });
    expect(toThreadEnvelope(await store.readThreadRecord(thread.id) as never, await store.readTurns(thread.id)).queuedTurns).toEqual([
      { turnId: sent.turn.id, messageId: sent.messageId, scheduledFor: "2026-09-25T12:00:00.000Z", scheduleReason: "user" },
    ]);

    // Not due: nothing to start.
    expect(await promoteDueScheduledTurn(store, thread.id)).toBeNull();
    now = Date.parse("2026-09-25T12:00:01.000Z");
    const started = await promoteDueScheduledTurn(store, thread.id);
    expect(started).toMatchObject({ id: sent.turn.id, status: "running", startedAt: "2026-09-25T12:00:01.000Z" });
    // Its clock starts when it ran, not when it was scheduled.
    const envelope = toThreadEnvelope((await store.readThreadRecord(thread.id)) as never, await store.readTurns(thread.id));
    expect(envelope.latestTurn).toMatchObject({ requestedAt: "2026-09-25T10:00:00.000Z", startedAt: "2026-09-25T12:00:01.000Z" });
  });

  it("does not batch a waiting one-off Build message into messages following the thread's new Research mode", async () => {
    let now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const scheduledFor = "2026-09-25T12:00:00.000Z";
    const inherited = await sendTurn(store, thread.id, { prompt: "follow the thread", scheduledFor });
    const explicit = await sendTurn(store, thread.id, { prompt: "stay in Build", scheduledFor, interactionMode: "default" });
    await sendTurn(store, thread.id, { prompt: "also Research", scheduledFor, interactionMode: "research" });
    await updateThreadMeta(store, thread.id, { interactionMode: "research" });

    now = Date.parse(scheduledFor);
    const started = await promoteDueScheduledTurn(store, thread.id);
    expect(started).toMatchObject({ id: inherited.turn.id, interactionMode: "research" });
    expect(turnPrompt(await store.readMessages(thread.id), started!)?.text).toBe("follow the thread\n\nalso Research");
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === explicit.turn.id)?.status).toBe("queued");
    await completeTurn(store, thread.id, inherited.turn.id, { text: "done" });
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === explicit.turn.id)).toMatchObject({ status: "running", interactionMode: "default" });
  });

  it("keep one continue after a usage limit, however many times it is asked for", async () => {
    const { store, thread } = await setup();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const first = await sendTurn(store, thread.id, { prompt: USAGE_CONTINUE_PROMPT, scheduledFor: at, scheduleReason: "usage-reset" });
    const again = await sendTurn(store, thread.id, { prompt: USAGE_CONTINUE_PROMPT, scheduledFor: at, scheduleReason: "usage-reset" });
    expect(again.turn.id).toBe(first.turn.id);
    expect((await store.readTurns(thread.id)).filter((turn) => turn.scheduleReason === "usage-reset")).toHaveLength(1);
  });

  it("hold a plain send behind a continue that waits out a usage limit, and run it after", async () => {
    let now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const at = "2026-09-25T12:00:00.000Z";
    const continued = await sendTurn(store, thread.id, { prompt: USAGE_CONTINUE_PROMPT, scheduledFor: at, scheduleReason: "usage-reset" });
    const queued = await sendTurn(store, thread.id, { prompt: "and then this" });
    expect(queued.turn).toMatchObject({ status: "queued", delivery: "queued", scheduledFor: at, scheduleReason: "usage-hold" });

    now = Date.parse("2026-09-25T12:00:01.000Z");
    const started = await promoteDueScheduledTurn(store, thread.id);
    expect(started).toMatchObject({ id: continued.turn.id });
    // It goes out with the continue, in the same turn.
    expect(turnPrompt(await store.readMessages(thread.id), started!)?.text).toContain("and then this");
    expect((await store.readTurns(thread.id)).some((turn) => turn.id === queued.turn.id)).toBe(false);

    // With nothing waiting out a limit, a send runs at once.
    const other = await setup(() => now);
    expect((await sendTurn(other.store, other.thread.id, { prompt: "now" })).turn.status).toBe("running");
  });

  it("send every message held for the reset together, with the continue, as one turn", async () => {
    let now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const at = "2026-09-25T12:00:00.000Z";
    const continued = await sendTurn(store, thread.id, { prompt: USAGE_CONTINUE_PROMPT, scheduledFor: at, scheduleReason: "usage-reset" });
    await sendTurn(store, thread.id, { prompt: "first thought" });
    await sendTurn(store, thread.id, { prompt: "second thought" });

    now = Date.parse("2026-09-25T12:00:01.000Z");
    const started = await promoteDueScheduledTurn(store, thread.id);
    expect(started?.id).toBe(continued.turn.id);
    const turns = await store.readTurns(thread.id);
    expect(turns.filter((turn) => turn.status === "queued")).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(turnPrompt(await store.readMessages(thread.id), started!)?.text).toBe(`${USAGE_CONTINUE_PROMPT}\n\nfirst thought\n\nsecond thought`);
    expect((await store.readActivities(thread.id)).some((row) => row.kind === "turn.batched")).toBe(true);
  });

  it("send messages queued behind a running turn together once it ends", async () => {
    const { store, thread } = await setup();
    const running = await sendTurn(store, thread.id, { prompt: "work" });
    await sendTurn(store, thread.id, { prompt: "then a", delivery: "queue" });
    await sendTurn(store, thread.id, { prompt: "then b", delivery: "queue" });
    // One for another model keeps its own turn.
    await sendTurn(store, thread.id, { prompt: "elsewhere", delivery: "queue", modelSelection: { instanceId: "opencode", model: "gpt-6" } });
    await completeTurn(store, thread.id, running.turn.id, { text: "done" });
    const turns = await store.readTurns(thread.id);
    const next = turns.find((turn) => turn.status === "running")!;
    expect(turnPrompt(await store.readMessages(thread.id), next)?.text).toBe("then a\n\nthen b");
    expect(turns.filter((turn) => turn.status === "queued")).toHaveLength(1);
  });

  it("run at once when the time has already passed, and never steer or restart", async () => {
    const now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const sent = await sendTurn(store, thread.id, { prompt: "now", scheduledFor: "2026-09-25T09:00:00Z" });
    expect(sent.turn.status).toBe("running");
    expect(sent.turn.scheduledFor).toBeUndefined();
    await expect(sendTurn(store, thread.id, { prompt: "x", scheduledFor: "2026-09-25T12:00:00Z", delivery: "steer" })).rejects.toMatchObject({
      code: "INVALID_THREAD_OPTION",
    });
  });

  it("let ordinary queued messages go ahead of a held one when the running turn ends", async () => {
    const now = Date.parse("2026-09-25T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const running = await sendTurn(store, thread.id, { prompt: "first" });
    const held = await sendTurn(store, thread.id, { prompt: "at noon", scheduledFor: "2026-09-25T12:00:00Z" });
    const queued = await sendTurn(store, thread.id, { prompt: "next", delivery: "queue" });
    await completeTurn(store, thread.id, running.turn.id, { text: "done" });
    const turns = await store.readTurns(thread.id);
    expect(turns.find((turn) => turn.id === queued.turn.id)?.status).toBe("running");
    expect(turns.find((turn) => turn.id === held.turn.id)?.status).toBe("queued");
  });

  it("can be cancelled before they run", async () => {
    const { store, thread } = await setup();
    const held = await sendTurn(store, thread.id, { prompt: "later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    const result = await interruptTurn(store, thread.id, held.turn.id);
    expect(result.interrupted).toBe(true);
    expect((await store.readTurns(thread.id))[0]?.status).toBe("interrupted");
    // Marked as never having run, so clients can drop it from the transcript.
    expect((await store.readActivities(thread.id)).at(-1)).toMatchObject({ kind: "turn.interrupted", payload: { beforeStart: true } });
  });
});

describe("schedule timers", () => {
  it("call the owner's handler once a turn is due, and arm nothing without one", () => {
    vi.useFakeTimers();
    armScheduledTurn("t-1", "turn-1", new Date(Date.now() + 1000).toISOString());
    expect(armedScheduleCount()).toBe(0);
    const due: string[] = [];
    onScheduledTurnDue((threadId) => due.push(threadId));
    armScheduledTurn("t-1", "turn-1", new Date(Date.now() + 1000).toISOString());
    armScheduledTurn("t-1", "turn-1", new Date(Date.now() + 2000).toISOString());
    expect(armedScheduleCount()).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(due).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(due).toEqual(["t-1"]);
    expect(armedScheduleCount()).toBe(0);
  });
});

describe("continue after a usage limit", () => {
  function context(store: Awaited<ReturnType<typeof setup>>["store"], root: string, config: Partial<CliConfig> = {}): OperationContext {
    return {
      store,
      storeRoot: root,
      config: { autoContinueAtUsageLimit: true, ...config } as CliConfig,
      driverFor: () => {
        throw new Error("no driver in this test");
      },
    };
  }

  it("schedules one continue a minute after the reset, then counts attempts up to the cap", async () => {
    const { store, thread, root } = await setup();
    const ctx = context(store, root);
    const stopped = await sendTurn(store, thread.id, { prompt: "big task" });
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const first = await scheduleUsageContinue(ctx, thread.id, stopped.turn.id, resetsAt);
    expect(first).toMatchObject({ status: "queued", scheduleReason: "usage-reset", continueAttempt: 1 });
    expect(Date.parse(first!.scheduledFor!)).toBe(Date.parse(resetsAt) + 60_000);
    const message = (await store.readMessages(thread.id)).find((row) => row.id === first!.messageId);
    expect(message?.text).toBe(USAGE_CONTINUE_PROMPT);
    expect(message?.origin).toBe("usage-continue");
    // One pending at a time.
    expect(await scheduleUsageContinue(ctx, thread.id, stopped.turn.id, resetsAt)).toBeNull();

    // The continue ran and hit the limit again: attempt 2, then the cap.
    await interruptTurn(store, thread.id, stopped.turn.id);
    let current = first!;
    for (let attempt = 2; attempt <= MAX_USAGE_CONTINUES; attempt += 1) {
      await store.updateTurn(thread.id, current.id, { status: "failed", scheduledFor: null });
      const next = await scheduleUsageContinue(ctx, thread.id, current.id, resetsAt);
      expect(next?.continueAttempt).toBe(attempt);
      current = next!;
    }
    await store.updateTurn(thread.id, current.id, { status: "failed", scheduledFor: null });
    expect(await scheduleUsageContinue(ctx, thread.id, current.id, resetsAt)).toBeNull();
    expect((await store.readActivities(thread.id)).at(-1)).toMatchObject({
      kind: "notice",
      summary: "Automatic continue stopped after repeated usage-limit hits",
    });
  });

  it.each([-120_000, 3_600_000])("stops at the configured cap even when the reported reset is past (%i ms)", async (offset) => {
    const { store, thread, root } = await setup();
    const ctx = context(store, root, { usageLimitContinues: 1 });
    const stopped = await sendTurn(store, thread.id, { prompt: "big task" });
    const resetsAt = new Date(Date.now() + offset).toISOString();
    const first = await scheduleUsageContinue(ctx, thread.id, stopped.turn.id, resetsAt);
    await store.updateTurn(thread.id, first!.id, { status: "failed", scheduledFor: null });
    expect(await scheduleUsageContinue(ctx, thread.id, first!.id, resetsAt)).toBeNull();
    expect((await store.readActivities(thread.id)).at(-1)).toMatchObject({ payload: { detail: "It tried once. Send a message to pick the task up again." } });
  });

  it("waits out a limit per provider: its own switch, else the global one", () => {
    const config = { autoContinueAtUsageLimit: false, providers: { claude: { autoContinueAtUsageLimit: true }, harness: { autoContinueAtUsageLimit: false } } } as unknown as CliConfig;
    expect(autoContinuesAt(config, "claudeAgent")).toBe(true);
    expect(autoContinuesAt(config, "harness/local")).toBe(false);
    expect(autoContinuesAt({ autoContinueAtUsageLimit: true } as CliConfig, "opencode/opencode")).toBe(true);
    expect(autoContinuesAt({ autoContinueAtUsageLimit: true, providers: { opencode: { autoContinueAtUsageLimit: false } } } as unknown as CliConfig, "opencode/opencode")).toBe(false);
    expect(autoContinuesAt({} as CliConfig, "claudeAgent")).toBe(false);
  });

  it("does nothing without a reset time", async () => {
    const { store, thread, root } = await setup();
    const stopped = await sendTurn(store, thread.id, { prompt: "task" });
    expect(await scheduleUsageContinue(context(store, root), thread.id, stopped.turn.id, null)).toBeNull();
  });
});

/**
 * A usage limit must not drain the queue. Settling a turn promotes the
 * next queued message and its runner starts it at once; with a limit still
 * standing that ran every queued message into the wall, one failed turn
 * after another. The runner now holds the promoted message for the reset.
 */
describe("holding a queued message for the reset", () => {
  it("puts the promoted message back in the queue, held until the reset", async () => {
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const first = await sendTurn(store, thread.id, { prompt: "the turn that hits the limit" });
    const queued = await sendTurn(store, thread.id, { prompt: "sent while it ran", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");

    await completeTurn(store, thread.id, first.turn.id, {});
    const promoted = (await store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id);
    expect(promoted?.status).toBe("running");

    const until = "2026-09-26T15:01:00.000Z";
    expect(await holdPromotedTurn(store, thread.id, queued.turn.id, until)).toBe(true);
    const held = (await store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id)!;
    expect(held).toMatchObject({ status: "queued", scheduledFor: until, scheduleReason: "usage-hold", owner: null });
    expect(isHeldTurn(held, now)).toBe(true);
    expect((await store.readActivities(thread.id)).at(-1)).toMatchObject({ kind: "turn.held", payload: { until } });
    // The envelope says why, so the transcript can label it.
    expect(toThreadEnvelope(await store.readThreadRecord(thread.id) as never, await store.readTurns(thread.id)).queuedTurns).toEqual([
      { turnId: queued.turn.id, messageId: queued.messageId, scheduledFor: until, scheduleReason: "usage-hold" },
    ]);

    // After the reset it comes due like any scheduled message.
    now = Date.parse("2026-09-26T15:01:01.000Z");
    expect((await promoteDueScheduledTurn(store, thread.id))?.id).toBe(queued.turn.id);
  });

  it("leaves a turn whose run has already started alone", async () => {
    const { store, thread } = await setup();
    const sent = await sendTurn(store, thread.id, { prompt: "running for real" });
    store.trackRunning(sent.turn.id, () => {});
    expect(await holdPromotedTurn(store, thread.id, sent.turn.id, "2026-09-26T15:01:00.000Z")).toBe(false);
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === sent.turn.id)?.status).toBe("running");
  });

  it("holds a plain queued turn at settle while its provider is exhausted", async () => {
    let now = Date.parse("2026-09-26T10:00:00.000Z");
    const { store, thread } = await setup(() => now);
    const first = await sendTurn(store, thread.id, { prompt: "the turn that settles" });
    const queued = await sendTurn(store, thread.id, { prompt: "sent while it ran", delivery: "queue" });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    await completeTurn(store, thread.id, first.turn.id, { text: "done" });
    // Held, not promoted: the queue shows it blocked on the same exhaustion.
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id)).toMatchObject({ status: "queued" });
    expect((await store.readActivities(thread.id)).some((row) => row.kind === "turn.promoted")).toBe(false);
    const row = { thread: (await store.readThreadRecord(thread.id))!, turns: await store.readTurns(thread.id) };
    const waiting = row.turns.find((turn) => turn.id === queued.turn.id)!;
    expect(queueAdmission(row, waiting, [row], {} as CliConfig, now).blocked).toContain("claude: usage exhausted");
    // After the reset lapses the next settle promotes it.
    now += 3600_000 + 1000;
    const retry = await sendTurn(store, thread.id, { prompt: "meanwhile" });
    await completeTurn(store, thread.id, retry.turn.id, { text: "done" });
    expect((await store.readTurns(thread.id)).find((turn) => turn.id === queued.turn.id)).toMatchObject({ status: "running" });
  });
});
