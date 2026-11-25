import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { openThreadStore } from "../store.js";
import { buildHandoff } from "../handoff.js";
import { createThread, sendTurn, completeTurn, interruptTurn, openTurn, trackContinuation, untrackContinuation } from "../threads.js";
import { queueAdmission, parseQueuePolicy } from "../queue.js";
import { armedScheduleCount, armScheduledTurn, onScheduledTurnDue } from "../schedule.js";
import {
  continueThread,
  continueOwnThread,
  editWorkQueue,
  migrateQueuedMessages,
  queueAgentMessage,
  readWorkQueue,
  revertThread,
  runDueScheduledTurn,
  runWorkQueue,
  stageQueuedMessages,
  type OperationContext,
} from "../operations.js";
import type { TurnDriver } from "../execute.js";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";

afterEach(() => {
  vi.useRealTimers();
  resetUsageLimitsForTests();
  onScheduledTurnDue(null);
});

async function world() {
  const sent: { threadId: string; prompt: string }[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => sent.push(turn) });
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
  return { ...harness, ctx, sent, make };
}

async function storePlan(
  w: Awaited<ReturnType<typeof world>>,
  threadId: string,
  turnId: string,
  step: string,
): Promise<void> {
  await w.store.appendLedger(threadId, "activity", {
    id: w.store.newId(),
    threadId,
    turnId,
    kind: "turn.plan.updated",
    summary: step,
    payload: { plan: [{ step, status: "inProgress" }] },
    createdAt: w.store.nowIso(),
  });
}

async function storeCheckpoint(
  w: Awaited<ReturnType<typeof world>>,
  threadId: string,
  turnId: string,
  path: string,
): Promise<void> {
  await w.store.appendLedger(threadId, "checkpoints", {
    id: w.store.newId(),
    threadId,
    turnId,
    status: "available",
    ref: "new",
    baseRef: "old",
    files: [{ path, additions: 3, deletions: 1 }],
    createdAt: w.store.nowIso(),
  });
}

