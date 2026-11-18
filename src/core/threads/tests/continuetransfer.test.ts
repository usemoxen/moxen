import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { openThreadStore } from "../store.js";
import { buildHandoff } from "../handoff.js";
import { createThread, sendTurn, completeTurn, interruptTurn, openTurn } from "../threads.js";
import { queueAdmission, parseQueuePolicy } from "../queue.js";
import { armedScheduleCount, onScheduledTurnDue } from "../schedule.js";
import {
  continueThread,
  continueOwnThread,
  editWorkQueue,
  migrateQueuedMessages,
  queueAgentMessage,
  runDueScheduledTurn,
  runWorkQueue,
  stageQueuedMessages,
  type OperationContext,
} from "../operations.js";
import type { TurnDriver } from "../execute.js";
import { readFile } from "node:fs/promises";

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

describe("a manual continue moves pending messages to the new thread's work queue", () => {
  it("moves ordinary queued messages as entries, in order, leaving no runnable copy on the source", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "First" });
    const secondSent = await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });
    const thirdSent = await sendTurn(w.store, source.id, {
      prompt: "Third on another model",
      delivery: "queue",
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
    expect(second!.queue!.conditions.at(-1)).toEqual({ type: "entry", threadId: destination.id, turnId: handoff!.id });
    expect(second!.queue!.requestId).toBe(`handoff:transfer:${secondSent.turn.id}`);
    expect(third!.queue!.requestId).toBe(`handoff:transfer:${thirdSent.turn.id}`);
    // The handoff names the move but does not assign the moved messages as this turn's work.
    // (The still-running "First" turn keeps today's treatment: it stays on the
    // source, and the document lists it as never sent.)
    const handoffText = destMessages.find((message) => message.id === handoff!.messageId)!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).toContain("1. First");
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
    expect(entry!.queue!.conditions.at(-1)).toEqual({ type: "entry", threadId: continued.threadId, turnId: handoff!.id });

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
    await sendTurn(w.store, source.id, { prompt: "First" });
    const held = await sendTurn(w.store, source.id, {
      prompt: "Held draft",
      queue: { ...parseQueuePolicy({ conditions: [] }), held: true },
    });
    const removed = await sendTurn(w.store, source.id, { prompt: "Dropped draft", queue: parseQueuePolicy({ conditions: [] }) });
    await editWorkQueue(w.ctx, source.id, removed.turn.id, "remove");
    await sendTurn(w.store, source.id, { prompt: "Usage will resume", origin: "usage-continue", delivery: "queue" });
    const agent = await queueAgentMessage(w.ctx, source.id, { message: "Agent follow-up" });
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
    // The removed draft and the usage entry were not moved.
    expect(sourceTurns.find((turn) => turn.id === removed.turn.id)).toMatchObject({ status: "interrupted" });
    expect(sourceTurns.find((turn) => turn.id === removed.turn.id)?.handoff).toBeUndefined();
    const usage = sourceTurns.find((turn) => turn.status === "queued" && (turn.queue === undefined || turn.queue.removed !== true));
    expect(usage).toBeDefined();
    expect((await w.store.readMessages(source.id)).find((message) => message.id === usage!.messageId)?.origin).toBe("usage-continue");
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

    // Once the moved entry settles, the watcher is released without any rewrite.
    await interruptTurn(w.store, continued.threadId, moved.id);
    const refreshed = [
      { thread: (await w.store.readThreadRecord(watcher.id))!, turns: await w.store.readTurns(watcher.id) },
      { thread: (await w.store.readThreadRecord(source.id))!, turns: await w.store.readTurns(source.id) },
      { thread: (await w.store.readThreadRecord(continued.threadId))!, turns: await w.store.readTurns(continued.threadId) },
    ];
    expect(queueAdmission(refreshed[0]!, refreshed[0]!.turns.find((turn) => turn.id === waiting.turn.id)!, refreshed, w.ctx.config, now).blocked).toEqual([]);
  });

  it("rejoins the same destination on retry and after reopening the store, without duplicating entries", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "First" });
    await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });

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
    const running = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });
    const destination = await w.make("dest");
    const handoff = await sendTurn(w.store, destination.id, { prompt: "Handoff" });

    // The claim, exactly as continueThreadInner takes it.
    const claim = await stageQueuedMessages(w.ctx, source.id, destination.id);
    expect(claim.claimed).toEqual([staged.turn.id]);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)).toMatchObject({
      status: "queued",
      queue: { removed: true },
    });

    // A send landing after the claim belongs only to the source: still
    // queued and runnable there, never in the destination snapshot.
    const late = await sendTurn(w.store, source.id, { prompt: "Late", delivery: "queue" });
    expect(late.turn.status).toBe("queued");

    // Admission cannot take the claimed turn, and the handoff projects
    // exactly the claim-time source: the late send appears in neither
    // history nor immediate work.
    await runWorkQueue(w.ctx);
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)?.status).toBe("queued");
    const doc = await buildHandoff(w.store, source.id, { knownTurnIds: claim.known });
    expect(doc).not.toContain("Late");
    expect(doc).not.toContain("Second");

    // The migration moves only the claimed turn; the late send stays queued.
    await migrateQueuedMessages(w.ctx, source.id, destination.id);
    const moved = (await w.store.readTurns(destination.id)).find((turn) => turn.queue?.requestId === `handoff:transfer:${staged.turn.id}`);
    expect(moved?.status).toBe("queued");
    expect(moved?.queue?.conditions.at(-1)).toEqual({ type: "entry", threadId: destination.id, turnId: handoff.turn.id });
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === staged.turn.id)).toMatchObject({ status: "interrupted" });
    expect((await w.store.readTurns(source.id)).find((turn) => turn.id === late.turn.id)?.status).toBe("queued");

    // The late send still runs on the source once it is free: settling the
    // running turn promotes it past the staged row, which admission skips.
    await completeTurn(w.store, source.id, running.id, { text: "Done." });
    expect(openTurn(await w.store.readTurns(source.id))?.id).toBe(late.turn.id);
  });

  it("keeps a post-claim send off the destination through the real continue path", async () => {
    const w = await world();
    const source = await w.make("solo");
    const running = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });

    // Deterministic barrier: stage emits queue-changed on the source when it
    // claims, so the late send injected on the next source turn-ledger read
    // lands strictly between the claim and the handoff projection (the
    // claim's own re-reads happen before the emit). Later reads pass through.
    const readTurns = w.store.readTurns.bind(w.store);
    const emit = w.store.emit.bind(w.store);
    let armed = false;
    let injected = false;
    const emitSpy = vi.spyOn(w.store, "emit").mockImplementation((threadId: string, reason: string) => {
      if (threadId === source.id && reason === "queue-changed") armed = true;
      return emit(threadId, reason);
    });
    const spy = vi.spyOn(w.store, "readTurns").mockImplementation(async (threadId: string) => {
      if (threadId === source.id && armed) {
        armed = false;
        await sendTurn(w.store, source.id, { prompt: "Late", delivery: "queue" });
        injected = true;
      }
      return readTurns(threadId);
    });
    let continued;
    try {
      continued = await continueThread(w.ctx, { threadId: source.id });
    } finally {
      spy.mockRestore();
      emitSpy.mockRestore();
    }
    expect(injected).toBe(true);

    // The pre-claim message moved; the late prompt is nowhere on the
    // destination — neither the handoff nor any other turn — while the moved
    // message stays out of the handoff's immediate work.
    const destTurns = await w.store.readTurns(continued.threadId);
    expect(destTurns).toHaveLength(2);
    const destMessages = await w.store.readMessages(continued.threadId);
    expect(destMessages.map((message) => message.text).join("\n")).not.toContain("Late");
    const handoffText = destMessages.find((message) => message.role === "user")!.text;
    expect(handoffText).toContain("moved to the new thread's Work queue");
    expect(handoffText).not.toContain("Second");

    // The late send stays queued and runnable only on the source.
    const late = (await w.store.readTurns(source.id)).find((turn) => turn.status === "queued")!;
    expect((await w.store.readMessages(source.id)).find((message) => message.id === late.messageId)?.text).toBe("Late");
    expect(destTurns.some((turn) => turn.messageId === late.messageId)).toBe(false);
    await completeTurn(w.store, source.id, running.id, { text: "Done." });
    expect(openTurn(await w.store.readTurns(source.id))?.id).toBe(late.id);
  });

  it("repairs a crash between destination turn and message writes, without dispatching or duplicating", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "First" });
    await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });

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
    expect(await runDueScheduledTurn(w.ctx, destId)).toBe(true);
    await settleRuns();
    expect((await w.store.readTurns(destId)).find((turn) => turn.id === partial.id)?.status).toBe("queued");
    expect(w.sent.filter((turn) => turn.threadId === destId)).toHaveLength(1);
    expect((await w.store.readActivities(destId)).some((activity) => activity.summary === "Its queued message is missing.")).toBe(false);

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
  });

  it("arms moved schedules where the scheduler owns the process", async () => {
    const w = await world();
    const source = await w.make("solo");
    const done = (await sendTurn(w.store, source.id, { prompt: "First" })).turn;
    await completeTurn(w.store, source.id, done.id, { text: "Done." });
    await sendTurn(w.store, source.id, { prompt: "Later", scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    const before = armedScheduleCount();
    const fired: string[] = [];
    onScheduledTurnDue((threadId) => void fired.push(threadId));

    const continued = await continueThread(w.ctx, { threadId: source.id });

    // The moved schedule is armed on the destination; nothing fires in this test.
    expect(armedScheduleCount() - before).toBe(1);
    expect(fired).toEqual([]);
    expect((await w.store.readTurns(continued.threadId)).find((turn) => typeof turn.scheduledFor === "string")?.status).toBe("queued");
  });

  it("takes back a staged turn the user removed, and its partial destination entry", async () => {
    const w = await world();
    const source = await w.make("solo");
    await sendTurn(w.store, source.id, { prompt: "First" });
    const staged = await sendTurn(w.store, source.id, { prompt: "Second", delivery: "queue" });
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
});