describe("a manual continue moves pending messages to the new thread's work queue", () => {
  it("lands moved entries in their queue order, not the order they were sent in", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    // Sent second-then-third, queued the other way round (a reordered queue).
    await sendTurn(w.store, source.id, { prompt: "Sent first, queued second", queue: parseQueuePolicy({ conditions: [], order: 20 }) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sendTurn(w.store, source.id, { prompt: "Sent second, queued first", queue: parseQueuePolicy({ conditions: [], order: 10 }) });

    const continued = await continueThread(w.ctx, { threadId: source.id });

    const turns = await w.store.readTurns(continued.threadId);
    const messages = await w.store.readMessages(continued.threadId);
    expect(turns.slice(1).map((turn) => messages.find((message) => message.id === turn.messageId)?.text)).toEqual([
      "Sent second, queued first",
      "Sent first, queued second",
    ]);
  });

  it("moves ordinary queued messages as entries, in order, leaving no runnable copy on the source", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    // Explicit orders: Date.now() at send time can collide within a
    // millisecond, which would make the order assertion below meaningless.
    const secondSent = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [], order: 10 }) });
    const thirdSent = await sendTurn(w.store, source.id, {
      prompt: "Third on another model",
      queue: parseQueuePolicy({ conditions: [], order: 20 }),
      modelSelection: { instanceId: "codex", model: "other-model" },
    });
    const sentBefore = w.sent.length;

    const continued = await continueThread(w.ctx, { threadId: source.id });

    const destination = (await w.store.readThreadRecord(continued.threadId))!;
    const destTurns = await w.store.readTurns(destination.id);
    expect(destTurns).toHaveLength(3);
    const [handoff, second, third] = destTurns;
    // The handoff turn runs first; the moved messages wait behind it.
    expect(handoff!.status).toBe("running");
    expect(second).toMatchObject({ status: "queued", delivery: "queued" });
    expect(third).toMatchObject({ status: "queued", delivery: "queued" });
    const destMessages = await w.store.readMessages(destination.id);
    expect(destMessages.find((message) => message.id === second!.messageId)?.text).toBe("Second");
    expect(destMessages.find((message) => message.id === third!.messageId)?.text).toBe("Third on another model");
    // Order, per-turn overrides and the handoff-first wait travel along.
    expect(second!.queue!.order).toBeLessThan(third!.queue!.order);
    expect(third!.modelSelection).toEqual({ instanceId: "codex", model: "other-model" });
    expect(second!.queue!.conditions.at(-1)).toEqual({ type: "entry", threadId: destination.id, turnId: handoff!.id, serverWait: true });
    expect(second!.queue!.requestId).toBe(`handoff:transfer:${secondSent.turn.id}`);
    expect(third!.queue!.requestId).toBe(`handoff:transfer:${thirdSent.turn.id}`);
    // The handoff names the move but does not assign the moved messages as this turn's work.
    const handoffText = destMessages.find((message) => message.id === handoff!.messageId)!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).toContain("First");
    expect(handoffText).not.toContain("Second");
    expect(handoffText).not.toContain("Third on another model");

    // The source keeps its rows as history, but nothing there can run any more.
    const sourceTurns = await w.store.readTurns(source.id);
    expect(sourceTurns.filter((turn) => turn.status === "queued")).toEqual([]);
    const moved = sourceTurns.filter((turn) => turn.handoff?.requestId?.startsWith("transfer:"));
    expect(moved).toHaveLength(2);
    for (const turn of moved) {
      expect(turn).toMatchObject({ status: "interrupted", queue: { removed: true } });
      expect(turn.handoff?.destinationThreadId).toBe(destination.id);
    }
    expect(
      (await w.store.readActivities(source.id)).filter(
        (activity) => activity.kind === "turn.interrupted" && (activity.payload as { beforeStart?: boolean } | undefined)?.beforeStart === true,
      ),
    ).toHaveLength(2);

    // The handoff runs, then each moved entry runs once, in order, on the new thread.
    await settleRuns();
    expect(w.sent.slice(sentBefore).map((turn) => turn.threadId)).toEqual([destination.id]);
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    const prompts = w.sent.slice(sentBefore).map((turn) => turn.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Second");
    expect(prompts[2]).toContain("Third on another model");
    expect(w.sent.slice(sentBefore).every((turn) => turn.threadId === destination.id)).toBe(true);
  });

  it("refuses a manual continue on a busy source, leaving queued turns and messages untouched", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    await sendTurn(w.store, source.id, { prompt: "Third", queue: parseQueuePolicy({ conditions: [] }) });
    const beforeTurns = await w.store.readTurns(source.id);
    const beforeMessages = await w.store.readMessages(source.id);
    const beforeThreads = await w.store.listThreadIds();

    // A running turn owns its queue: the manual continue refuses at once with
    // the structured marker — before any destination, note, staged transfer,
    // queue edit, source mutation or stop.
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      details: { threadId: source.id, turnId: running.id },
    });
    expect(await w.store.listThreadIds()).toEqual(beforeThreads);
    expect((await w.store.readThreadRecord(source.id))?.continueClaim).toBeFalsy();
    expect((await w.store.readActivities(source.id)).filter((activity) => activity.kind === "thread.continued")).toHaveLength(0);
    // Nothing staged, nothing edited: the queued rows and their messages are
    // exactly as they were.
    expect(await w.store.readTurns(source.id)).toEqual(beforeTurns);
    expect(await w.store.readMessages(source.id)).toEqual(beforeMessages);
    expect((await w.store.readTurns(source.id)).some((turn) => turn.handoff !== undefined)).toBe(false);

    // The queued messages still run on the source, in order, once the running
    // turn is out of the way.
    await interruptTurn(w.store, source.id, running.id);
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toEqual(["Second", "Third"]);
  });

  it("holds queued sends on the source while a manual handoff is in flight, without starting a turn", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    // A live manual handoff mid-flight: the claim record is written and its
    // token registered, exactly as the guarded reservation leaves them.
    const token = w.store.newId();
    trackContinuation(token);
    const claimed = (await w.store.readThreadRecord(source.id))!;
    await w.store.writeThreadRecord({
      ...claimed,
      continueClaim: { token, pid: process.pid, host: os.hostname(), at: w.store.nowIso() },
      updatedAt: w.store.nowIso(),
    });
    try {
      // A queued send still lands queued on the source — the source owns it —
      // while a send that would start a turn is refused with the marker.
      const queued = await sendTurn(w.store, source.id, { prompt: "Queued during handoff", queue: parseQueuePolicy({ conditions: [] }) });
      expect(queued.turn.status).toBe("queued");
      await expect(sendTurn(w.store, source.id, { prompt: "Run now" })).rejects.toMatchObject({ code: "THREAD_BUSY" });
      // Neither the admission pass nor promotion starts queued work here.
      await runWorkQueue(w.ctx);
      expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "running")).toEqual([]);
      expect(openTurn(await w.store.readTurns(source.id))).toBeNull();
      await settleRuns();
      expect(w.sent).toEqual([]);
    } finally {
      untrackContinuation(token);
      await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(source.id))!, continueClaim: null });
    }

    // Once the claim clears, the queued sends run on the source, in order.
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toEqual(["Second", "Queued during handoff"]);
  });

  it("keeps a scheduled message's time and still runs the handoff first", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const at = new Date(Date.now() + 1300).toISOString();
    const scheduled = await sendTurn(w.store, source.id, { prompt: "Scheduled follow-up", scheduledFor: at });
    const continued = await continueThread(w.ctx, {
      threadId: source.id,
      scheduledFor: new Date(Date.now() + 2600).toISOString(),
    });
    const destTurns = await w.store.readTurns(continued.threadId);
    expect(destTurns).toHaveLength(2);
    const [handoff, entry] = destTurns;
    expect(handoff).toMatchObject({ status: "queued", scheduledFor: continued.scheduledFor });
    expect(entry).toMatchObject({ status: "queued", scheduledFor: at });
    expect(entry!.queue!.conditions.at(-1)).toEqual({ type: "entry", threadId: continued.threadId, turnId: handoff!.id, serverWait: true });

    // Due before the handoff, the moved entry still waits for it: no early execution.
    await vi.waitFor(() => expect(Date.now() >= Date.parse(at)).toBe(true), { timeout: 10_000, interval: 10 });
    expect(await runDueScheduledTurn(w.ctx, continued.threadId)).toBe(false);
    expect((await w.store.readTurns(continued.threadId)).find((turn) => turn.id === entry!.id)?.status).toBe("queued");

    // The handoff runs at its time, then the moved entry follows.
    await vi.waitFor(() => expect(Date.now() >= Date.parse(continued.scheduledFor!)).toBe(true), { timeout: 10_000, interval: 10 });
    expect(await runDueScheduledTurn(w.ctx, continued.threadId)).toBe(true);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([continued.threadId]);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([continued.threadId, continued.threadId]);
    expect(w.sent[0]!.prompt).not.toContain("Scheduled follow-up");
    expect(w.sent[1]!.prompt).toContain("Scheduled follow-up");
    expect(scheduled.turn.id).not.toBe(entry!.id);
    expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "queued")).toEqual([]);
  });

  it("moves a held entry held, and leaves removed and usage entries on the source", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const held = await sendTurn(w.store, source.id, {
      prompt: "Held draft",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    const removed = await sendTurn(w.store, source.id, { prompt: "Dropped draft", queue: parseQueuePolicy({ conditions: [] }) });
    await editWorkQueue(w.ctx, source.id, removed.turn.id, "remove");
    await sendTurn(w.store, source.id, {
      prompt: "Usage will resume",
      origin: "usage-continue",
      queue: parseQueuePolicy({ conditions: [] }),
      delivery: "queue",
    });
    const agent = await queueAgentMessage(w.ctx, source.id, {
      message: "Agent follow-up",
      conditions: [{ type: "at", at: new Date(Date.now() + 3_600_000).toISOString() }],
    });
    expect(agent.status).toBe("queued");

    const continued = await continueThread(w.ctx, { threadId: source.id });

    const destTurns = await w.store.readTurns(continued.threadId);
    const moved = destTurns.filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"));
    expect(moved).toHaveLength(2);
    const destMessages = await w.store.readMessages(continued.threadId);
    const movedMessages = destMessages.filter((message) => moved.some((turn) => turn.id === message.turnId));
    expect(movedMessages.map((message) => message.text)).toEqual(
      expect.arrayContaining(["Held draft", expect.stringContaining("Agent follow-up")]),
    );
    expect(moved.find((turn) => turn.queue?.held === true)).toBeDefined();
    // Origin travels along: the agent's message is stored with its origin, not as the user's.
    const agentMessage = movedMessages.find((message) => message.text.includes("Agent follow-up"))!;
    expect(agentMessage.origin).toBe("agent-message");

    const sourceTurns = await w.store.readTurns(source.id);
    const sourceMessages = await w.store.readMessages(source.id);
    // The removed draft and the usage entry were not moved.
    expect(sourceTurns.find((turn) => turn.id === removed.turn.id)).toMatchObject({ status: "interrupted" });
    expect(sourceTurns.find((turn) => turn.id === removed.turn.id)?.handoff).toBeUndefined();
    const usageMessage = sourceMessages.find((message) => message.origin === "usage-continue")!;
    expect(sourceTurns.find((turn) => turn.id === usageMessage.turnId)).toMatchObject({ status: "queued" });
    // The held draft left the source exactly once.
    expect(sourceTurns.find((turn) => turn.id === held.turn.id)).toMatchObject({ status: "interrupted", queue: { removed: true } });
  });

  it("keeps attachment bytes and per-turn overrides on the moved entry", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const queued = await sendTurn(w.store, source.id, {
      prompt: "Look at this",
      queue: parseQueuePolicy({ conditions: [] }),
      modelSelection: { instanceId: "codex", model: "other-model" },
      attachments: [{ type: "image", mimeType: "image/png", sizeBytes: 8, name: "screen.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
    });

    const continued = await continueThread(w.ctx, { threadId: source.id });

    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${queued.turn.id}`);
    expect(moved).toBeDefined();
    expect(moved?.modelSelection).toEqual({ instanceId: "codex", model: "other-model" });
    const message = (await w.store.readMessages(continued.threadId)).find((item) => item.id === moved!.messageId)!;
    const original = (await w.store.readMessages(source.id)).find((item) => item.id === queued.turn.messageId)!;
    expect(message.attachments).toEqual(original.attachments);
    expect(message.attachments).toHaveLength(1);
    await expect(readFile(message.attachments![0]!.path)).resolves.toBeDefined();
  });

  it("preserves conditions and latches, and entries elsewhere follow the move", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const now = Date.now();
    const entry = await sendTurn(w.store, source.id, {
      prompt: "After Claude stops",
      queue: parseQueuePolicy({
        conditions: [
          { type: "provider", provider: "claude", state: "exhausted", mode: "after" },
          // Still waiting, so the entry stays queued (and transferable) after the latch.
          { type: "at", at: new Date(now + 60_000).toISOString() },
        ],
      }),
    });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3_600_000).toISOString() }]);
    await runWorkQueue(w.ctx, now);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)?.queue?.latched).toEqual([0]);
    const watcher = await w.make("watcher");
    const waiting = await sendTurn(w.store, watcher.id, {
      prompt: "Waiting on the source",
      queue: parseQueuePolicy({ conditions: [{ type: "entry", threadId: source.id, turnId: entry.turn.id }] }),
    });

    const continued = await continueThread(w.ctx, { threadId: source.id });

    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${entry.turn.id}`)!;
    expect(moved.queue?.conditions[0]).toEqual({ type: "provider", provider: "claude", state: "exhausted", mode: "after" });
    expect(moved.queue?.latched).toEqual([0]);
    expect(moved.queue?.conditions.at(-1)).toEqual({
      type: "entry",
      threadId: continued.threadId,
      turnId: (await w.store.readTurns(continued.threadId))[0]!.id,
      serverWait: true,
    });
    // A later admission pass keeps the observed latch: it is measured
    // against the source turn's own time, not the move.
    await runWorkQueue(w.ctx, now);
    expect((await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)?.queue?.latched).toEqual([0]);
    // The watcher's condition still names the source turn, and still waits — the
    // handoff marker resolves it against the destination entry instead.
    const rows = [
      { thread: (await w.store.readThreadRecord(watcher.id))!, turns: await w.store.readTurns(watcher.id) },
      { thread: (await w.store.readThreadRecord(source.id))!, turns: await w.store.readTurns(source.id) },
      { thread: (await w.store.readThreadRecord(continued.threadId))!, turns: await w.store.readTurns(continued.threadId) },
    ];
    const watcherRow = rows[0]!;
    const watcherTurn = watcherRow.turns.find((turn) => turn.id === waiting.turn.id)!;
    expect(watcherTurn.queue?.conditions).toEqual([{ type: "entry", threadId: source.id, turnId: entry.turn.id }]);
    const blocked = queueAdmission(watcherRow, watcherTurn, rows, w.ctx.config, now).blocked;
    // The followed entry is still queued on the destination, so the watcher
    // still waits; the message names the condition's own thread, as before.
    expect(blocked).toEqual(["Waiting for solo"]);

    // A retry — even across a reopened store — rejoins the same destination
    // without stripping the marker: the watcher stays blocked while the
    // moved entry is still queued ahead of it.
    const reopened = await openThreadStore(w.root);
    const restarted: OperationContext = { ...w.ctx, store: reopened };
    const rejoined = await continueThread(restarted, { threadId: source.id });
    expect(rejoined.threadId).toBe(continued.threadId);
    expect((await reopened.readTurns(continued.threadId)).filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))).toHaveLength(1);
    expect((await reopened.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)?.handoff?.requestId).toBe(`transfer:${entry.turn.id}`);
    const reRows = [
      { thread: (await reopened.readThreadRecord(watcher.id))!, turns: await reopened.readTurns(watcher.id) },
      { thread: (await reopened.readThreadRecord(source.id))!, turns: await reopened.readTurns(source.id) },
      { thread: (await reopened.readThreadRecord(continued.threadId))!, turns: await reopened.readTurns(continued.threadId) },
    ];
    expect(
      queueAdmission(reRows[0]!, reRows[0]!.turns.find((turn) => turn.id === waiting.turn.id)!, reRows, w.ctx.config, now).blocked,
    ).toEqual(["Waiting for solo"]);

    // Once the moved entry settles, a further continue releases the marker
    // and the waiter follows it out without any rewrite.
    await interruptTurn(reopened, continued.threadId, moved.id);
    const settled = await continueThread(restarted, { threadId: source.id });
    expect(settled.threadId).toBe(continued.threadId);
    expect((await reopened.readTurns(continued.threadId))).toHaveLength(2);
    expect((await reopened.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)?.handoff).toBeUndefined();
    const released = [
      { thread: (await reopened.readThreadRecord(watcher.id))!, turns: await reopened.readTurns(watcher.id) },
      { thread: (await reopened.readThreadRecord(source.id))!, turns: await reopened.readTurns(source.id) },
      { thread: (await reopened.readThreadRecord(continued.threadId))!, turns: await reopened.readTurns(continued.threadId) },
    ];
    expect(
      queueAdmission(released[0]!, released[0]!.turns.find((turn) => turn.id === waiting.turn.id)!, released, w.ctx.config, now).blocked,
    ).toEqual([]);
  });

  it("rejoins the same destination on retry and after reopening the store, without duplicating entries", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    const first = await continueThread(w.ctx, { threadId: source.id });
    const destTurnsAfterFirst = await w.store.readTurns(first.threadId);
    expect(destTurnsAfterFirst).toHaveLength(2);

    // A sequential retry rejoins the reserved destination instead of forking.
    const second = await continueThread(w.ctx, { threadId: source.id });
    expect(second.threadId).toBe(first.threadId);
    expect(await w.store.readTurns(first.threadId)).toHaveLength(2);

    // A new store over the same ledger (a restart) rejoins too: no new handoff turn, no duplicate entries.
    const reopened = await openThreadStore(w.root);
    const restarted: OperationContext = { ...w.ctx, store: reopened };
    const third = await continueThread(restarted, { threadId: source.id });
    expect(third.threadId).toBe(first.threadId);
    expect(await reopened.readTurns(first.threadId)).toHaveLength(2);
    expect((await reopened.readTurns(source.id)).filter((turn) => turn.status === "queued")).toEqual([]);
    expect((await reopened.readTurns(first.threadId)).filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))).toHaveLength(1);
  });

  it("leaves the agent's own continue alone: queued work stays on the source and waits there", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "Do the long task" })).turn;
    await sendTurn(w.store, source.id, { prompt: "Queued behind", delivery: "queue" });

    const continued = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });

    // The agent path still queues the destination behind the source's work; nothing moves.
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["queued"]);
    expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "queued")).toHaveLength(1);
    expect((await w.store.readTurns(source.id)).some((turn) => turn.handoff !== undefined)).toBe(false);
    const prompt = (await w.store.readMessages(continued.threadId)).find((message) => message.role === "user")!.text;
    // No transfer, so the queued message keeps today's treatment: embedded as this turn's work.
    expect(prompt).toContain("Queued behind");
    await completeTurn(w.store, source.id, running.id, { text: "Wrapping up." });
    await interruptTurn(w.store, source.id);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(continued.threadId)).map((turn) => turn.status)).toEqual(["completed"]);
  });

  it("does not move usage control, summary or handoff-selected entries", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const ordinary = await sendTurn(w.store, source.id, { prompt: "Ordinary", queue: parseQueuePolicy({ conditions: [] }) });
    const stored = await sendTurn(w.store, source.id, {
      prompt: "Stored handoff",
      queue: { ...parseQueuePolicy({ conditions: [] }), continuation: "stored" },
    });

    const continued = await continueThread(w.ctx, { threadId: source.id });

    expect((await w.store.readTurns(continued.threadId)).filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))).toHaveLength(1);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === stored.turn.id)?.status).toBe("queued");
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === ordinary.turn.id)?.status).toBe("interrupted");
  });

  it("draws one boundary: sends after the claim stay on the source, claimed turns cannot be admitted", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const staged = await sendTurn(w.store, source.id, {
      prompt: "Second",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    const destination = await w.make("dest");
    const handoff = await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    // The claim, exactly as continueThreadInner takes it.
    const claim = await stageQueuedMessages(w.ctx, source.id, destination.id);
    expect(claim?.claimed).toEqual([staged.turn.id]);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)).toMatchObject({
      status: "queued",
      queue: { removed: true },
    });

    // A send landing after the claim belongs only to the source: still
    // queued and runnable there, never in the destination snapshot.
    const late = await sendTurn(w.store, source.id, {
      prompt: "Late",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    expect(late.turn.status).toBe("queued");

    // Admission cannot take the claimed turn, and the handoff — given the
    // claim's exclusion list, as continueThreadInner passes it — hides the
    // claimed turn while the late send appears in neither history nor
    // immediate work.
    await runWorkQueue(w.ctx);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)?.status).toBe("queued");
    const doc = await buildHandoff(w.store, source.id, { knownTurnIds: claim!.known, excludedTurnIds: [...claim!.claimed, ...claim!.restaged] });
    expect(doc).not.toContain("Late");
    expect(doc).not.toContain("Second");
    // Without this call's exclusion the same staged claim reads as ordinary
    // pending work: only landed moves and explicitly claimed turns are hidden.
    const undisguised = await buildHandoff(w.store, source.id, { knownTurnIds: claim!.known });
    expect(undisguised).toContain("Second");

    // The migration moves only the claimed turn; the late send stays queued.
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const moved = (await w.store.readTurns(destination.id)).find((turn) => turn.queue?.requestId === `handoff:transfer:${staged.turn.id}`);
    expect(moved?.status).toBe("queued");
    expect(moved?.queue?.conditions.at(-1)).toEqual({ type: "entry", threadId: destination.id, turnId: handoff.turn.id, serverWait: true });
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)).toMatchObject({ status: "interrupted" });
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === late.turn.id)?.status).toBe("queued");

    // The late send still runs on the source once released: the staged row,
    // already moved, never runs there again.
    await editWorkQueue(w.ctx, source.id, late.turn.id, "release");
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([source.id]);
    expect(w.sent[0]!.prompt).toContain("Late");
  });

  it("keeps a post-claim send off the destination through the real continue path", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await storePlan(w, source.id, done.id, "Early step");
    await storeCheckpoint(w, source.id, done.id, "early.ts");
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    // Deterministic barrier: stage emits queue-changed on the source when it
    // claims, so the late send injected on the next source thread-record
    // read lands strictly between the claim and every handoff projection
    // read. Later reads pass through.
    const readRecord = w.store.readThreadRecord.bind(w.store);
    const emit = w.store.emit.bind(w.store);
    let armed = false;
    let injected = false;
    const emitSpy = vi.spyOn(w.store, "emit").mockImplementation((threadId: string, reason: string) => {
      if (threadId === source.id && reason === "queue-changed") armed = true;
      return emit(threadId, reason);
    });
    const spy = vi.spyOn(w.store, "readThreadRecord").mockImplementation(async (threadId: string) => {
      // Exactly one late send: the barrier targets the handoff projection
      // reads. Later record reads (including the claim cleanup's, under the
      // source lock) must pass through — a send cannot run inside them.
      if (threadId === source.id && armed && !injected) {
        armed = false;
        const late = await sendTurn(w.store, source.id, { prompt: "Late", queue: parseQueuePolicy({ conditions: [] }) });
        await storePlan(w, source.id, late.turn.id, "Late plan");
        await storeCheckpoint(w, source.id, late.turn.id, "late.ts");
        injected = true;
      }
      return readRecord(threadId);
    });
    let continued;
    try {
      continued = await continueThread(w.ctx, { threadId: source.id });
    } finally {
      spy.mockRestore();
      emitSpy.mockRestore();
    }
    expect(injected).toBe(true);

    // The pre-claim message moved; the late prompt, plan and checkpoint are
    // nowhere on the destination — neither the handoff nor any other turn —
    // while the moved message stays out of the handoff's immediate work.
    const destTurns = await w.store.readTurns(continued.threadId);
    expect(destTurns).toHaveLength(2);
    const destMessages = await w.store.readMessages(continued.threadId);
    expect(destMessages.map((message) => message.text).join("\n")).not.toContain("Late");
    const handoffText = destMessages.find((message) => message.role === "user")!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).not.toContain("Second");
    expect(handoffText).toContain("Early step");
    expect(handoffText).toContain("early.ts");
    expect(handoffText).not.toContain("Late plan");
    expect(handoffText).not.toContain("late.ts");

    // The late send stays queued and runnable only on the source.
    const late = (await w.store.readTurns(source.id)).find((turn) => turn.status === "queued")!;
    expect((await w.store.readMessages(source.id)).find((message) => message.id === late.messageId)?.text).toBe("Late");
    expect(destTurns.some((turn) => turn.messageId === late.messageId)).toBe(false);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([continued.threadId, source.id]);
    expect(w.sent.at(-1)!.prompt).toBe("Late");
  });

  it("repairs a crash between destination turn and message writes, without dispatching or duplicating", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    // Fault injection: the first non-handoff destination message write fails.
    const append = w.store.appendLedger.bind(w.store);
    let failed = false;
    const spy = vi.spyOn(w.store, "appendLedger").mockImplementation((threadId, name, row) => {
      const text = (row as { text?: unknown }).text;
      if (!failed && name === "messages" && threadId !== source.id && typeof text === "string" && !text.startsWith("# Continuing:")) {
        failed = true;
        throw new Error("injected ledger failure");
      }
      return append(threadId, name, row);
    });
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toThrow("injected ledger failure");
    spy.mockRestore();
    expect(failed).toBe(true);

    // The partial state: a destination turn row with no message, and the
    // source row still staged — marked, removed, but queued and runnable nowhere.
    const destId = (await w.store.readActivities(source.id)).find((activity) => activity.kind === "thread.continued")?.payload?.threadId as string;
    const partial = (await w.store.readTurns(destId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    expect(partial.status).toBe("queued");
    expect((await w.store.readMessages(destId)).filter((message) => message.turnId === partial.id)).toEqual([]);
    expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "queued")).toHaveLength(1);

    // The partial entry cannot dispatch, even with its handoff complete: it
    // waits for the repair instead of failing.
    await settleRuns();
    expect(openTurn(await w.store.readTurns(destId))).toBeNull();
    // Three admission passes promote nothing and append no activity: the
    // entry is parked as blocked until a continue repairs its message.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await runDueScheduledTurn(w.ctx, destId)).toBe(false);
      await runWorkQueue(w.ctx);
    }
    await settleRuns();
    expect((await w.store.readActivities(destId)).filter((activity) => activity.kind === "turn.promoted" && activity.turnId === partial.id)).toEqual([]);
    expect((await w.store.readTurns(destId)).find((turn) => turn.id === partial.id)?.status).toBe("queued");
    expect(w.sent.filter((turn) => turn.threadId === destId)).toHaveLength(1);
    expect((await w.store.readActivities(destId)).some((activity) => activity.summary === "Its queued message is missing.")).toBe(false);
    const blockedEntry = (await readWorkQueue(w.ctx)).find((entry) => entry.threadId === destId && entry.turnId === partial.id)!;
    expect(blockedEntry.blocked).toContain("Waiting for its move to finish");

    // A retry repairs the message in place and completes the move, once.
    const again = await continueThread(w.ctx, { threadId: source.id });
    expect(again.threadId).toBe(destId);
    expect(await w.store.readTurns(destId)).toHaveLength(2);
    expect((await w.store.readTurns(destId)).filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))).toHaveLength(1);
    const messages = (await w.store.readMessages(destId)).filter((message) => message.turnId === partial.id);
    expect(messages.map((message) => message.text)).toEqual(["Second"]);
    expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "queued")).toEqual([]);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.filter((turn) => turn.threadId === destId).map((turn) => turn.prompt)).toEqual([
      expect.stringContaining("# Continuing:"),
      "Second",
    ]);
    // Further passes start nothing new: the move ran exactly once.
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.filter((turn) => turn.threadId === destId)).toHaveLength(2);
  });

  it("migrate skips an unreadable destination snapshot without appending or marking", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const second = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);

    // Fault injection: the destination turns read fails once, mid-migrate.
    // Unknown is not empty: no entry may be appended, and the source row
    // must stay staged rather than risk two runnable copies on recovery.
    const readTurns = w.store.readTurns.bind(w.store);
    let failed = false;
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation((threadId: string, options?: { reportTornTail?: boolean }) => {
      if (threadId === destination.id && !failed) {
        failed = true;
        throw new Error("injected EIO");
      }
      return readTurns(threadId, options);
    });
    try {
      await migrateQueuedMessages(w.ctx, source.id, destination.id);
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    expect((await w.store.readTurns(destination.id))).toHaveLength(1);
    expect((await w.store.readMessages(destination.id))).toHaveLength(1);
    const staged = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(staged.handoff?.requestId).toBe(`transfer:${second.turn.id}`);
    expect(staged.queue?.removed).toBe(true);

    // Reads recovered: the retry appends exactly one entry and lands it.
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const entries = (await w.store.readTurns(destination.id)).filter((turn) => turn.queue?.requestId === `handoff:transfer:${second.turn.id}`);
    expect(entries).toHaveLength(1);
    expect((await w.store.readMessages(destination.id)).filter((message) => message.turnId === entries[0]!.id).map((message) => message.text)).toEqual(["Second"]);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)).toMatchObject({ status: "interrupted", handoff: { landed: true } });
  });

  it("migrate does not repair into a torn messages tail, and completes exactly once after quarantine", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const second = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    // Crash between the destination turn and message writes: a turn row
    // with no message, then a torn tail as a crash mid-append leaves it.
    const append = w.store.appendLedger.bind(w.store);
    let injected = false;
    const fault = vi.spyOn(w.store, "appendLedger").mockImplementation((threadId, name, row) => {
      const text = (row as { text?: unknown }).text;
      if (!injected && name === "messages" && threadId === destination.id && typeof text === "string" && !text.startsWith("# Continuing:")) {
        injected = true;
        throw new Error("injected ledger failure");
      }
      return append(threadId, name, row);
    });
    await expect(migrateQueuedMessages(w.ctx, source.id, destination.id)).rejects.toThrow("injected ledger failure");
    fault.mockRestore();
    expect(injected).toBe(true);
    const partial = (await w.store.readTurns(destination.id)).find((turn) => turn.queue?.requestId === `handoff:transfer:${second.turn.id}`)!;
    expect(partial).toBeDefined();
    const messagesFile = w.store.messagesFile(destination.id);
    const beforeTear = await readFile(messagesFile, "utf8");
    await writeFile(messagesFile, `${beforeTear}truncated mid-append`, "utf8");

    // The torn tail makes the snapshot unproven: no repair append (which
    // would concatenate garbage), no landed mark — and the file is
    // byte-identical afterwards.
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    expect(await readFile(messagesFile, "utf8")).toBe(`${beforeTear}truncated mid-append`);
    const stillStaged = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(stillStaged.handoff?.landed).toBeUndefined();
    expect(stillStaged.queue?.removed).toBe(true);
    expect((await w.store.readTurns(destination.id)).filter((turn) => turn.queue?.requestId === `handoff:transfer:${second.turn.id}`)).toHaveLength(1);

    // Quarantining the bad line heals the ledger; the retry repairs the
    // message in place — exactly one copy — and lands the move.
    const problem = w.store.storeProblems().find((p) => p.kind === "ledger-line" && p.threadId === destination.id && p.file === messagesFile);
    expect(problem).toBeDefined();
    await w.store.quarantineProblem(problem!.id);
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const messages = (await w.store.readMessages(destination.id)).filter((message) => message.turnId === partial.id);
    expect(messages.map((message) => message.text)).toEqual(["Second"]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(1);
    const landed = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(landed.handoff).toMatchObject({ requestId: `transfer:${second.turn.id}`, landed: true });
  });

  it("does not double-book a staged message when a retry follows an abort before the first turn", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Staged mover", queue: parseQueuePolicy({ conditions: [] }) });

    // Fault injection: the handoff build fails once, after staging but
    // before the destination is created — no first turn yet.
    const readCheckpoints = w.store.readCheckpoints.bind(w.store);
    let failed = false;
    const spy = vi.spyOn(w.store, "readCheckpoints").mockImplementation((threadId: string) => {
      if (!failed) {
        failed = true;
        throw new Error("injected checkpoints failure");
      }
      return readCheckpoints(threadId);
    });
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toThrow("injected checkpoints failure");
    spy.mockRestore();
    expect(failed).toBe(true);

    // The reservation survived the abort: the destination was reserved but
    // never created, and the source row stays staged for it.
    const destId = (await w.store.readActivities(source.id)).find((activity) => activity.kind === "thread.continued")?.payload?.threadId as string;
    expect(destId).toEqual(expect.any(String));
    expect(await w.store.readThreadRecord(destId)).toBeNull();
    expect(await w.store.readTurns(destId)).toEqual([]);
    const stagedId = (await w.store.readTurns(source.id)).find((turn) => turn.status === "queued")!.id;
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === stagedId)).toMatchObject({
      status: "queued",
      queue: { removed: true },
      handoff: { destinationThreadId: destId },
    });

    // The retry rejoins the same reserved destination: the handoff names the
    // move without assigning its text, and the migration moves it exactly once.
    const again = await continueThread(w.ctx, { threadId: source.id });
    expect(again.threadId).toBe(destId);
    const destTurns = await w.store.readTurns(destId);
    expect(destTurns).toHaveLength(2);
    const handoffText = (await w.store.readMessages(destId)).find((message) => message.role === "user")!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).not.toContain("Staged mover");
    expect(destTurns.filter((turn) => turn.queue?.requestId === `handoff:transfer:${stagedId}`)).toHaveLength(1);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === stagedId)).toMatchObject({ status: "interrupted" });
  });

  it("completes a staged move the user reconfigured onto a model continuation, without double-running", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const second = await sendTurn(w.store, source.id, { prompt: "Model follower", queue: parseQueuePolicy({ conditions: [] }) });

    // Abort after staging, as in the double-booking test: the reservation
    // survives with no destination created yet.
    const readCheckpoints = w.store.readCheckpoints.bind(w.store);
    let failed = false;
    const spy = vi.spyOn(w.store, "readCheckpoints").mockImplementation((threadId: string) => {
      if (!failed) {
        failed = true;
        throw new Error("injected checkpoints failure");
      }
      return readCheckpoints(threadId);
    });
    await expect(continueThread(w.ctx, { threadId: source.id })).rejects.toThrow("injected checkpoints failure");
    spy.mockRestore();
    expect(failed).toBe(true);
    const destId = (await w.store.readActivities(source.id)).find((activity) => activity.kind === "thread.continued")?.payload?.threadId as string;

    // The user reconfigures the staged entry onto another continuation.
    // The marker and the removed flag stay: the move still owns the text.
    await editWorkQueue(w.ctx, source.id, second.turn.id, "edit", parseQueuePolicy({ conditions: [], continuation: "model" }));
    const reconfigured = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(reconfigured.handoff?.requestId).toBe(`transfer:${second.turn.id}`);
    expect(reconfigured.queue).toMatchObject({ removed: true, continuation: "model" });

    // The retry rejoins the same destination, excludes the staged text from
    // the handoff, and completes the move with the user's policy.
    const again = await continueThread(w.ctx, { threadId: source.id });
    expect(again.threadId).toBe(destId);
    const handoffText = (await w.store.readMessages(destId)).find((message) => message.role === "user")!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).not.toContain("Model follower");
    const moved = (await w.store.readTurns(destId)).filter((turn) => turn.queue?.requestId === `handoff:transfer:${second.turn.id}`);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.queue?.continuation).toBe("model");
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)).toMatchObject({ status: "interrupted", handoff: { landed: true } });

    // The moved entry is preparable by the destination's own queue flow: a
    // model summary is requested for it once the handoff settles.
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(destId)).some((turn) => turn.queue?.summaryFor === moved[0]!.id)).toBe(true);
    // And the source copy never ran: the text executes nowhere but the move.
    expect(w.sent.filter((turn) => turn.threadId === source.id && turn.prompt === "Model follower")).toEqual([]);
    for (const threadId of [source.id, destId]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("does not prepare a moved onward handoff before its timed handoff settles", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    // A scheduled continuation: the destination handoff waits for its time first.
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", parseQueuePolicy({ conditions: [], continuation: "model" }));
    const threadsBefore = await w.store.listThreadIds();

    // The queue pass must not enqueue a summary turn or prepare a next
    // destination while the timed handoff has not settled.
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(await w.store.listThreadIds()).toEqual(threadsBefore);
    expect((await w.store.readTurns(continued.threadId)).some((turn) => turn.queue?.summaryFor === moved.id)).toBe(false);
    expect((await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)?.status).toBe("queued");
    for (const threadId of [source.id, continued.threadId]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("never prepares, completes, or discards a partially migrated moved entry", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    const staged = (await w.store.readTurns(source.id)).find((turn) => turn.status === "queued")!;
    await editWorkQueue(w.ctx, source.id, staged.id, "edit", parseQueuePolicy({ conditions: [], continuation: "model" }));

    // Crash between the destination turn and message writes: a turn row
    // with no message, and the source row still staged.
    const append = w.store.appendLedger.bind(w.store);
    let injected = false;
    const fault = vi.spyOn(w.store, "appendLedger").mockImplementation((threadId, name, row) => {
      const text = (row as { text?: unknown }).text;
      if (!injected && name === "messages" && threadId === destination.id && typeof text === "string" && !text.startsWith("# Continuing:")) {
        injected = true;
        throw new Error("injected ledger failure");
      }
      return append(threadId, name, row);
    });
    await expect(migrateQueuedMessages(w.ctx, source.id, destination.id)).rejects.toThrow("injected ledger failure");
    fault.mockRestore();
    expect(injected).toBe(true);
    const partial = (await w.store.readTurns(destination.id)).find((turn) => turn.queue?.requestId === `handoff:transfer:${staged.id}`)!;
    expect((await w.store.readMessages(destination.id)).filter((message) => message.turnId === partial.id)).toEqual([]);

    // The handoff settles without the message ever landing: the queue pass
    // must leave the partial entry alone — no summary, no next
    // destination, no completion, no failure marking.
    const handoffId = (await w.store.readTurns(destination.id)).find((turn) => !turn.queue?.requestId?.startsWith("handoff:transfer:"))!.id;
    await interruptTurn(w.store, destination.id, handoffId);
    const threadsBefore = await w.store.listThreadIds();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(await w.store.listThreadIds()).toEqual(threadsBefore);
    expect((await w.store.readTurns(destination.id)).some((turn) => turn.queue?.summaryFor === partial.id)).toBe(false);
    expect((await w.store.readTurns(destination.id)).find((turn) => turn.id === partial.id)).toMatchObject({ status: "queued" });
    for (const threadId of [source.id, destination.id]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("carries a moved entry's own schedule into its onward destination", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const due = new Date(Date.now() + 3_600_000).toISOString();
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }), scheduledFor: due });

    const continued = await continueThread(w.ctx, { threadId: source.id });
    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    expect(moved.scheduledFor).toBe(due);
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", parseQueuePolicy({ conditions: [], continuation: "stored" }));
    const handoffId = (await w.store.readTurns(continued.threadId)).find((turn) => !turn.queue?.requestId?.startsWith("handoff:transfer:"))!.id;

    // While the handoff runs, preparation waits — then the settled handoff
    // lets the entry prepare into a next destination that keeps both the
    // original handoff wait and the entry's own schedule.
    await runWorkQueue(w.ctx);
    expect((await w.store.readTurns(continued.threadId)).filter((turn) => turn.queue?.summaryFor === moved.id)).toEqual([]);
    await settleRuns();
    await runWorkQueue(w.ctx);
    const prepared = (await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
    expect(prepared.status).toBe("completed");
    const onwardId = (await w.store.readActivities(continued.threadId)).find((activity) => activity.kind === "handoff.prepared")?.payload?.destinationThreadId as string;
    expect(onwardId).toEqual(expect.any(String));
    const onward = (await w.store.readTurns(onwardId))[0]!;
    expect(onward.scheduledFor).toBe(due);
    expect(onward.queue?.conditions).toContainEqual({ type: "entry", threadId: continued.threadId, turnId: handoffId, serverWait: true });
    // Not due yet: nothing starts there early.
    expect(await runDueScheduledTurn(w.ctx, onwardId)).toBe(false);
    expect(openTurn(await w.store.readTurns(onwardId))).toBeNull();
    await settleRuns();
    for (const threadId of [source.id, continued.threadId, onwardId]) {
      for (const turn of await w.store.readTurns(threadId)) {
        if (turn.status === "running") await interruptTurn(w.store, threadId, turn.id);
      }
    }
  });

  it("arms moved schedules where the scheduler owns the process", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    // Register the scheduler first, then arm the source timer exactly as
    // startTurn does on the production path: without an armed source timer
    // the test could not tell a missing disarmScheduledTurn apart from a
    // working one.
    const fired: string[] = [];
    onScheduledTurnDue((threadId) => void fired.push(threadId));
    const before = armedScheduleCount();
    const later = await sendTurn(w.store, source.id, { prompt: "Later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    armScheduledTurn(source.id, later.turn.id, later.turn.scheduledFor!);
    expect(armedScheduleCount() - before).toBe(1);

    const continued = await continueThread(w.ctx, { threadId: source.id });

    // The moved schedule is armed on the destination; the source timer is
    // gone, so the net count is unchanged, and nothing fires in this test.
    expect(armedScheduleCount() - before).toBe(1);
    expect(fired).toEqual([]);
    expect((await w.store.readTurns(continued.threadId)).find((turn) => typeof turn.scheduledFor === "string")?.status).toBe("queued");
  });

  it("takes back a staged turn the user removed, and its partial destination entry", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    await editWorkQueue(w.ctx, source.id, staged.turn.id, "remove");
    await migrateQueuedMessages(w.ctx, source.id, destination.id);

    // Unmarked: ordinary removed history, visible in later handoffs as such.
    const taken = (await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)!;
    expect(taken).toMatchObject({ status: "interrupted" });
    expect(taken.handoff).toBeUndefined();
    expect((await w.store.readTurns(destination.id))).toHaveLength(1);
    const doc = await buildHandoff(w.store, source.id);
    expect(doc).toContain("Second");
  });

  it("unstages an abandoned claim on a non-manual continue, reading it as ordinary pending work", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });

    // A crash between staging and destination creation: the marker names a
    // thread that was never created.
    const claim = await stageQueuedMessages(w.ctx, source.id, w.store.newId());
    expect(claim?.claimed).toHaveLength(1);
    const stagedId = claim!.claimed[0]!;
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === stagedId)).toMatchObject({
      status: "queued",
      queue: { removed: true },
    });

    // The agent's own continue never migrates, so it reconciles first: the
    // claim is cleared and the handoff reads the message as ordinary pending
    // work instead of announcing a move that never landed.
    const continued = await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    const unstaged = (await w.store.readTurns(source.id)).find((turn) => turn.id === stagedId)!;
    expect(unstaged.handoff).toBeUndefined();
    expect(unstaged.queue?.removed).toBe(false);
    expect(unstaged.status).toBe("queued");
    const doc = (await w.store.readMessages(continued.threadId)).find((message) => message.role === "user")!.text;
    expect(doc).toContain("Second");
    expect(doc).not.toContain("moved to the new thread's Work queue");
    expect((await w.store.readTurns(continued.threadId)).filter((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))).toEqual([]);
  });

  it("leaves staged markers alone when the destination read fails, even with a landed entry", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const second = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    // The complete state: source marked and taken back, destination entry
    // whole and live.
    await stageQueuedMessages(w.ctx, source.id, destination.id);
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const movedId = `handoff:transfer:${second.turn.id}`;
    expect((await w.store.readTurns(destination.id)).filter((turn) => turn.queue?.requestId === movedId)).toHaveLength(1);

    // Fault injection: the destination turns read fails once, mid-reconcile.
    // Absence unproven, the markers must stay staged — unstaging here would
    // run the message on the source next to the landed copy.
    const readTurns = w.store.readTurns.bind(w.store);
    let failed = false;
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation((threadId: string, options?: { reportTornTail?: boolean }) => {
      if (threadId === destination.id && !failed) {
        failed = true;
        throw new Error("injected EIO");
      }
      return readTurns(threadId, options);
    });
    try {
      await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    const staged = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(staged.handoff).toMatchObject({ requestId: `transfer:${second.turn.id}`, destinationThreadId: destination.id });
    expect(staged.queue?.removed).toBe(true);
    expect((await w.store.readTurns(destination.id)).filter((turn) => turn.queue?.requestId === movedId)).toHaveLength(1);

    // Reads recovered: the landed entry is visible again, so a further
    // non-manual continue still keeps the marker — still exactly one entry.
    await continueOwnThread(w.ctx, { threadId: source.id, summary: "Still half done." });
    const kept = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(kept.handoff?.requestId).toBe(`transfer:${second.turn.id}`);
    expect((await w.store.readTurns(destination.id)).filter((turn) => turn.queue?.requestId === movedId)).toHaveLength(1);
  });

  it("leaves staged markers alone when a destination row is unreadable", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const second = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const movedId = `handoff:transfer:${second.turn.id}`;
    const entry = (await w.store.readTurns(destination.id)).find((turn) => turn.queue?.requestId === movedId)!;
    expect(entry).toBeDefined();

    // A crash mid-append of the entry's own turn row: the row is still in
    // the file but unreadable, so the entry only looks absent. Unstaging on
    // that snapshot would run the message on the source next to the landed
    // copy once the ledger heals.
    const file = w.store.turnsFile(destination.id);
    const lines = (await readFile(file, "utf8")).split("\n");
    const at = lines.findIndex((line) => line.includes(entry.id));
    expect(at).toBeGreaterThanOrEqual(0);
    lines[at] = lines[at]!.slice(0, 30);
    await writeFile(file, lines.join("\n"), "utf8");
    await continueOwnThread(w.ctx, { threadId: source.id, summary: "Half done." });

    const staged = (await w.store.readTurns(source.id)).find((turn) => turn.id === second.turn.id)!;
    expect(staged.handoff).toMatchObject({ requestId: `transfer:${second.turn.id}`, destinationThreadId: destination.id });
    expect(staged.queue?.removed).toBe(true);
  });

  it("clearing the staging claim when editWorkQueue restores a staged entry, so a later migrate leaves it", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    await editWorkQueue(w.ctx, source.id, staged.turn.id, "restore");
    await editWorkQueue(w.ctx, source.id, staged.turn.id, "release");

    // Unmarked: the next migrate moves nothing, later handoffs read the
    // message as ordinary work, and it still runs on the source.
    const restored = (await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)!;
    expect(restored.handoff).toBeUndefined();
    expect(restored.status).toBe("queued");
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    expect((await w.store.readTurns(destination.id))).toHaveLength(1);
    expect(await buildHandoff(w.store, source.id)).toContain("Second");
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toContain("Second");
    expect(w.sent.every((turn) => turn.threadId === source.id)).toBe(true);
  });

  it("refuses the edit when the destination turns ledger cannot be read", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    // The guarded read inside the edit is the second read of the destination
    // ledger: the first happens up front in readWorkQueue and must succeed
    // for the edit to reach the guard.
    const readTurns = w.store.readTurns.bind(w.store);
    let destinationReads = 0;
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation((threadId: string) => {
      if (threadId === destination.id) {
        destinationReads += 1;
        if (destinationReads === 2) throw new Error("injected turns failure");
      }
      return readTurns(threadId);
    });
    try {
      await expect(editWorkQueue(w.ctx, source.id, staged.turn.id, "hold")).rejects.toMatchObject({ code: "STORE_READ_FAILED" });
    } finally {
      spy.mockRestore();
    }
    expect(destinationReads).toBe(2);
    // The failed read changed nothing: the claim is still staged.
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)?.handoff?.requestId).toBe(`transfer:${staged.turn.id}`);
  });

  it("refuses the edit when the destination turns ledger skips an unreadable row", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: [] }) });
    const destination = await w.make("dest");
    await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    await stageQueuedMessages(w.ctx, source.id, destination.id);
    // A torn tail on the destination turns ledger: the guard reads it with
    // torn-tail reporting, so the skip is proven instead of silent — and an
    // entry the skip could be hiding is unknown, not absent.
    const file = w.store.turnsFile(destination.id);
    const before = await readFile(file, "utf8");
    await writeFile(file, `${before}truncated mid-append`, "utf8");
    await expect(editWorkQueue(w.ctx, source.id, staged.turn.id, "hold")).rejects.toMatchObject({ code: "STORE_READ_FAILED" });
    // Refused before any change: the claim is still staged.
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)?.handoff?.requestId).toBe(`transfer:${staged.turn.id}`);
  });

  it("edits a moved entry with 16 client conditions without counting the internal wait", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const clientConditions = Array.from({ length: 16 }, (_, index) => ({
      type: "at" as const,
      at: new Date(Date.now() + (index + 1) * 3_600_000).toISOString(),
    }));
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: clientConditions }) });

    const continued = await continueThread(w.ctx, { threadId: source.id });
    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    // 16 client conditions plus the internal wait on the handoff turn.
    expect(moved.queue?.conditions).toHaveLength(17);
    const internal = moved.queue!.conditions.at(-1)!;
    expect(internal).toEqual({ type: "entry", threadId: continued.threadId, turnId: (await w.store.readTurns(continued.threadId))[0]!.id, serverWait: true });

    // Re-saving the same 16 client conditions plus the internal one succeeds:
    // without the strip it would exceed the 16-condition cap. The policy is
    // built raw: parseQueuePolicy itself would refuse 17 conditions.
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", { ...moved.queue!, conditions: [...clientConditions, internal] });
    const edited = (await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
    expect(edited.queue?.conditions).toHaveLength(17);
    expect(edited.queue?.conditions.at(-1)).toEqual(internal);

    // A wait the UI moved elsewhere is normalized back to the end, exactly
    // once — the count still covers only the 16 client conditions.
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", { ...moved.queue!, conditions: [internal, ...clientConditions.slice(0, 15)] });
    const normalized = (await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
    expect(normalized.queue?.conditions).toHaveLength(16);
    expect(normalized.queue?.conditions.at(-1)).toEqual(internal);
    expect(normalized.queue?.conditions.filter((c) => c.type === "entry" && c.threadId === continued.threadId)).toHaveLength(1);

    // An omitted wait is reattached, exactly once.
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", { ...moved.queue!, conditions: clientConditions.slice(0, 15) });
    const reattached = (await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
    expect(reattached.queue?.conditions).toHaveLength(16);
    expect(reattached.queue?.conditions.at(-1)).toEqual(internal);

    // A 17th client condition still exceeds the cap, internal wait or not.
    const seventeenClients = [...clientConditions, { type: "at" as const, at: new Date(Date.now() + 99_999_999).toISOString() }];
    await expect(
      editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", { ...moved.queue!, conditions: [...seventeenClients, internal] }),
    ).rejects.toMatchObject({ code: "INVALID_QUEUE" });
  });

  it("replaces the settled prior transfer wait on a second move, so 16 client conditions stay editable", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    const clientConditions = Array.from({ length: 16 }, (_, index) => ({
      type: "at" as const,
      at: new Date(Date.now() + (index + 1) * 3_600_000).toISOString(),
    }));
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: clientConditions }) });

    // First move: 16 client conditions plus the server's wait on B's handoff.
    const ab = await continueThread(w.ctx, { threadId: source.id });
    await settleRuns();
    const onB = (await w.store.readTurns(ab.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    expect(onB.queue?.conditions).toHaveLength(17);
    const priorWait = onB.queue!.conditions.at(-1)!;
    expect(priorWait).toEqual({ type: "entry", threadId: ab.threadId, turnId: (await w.store.readTurns(ab.threadId))[0]!.id, serverWait: true });

    // Second move while the entry is still pending (its 16 times are in the
    // future): the settled wait on B is replaced by the wait on C's handoff,
    // never stacked beside it.
    const bc = await continueThread(w.ctx, { threadId: ab.threadId });
    const onC = (await w.store.readTurns(bc.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    expect(onC).toBeDefined();
    expect(onC.queue?.conditions).toHaveLength(17);
    expect(onC.queue!.conditions.slice(0, 16)).toEqual(clientConditions);
    expect(onC.queue!.conditions.at(-1)).toEqual({ type: "entry", threadId: bc.threadId, turnId: (await w.store.readTurns(bc.threadId))[0]!.id, serverWait: true });

    // The projection hides only C's wait, and a client echoing what it sees
    // (16 client conditions) edits without hitting the 16-condition cap.
    const entry = (await readWorkQueue(w.ctx)).find((candidate) => candidate.threadId === bc.threadId && candidate.turnId === onC.id)!;
    expect(entry.policy.conditions).toEqual(clientConditions);
    await editWorkQueue(w.ctx, bc.threadId, onC.id, "edit", { ...onC.queue!, conditions: [...entry.policy.conditions, onC.queue!.conditions.at(-1)!] });
    const edited = (await w.store.readTurns(bc.threadId)).find((turn) => turn.id === onC.id)!;
    expect(edited.queue?.conditions).toHaveLength(17);
    expect(edited.queue!.conditions.at(-1)).toEqual(onC.queue!.conditions.at(-1));
  });

  it("never drops a client-authored sibling wait when a second move replaces its own", async () => {
    const w = await world();
    const source = await w.make("solo");
    const x = await sendTurn(w.store, source.id, {
      prompt: "X work",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    const y = await sendTurn(w.store, source.id, {
      prompt: "Y work",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });

    // A -> B: both move to B's Work queue, waiting on B's generated handoff.
    const ab = await continueThread(w.ctx, { threadId: source.id });
    await settleRuns();
    const xOnB = (await w.store.readTurns(ab.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${x.turn.id}`)!;
    const yOnB = (await w.store.readTurns(ab.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${y.turn.id}`)!;
    expect(xOnB.queue?.conditions).toHaveLength(1);

    // Remove both on B, revert B to zero run turns (its generated handoff is
    // the only turn that ran, so only the two never-ran entries stay), then
    // restore both.
    await editWorkQueue(w.ctx, ab.threadId, xOnB.id, "remove");
    await editWorkQueue(w.ctx, ab.threadId, yOnB.id, "remove");
    await revertThread(w.ctx, ab.threadId, 0);
    await editWorkQueue(w.ctx, ab.threadId, xOnB.id, "restore");
    await editWorkQueue(w.ctx, ab.threadId, yOnB.id, "restore");

    // The client makes X wait for its sibling Y: a same-thread entry
    // condition that reads exactly like the server's own wait on disk.
    await editWorkQueue(w.ctx, ab.threadId, xOnB.id, "edit", parseQueuePolicy({
      conditions: [{ type: "entry", threadId: ab.threadId, turnId: yOnB.id }],
      held: false,
    }));

    // B -> C: the move replaces its own wait, but the client's wait on Y
    // travels along untouched.
    const bc = await continueThread(w.ctx, { threadId: ab.threadId });
    await settleRuns();
    const xOnC = (await w.store.readTurns(bc.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${xOnB.id}`)!;
    const yOnC = (await w.store.readTurns(bc.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${yOnB.id}`)!;
    expect(xOnC).toBeDefined();
    expect(
      xOnC.queue?.conditions.some((condition) => condition.type === "entry" && condition.threadId === ab.threadId && condition.turnId === yOnB.id),
    ).toBe(true);

    // Only X is released: it stays queued, because it waits for Y, which
    // is still held.
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(bc.threadId)).find((turn) => turn.id === xOnC.id)?.status).toBe("queued");
    expect((await w.store.readTurns(bc.threadId)).find((turn) => turn.id === yOnC.id)?.status).toBe("queued");

    // With Y released too, Y runs and X follows it.
    await editWorkQueue(w.ctx, bc.threadId, yOnC.id, "release");
    await runWorkQueue(w.ctx);
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(bc.threadId)).find((turn) => turn.id === yOnC.id)?.status).toBe("completed");
    expect((await w.store.readTurns(bc.threadId)).find((turn) => turn.id === xOnC.id)?.status).toBe("completed");
  });

  it("preserves an older row's same-thread wait it cannot prove is its own", async () => {
    const w = await world();
    const source = await w.make("solo");
    const held = await sendTurn(w.store, source.id, {
      prompt: "Old-row work",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });

    // First move, then strip the ownership mark, as a row written by a
    // build before the mark existed reads.
    const ab = await continueThread(w.ctx, { threadId: source.id });
    await settleRuns();
    const moved = (await w.store.readTurns(ab.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${held.turn.id}`)!;
    await w.store.updateTurn(ab.threadId, moved.id, {
      queue: {
        ...moved.queue!,
        conditions: moved.queue!.conditions.map((condition) =>
          condition.type === "entry" ? { type: "entry", threadId: condition.threadId, turnId: condition.turnId } : condition,
        ),
      },
    });

    // Second move: the unmarked wait cannot be identified as the server's,
    // so it is preserved rather than dropped — the safe direction — beside
    // the new destination's own marked wait.
    const bc = await continueThread(w.ctx, { threadId: ab.threadId });
    const onC = (await w.store.readTurns(bc.threadId)).find((turn) => turn.queue?.requestId === `handoff:transfer:${moved.id}`)!;
    expect(onC.queue?.conditions).toHaveLength(2);
    expect(onC.queue?.conditions.at(0)).toEqual({ type: "entry", threadId: ab.threadId, turnId: (await w.store.readTurns(ab.threadId))[0]!.id });
    const lastOnC = onC.queue?.conditions.at(-1);
    expect(lastOnC?.type === "entry" && lastOnC.serverWait === true).toBe(true);
  });

  it("keeps the landed transfer marker as a durable alias when a retry continue rejoins the destination", async () => {
    const w = await world();
    const source = await w.make("solo");
    const follower = await w.make("follower");
    const held = await sendTurn(w.store, source.id, {
      prompt: "Still to do",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    // Another thread's entry waits on the ORIGINAL source turn id.
    const dependent = await sendTurn(w.store, follower.id, {
      prompt: "Follows the move",
      queue: parseQueuePolicy({ conditions: [{ type: "entry", threadId: source.id, turnId: held.turn.id }] }),
    });
    expect(dependent.turn.status).toBe("queued");

    // A -> B, then B -> C: the held work is pending on C, and the dependent
    // follows the marker chain.
    const ab = await continueThread(w.ctx, { threadId: source.id });
    await settleRuns();
    const bc = await continueThread(w.ctx, { threadId: ab.threadId });
    await settleRuns();
    await runWorkQueue(w.ctx);
    await settleRuns();
    const queuedOnC = (await w.store.readTurns(bc.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"));
    expect(queuedOnC?.status).toBe("queued");
    expect((await w.store.readTurns(follower.id)).find((turn) => turn.id === dependent.turn.id)?.status).toBe("queued");

    // A retry Continue on A rejoins B. The landed marker on A is a durable
    // alias: the moved work on C is still the prerequisite the follower
    // waits on, and A's own handoff still names the move, not the text.
    const rejoined = await continueThread(w.ctx, { threadId: source.id });
    expect(rejoined.threadId).toBe(ab.threadId);
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(follower.id)).find((turn) => turn.id === dependent.turn.id)?.status).toBe("queued");
    const original = (await w.store.readTurns(source.id)).find((turn) => turn.id === held.turn.id)!;
    expect(original.handoff?.landed).toBe(true);
    expect(await buildHandoff(w.store, source.id, {})).not.toContain("Still to do");
  });

  it("hides the server wait from the projected policy and reattaches it on edit, preserving handoff ordering", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    // 16 satisfied client conditions (past `at`): the only block is the
    // internal handoff wait.
    const clients = Array.from({ length: 16 }, (_, index) => ({
      type: "at" as const,
      at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    }));
    await sendTurn(w.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: clients }) });

    // A scheduled continuation: the destination handoff runs at its time,
    // and the moved entry waits on it first.
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const continued = await continueThread(w.ctx, { threadId: source.id, scheduledFor: at });
    const moved = (await w.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
    const handoffId = (await w.store.readTurns(continued.threadId))[0]!.id;
    const wait = { type: "entry", threadId: continued.threadId, turnId: handoffId, serverWait: true as const };
    expect(moved.queue?.conditions).toHaveLength(17);
    expect(moved.queue?.conditions.at(-1)).toEqual(wait);

    // The projected policy hides the server-owned wait: 16 conditions, none
    // naming the handoff turn, so no client can remove it.
    const entry = (await readWorkQueue(w.ctx)).find((item) => item.threadId === continued.threadId && item.turnId === moved.id)!;
    expect(entry.policy.conditions).toHaveLength(16);
    expect(entry.policy.conditions.some((condition) => condition.type === "entry" && condition.threadId === continued.threadId)).toBe(false);

    // An edit echoing the projected policy (the wait omitted) passes the
    // cap, and core reattaches the wait exactly once. The protocol gate
    // itself is pinned from the server side (see transferqueue.test.ts).
    await editWorkQueue(w.ctx, continued.threadId, moved.id, "edit", entry.policy);
    const edited = (await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
    expect(edited.queue?.conditions).toHaveLength(17);
    expect(edited.queue?.conditions.at(-1)).toEqual(wait);
    expect(edited.queue?.conditions.filter((condition) => condition.type === "entry")).toEqual([wait]);

    // An admission attempt before the handoff time starts nothing: the
    // reattached wait still orders the moved entry behind the handoff.
    expect(await runDueScheduledTurn(w.ctx, continued.threadId)).toBe(false);
    await runWorkQueue(w.ctx);
    expect(openTurn(await w.store.readTurns(continued.threadId))).toBeNull();
    expect((await w.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)?.status).toBe("queued");
  });
});
