import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../errors.js";
import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { UsageProtection } from "../../usage/protection.js";
import { createThread, sendTurn, completeTurn, promoteDueScheduledTurn, snoozeThread, unsnoozeThread } from "../threads.js";
import type { TurnDriver } from "../execute.js";
import { settleRuns } from "../../testing/turns.js";
import { automaticUsageBlock, parseQueuePolicy, type QueuePolicy } from "../queue.js";
import { editWorkQueue, readWorkQueue, recoverOrphanedTurn, runDueScheduledTurn, runWorkQueue, pendingHandoff, startTurn, submitHandoff, scheduleUsageContinue, type OperationContext } from "../operations.js";
import { USAGE_CONTINUE_PROMPT } from "../views.js";

afterEach(resetUsageLimitsForTests);

async function world() {
  const sent: { threadId: string; prompt: string }[] = [];
  const w = await testHarness({ onSendTurn: (turn) => sent.push(turn) });
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = { store: w.store, storeRoot: w.root, config: w.config, driverFor: (instance) => {
    const kind = driverKindOfInstance(instance)!;
    let driver = drivers.get(kind);
    if (!driver) { driver = (kind === "harness" ? w.drivers.codex! : w.drivers[kind]!)(); drivers.set(kind, driver); }
    return driver;
  } };
  const make = (provider = "codex") => createThread(w.store, { projectId: "p", title: `Work on ${provider}`, env: { mode: "local", path: w.work, branch: null }, modelSelection: { instanceId: provider, model: "test-model" } });
  return { ...w, ctx, sent, make };
}

describe("conditional work queue", () => {
  it.each(["thread", "entry"] as const)("does not report an existing idle %s dependency as unavailable in a candidate snapshot", async (type) => {
    const w = await world();
    const dependency = await w.make();
    const finished = await sendTurn(w.store, dependency.id, { prompt: "prerequisite" });
    await completeTurn(w.store, dependency.id, finished.turn.id, { text: "done" });
    const thread = await w.make();
    const queued = await sendTurn(w.store, thread.id, {
      prompt: "dependent work",
      queue: parseQueuePolicy({ conditions: [{ type, threadId: dependency.id, turnId: finished.turn.id }] }),
    });
    const rows = [{ thread, turns: await w.store.readTurns(thread.id) }];
    const entries = await readWorkQueue(w.ctx, rows);
    expect(entries.find((entry) => entry.turnId === queued.turn.id)?.blocked).toEqual([]);
    await runWorkQueue(w.ctx, Date.now(), rows);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([thread.id]);
  });

  it("starts a due scheduled turn from a candidate snapshot without rereading idle history", async () => {
    const w = await world();
    const idle: string[] = [];
    for (let index = 0; index < 20; index++) {
      const thread = await w.make();
      const finished = await sendTurn(w.store, thread.id, { prompt: `idle ${index}` });
      await completeTurn(w.store, thread.id, finished.turn.id, { text: "done" });
      idle.push(thread.id);
    }
    const due = await w.make();
    await sendTurn(w.store, due.id, { prompt: "due work", queue: parseQueuePolicy({ conditions: [] }) });
    const rows = [{ thread: due, turns: await w.store.readTurns(due.id) }];
    const turns = vi.spyOn(w.store, "readTurns");
    const lists = vi.spyOn(w.store, "listThreadIds");
    expect(await runDueScheduledTurn(w.ctx, due.id, Date.now(), rows)).toBe(true);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([due.id]);
    expect(lists).not.toHaveBeenCalled();
    expect(turns.mock.calls.every(([id]) => id === due.id)).toBe(true);
  });

  it("admits a due scheduled turn missing from the candidate snapshot, without a full rescan", async () => {
    const w = await world();
    const idle = await w.make();
    const finished = await sendTurn(w.store, idle.id, { prompt: "idle work" });
    await completeTurn(w.store, idle.id, finished.turn.id, { text: "done" });
    const due = await w.make();
    // Due shortly in real time: promoteDueScheduledTurn reads the real clock,
    // so a far-future time with a simulated now would still count as held,
    // while a past time would run at send instead of queueing.
    const at = Date.now() + 1500;
    await sendTurn(w.store, due.id, { prompt: "scheduled work", scheduledFor: new Date(at).toISOString() });
    // The usage tick's candidate set never saw the due thread: only the idle one.
    const rows = [{ thread: idle, turns: await w.store.readTurns(idle.id) }];
    await vi.waitFor(() => expect(Date.now() >= at).toBe(true), { timeout: 10_000, interval: 10 });
    const lists = vi.spyOn(w.store, "listThreadIds");
    expect(await runDueScheduledTurn(w.ctx, due.id, Date.now(), rows)).toBe(true);
    await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([due.id]);
    expect(lists).not.toHaveBeenCalled();
  });

  it("takes back a stale automatic continue in admission instead of running it", async () => {
    const w = await world(); const thread = await w.make();
    await w.store.withThreadLock(thread.id, async () => {
      const current = (await w.store.readThreadRecord(thread.id))!;
      await w.store.writeThreadRecord({ ...current, usagePause: { provider: "codex", windows: [], resetsAt: null, order: 1, phase: "waiting", handoff: false }, updatedAt: w.store.nowIso() });
    });
    const at = Date.now() + 1200;
    const continued = await sendTurn(w.store, thread.id, { prompt: "continue after the reset", scheduledFor: new Date(at).toISOString(), scheduleReason: "usage-reset" });
    // Past the reset the thread resumes under its hold: a usage-control turn
    // runs and finishes, but settling under the hold promotes nothing.
    await vi.waitFor(() => expect(Date.now() >= at).toBe(true), { timeout: 10_000, interval: 10 });
    const resumed = await sendTurn(w.store, thread.id, { prompt: "wrap-up notes", usageControl: true });
    expect(resumed.turn.status).toBe("running");
    await completeTurn(w.store, thread.id, resumed.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === continued.turn.id)?.status).toBe("queued");
    // The hold lifts with the reset: admission takes the nudge back rather
    // than spending a turn on work that already resumed.
    await w.store.withThreadLock(thread.id, async () => {
      const current = (await w.store.readThreadRecord(thread.id))!;
      await w.store.writeThreadRecord({ ...current, usagePause: null, updatedAt: w.store.nowIso() });
    });
    expect(await runDueScheduledTurn(w.ctx, thread.id, Date.now())).toBe(false);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === continued.turn.id)).toMatchObject({ status: "interrupted" });
    expect((await w.store.readActivities(thread.id)).some((row) => row.kind === "turn.interrupted" && row.turnId === continued.turn.id && (row.payload as { beforeStart?: boolean } | undefined)?.beforeStart === true)).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it("does not promote or batch conditional work when an ordinary turn settles", async () => {
    const w = await world(); const thread = await w.make();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const held = await sendTurn(w.store, thread.id, { prompt: "keep this", queue: parseQueuePolicy({ conditions: [], held: true }) });
    const ordinary = await sendTurn(w.store, thread.id, { prompt: "ordinary", delivery: "queue" });
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === held.turn.id)?.status).toBe("queued");
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === ordinary.turn.id)?.status).toBe("running");
    expect((await w.store.readMessages(thread.id)).find((m) => m.id === held.messageId)?.turnId).toBe(held.turn.id);
  });

  it("re-asks user content folded into an unanswered continue, without the nudge", async () => {
    const w = await world(); const thread = await w.make();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    // The real automatic shape, due almost at once.
    const continued = (await scheduleUsageContinue(w.ctx, thread.id, running.turn.id, new Date(Date.now() - 59_000).toISOString()))!;
    const folded = await sendTurn(w.store, thread.id, { prompt: "folded user content", delivery: "queue" });
    await vi.waitFor(() => expect(Date.now() >= Date.parse(continued.scheduledFor!)).toBe(true), { timeout: 120_000, interval: 25 });
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    // The continue ran with the folded message in one turn...
    const turns = await w.store.readTurns(thread.id);
    expect(turns.find((turn) => turn.id === continued.id)?.status).toBe("running");
    expect(turns.some((turn) => turn.id === folded.turn.id)).toBe(false);
    // ...then ended with no provider output on a fresh conversation.
    await w.store.updateTurn(thread.id, continued.id, { status: "completed", completedAt: w.store.nowIso(), unanswered: true });
    await startTurn(w.ctx, { threadId: thread.id, prompt: "next question" });
    await settleRuns();
    const prompt = w.sent.at(-1)!.prompt;
    expect(prompt).toContain("folded user content");
    expect(prompt).toContain("next question");
    expect(prompt).not.toContain(USAGE_CONTINUE_PROMPT);
  });

  it("latches cross-provider events durably while other conditions are still blocked", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const queued = await sendTurn(w.store, thread.id, { prompt: "after Claude stops", queue: parseQueuePolicy({ conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }, { type: "at", at: new Date(now + 60_000).toISOString() }] }) });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.queue?.latched).toEqual([0]);
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(now + 7200_000).toISOString() }]);
    await runWorkQueue({ ...w.ctx }, now + 61_000);
    await settleRuns();
    expect(w.sent.map((t) => t.threadId)).toEqual([thread.id]);
  });

  it("blocks a provider lane without blocking another provider, and respects removal/restoration", async () => {
    const w = await world(); const first = await w.make(); const second = await w.make(); const other = await w.make("claudeAgent");
    const policy = parseQueuePolicy({ conditions: [], order: 1 });
    const running = await sendTurn(w.store, first.id, { prompt: "first", queue: policy });
    await promoteDueScheduledTurn(w.store, first.id, running.turn.id);
    const queued = await sendTurn(w.store, second.id, { prompt: "preserve this draft", queue: { ...policy, order: 2 } });
    await sendTurn(w.store, other.id, { prompt: "other provider", queue: { ...policy, order: 3 } });
    await runWorkQueue(w.ctx); await settleRuns();
    expect(w.sent.map((t) => t.threadId)).toEqual([other.id]);
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "remove");
    expect((await readWorkQueue(w.ctx)).find((e) => e.turnId === queued.turn.id)?.policy.removed).toBe(true);
    expect((await w.store.readMessages(second.id)).find((m) => m.id === queued.messageId)?.text).toBe("preserve this draft");
    await completeTurn(w.store, first.id, running.turn.id, { text: "done" });
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "restore");
    await runWorkQueue(w.ctx);
    expect(w.sent).toHaveLength(1);
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "release");
    await runWorkQueue(w.ctx); await settleRuns();
    expect(w.sent.at(-1)?.threadId).toBe(second.id);
  });

  it("waits for an observed reset rather than guessing its wall-clock time", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    await sendTurn(w.store, thread.id, { prompt: "when usage returns", queue: parseQueuePolicy({ conditions: [{ type: "reset", provider: "codex", window: "session" }] }) });
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 95, exhausted: false, resetsAt: new Date(now + 60_000).toISOString() }]);
    await runWorkQueue(w.ctx, now);
    expect((await readWorkQueue(w.ctx))[0]?.policy.conditions[0]).toMatchObject({ resetsAt: new Date(now + 60_000).toISOString() });
    await runWorkQueue(w.ctx, now + 66_000); await settleRuns();
    expect(w.sent).toHaveLength(1);
  });

  it("waits for every reported window when the condition asks for all", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    await sendTurn(w.store, thread.id, { prompt: "when every allowance returns", queue: parseQueuePolicy({ conditions: [{ type: "reset", provider: "codex", window: "all" }] }) });
    const soon = new Date(now + 60_000).toISOString();
    const later = new Date(now + 6 * 86400_000).toISOString();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 95, exhausted: false, resetsAt: soon },
      { id: "weekly", label: "Weekly", usedPercent: 95, exhausted: false, resetsAt: later },
    ]);
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    // "all" covers every reported window: the session reset alone is not enough.
    expect((await readWorkQueue(w.ctx))[0]?.policy.conditions[0]).toMatchObject({ resetsAt: later });
    await runWorkQueue(w.ctx, now + 66_000);
    expect(w.sent).toEqual([]);
    await runWorkQueue(w.ctx, Date.parse(later) + 6000); await settleRuns();
    expect(w.sent).toHaveLength(1);
  });

  it("does not lose an exhaustion event that resets before the next scheduler tick", async () => {
    const w = await world(); const thread = await w.make();
    await sendTurn(w.store, thread.id, { prompt: "after the event", queue: parseQueuePolicy({ conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }] }) });
    // Read after queueing: on a loaded runner the entry can postdate an earlier clock reading, and its event must not.
    const now = Date.now() + 1000;
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: null }], now + 1);
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: null }], now + 2);
    await runWorkQueue(w.ctx, now + 3); await settleRuns();
    expect(w.sent).toHaveLength(1);
  });

  it("reorders entries with equal timestamps and waits for explicit completion dependencies", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const thread = await w.make();
      await sendTurn(w.store, thread.id, { prompt: `queued ${i}`, queue: parseQueuePolicy({ conditions: [], held: true, order: 1 }) });
    }
    const before = await readWorkQueue(w.ctx);
    await editWorkQueue(w.ctx, before[1]!.threadId, before[1]!.turnId, "up");
    expect((await readWorkQueue(w.ctx)).map((entry) => entry.turnId)).toEqual([before[1]!.turnId, before[0]!.turnId, before[2]!.turnId]);
    const dependency = await w.make("claudeAgent");
    const busy = await sendTurn(w.store, dependency.id, { prompt: "finish first" });
    const selected = (await readWorkQueue(w.ctx))[0]!;
    await editWorkQueue(w.ctx, selected.threadId, selected.turnId, "edit", { ...selected.policy, held: false, conditions: [{ type: "thread", threadId: dependency.id }, { type: "entry", threadId: dependency.id, turnId: busy.turn.id }] });
    await runWorkQueue(w.ctx); expect(w.sent).toEqual([]);
    await completeTurn(w.store, dependency.id, busy.turn.id, { text: "done" });
    await runWorkQueue(w.ctx); await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([selected.threadId]);
  });

  it("keeps automatic continuation held by a low weekly allowance, even after a session reset", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const queue: QueuePolicy = { ...parseQueuePolicy({ conditions: [] }), automatic: true };
    await sendTurn(w.store, thread.id, { prompt: "automatic", queue });
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(now - 1000).toISOString() },
      { id: "weekly", label: "Weekly", usedPercent: 97, exhausted: false, resetsAt: new Date(now + 86400_000).toISOString() },
    ]);
    await runWorkQueue(w.ctx); expect(w.sent).toEqual([]);
    w.ctx.config.usageMinimumWeekly = 0;
    await runWorkQueue(w.ctx); await settleRuns(); expect(w.sent).toHaveLength(1);
    recordUsageWindows("codex", [{ id: "weekly", label: "Weekly", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 86400_000).toISOString() }]);
    expect(automaticUsageBlock("codex", w.ctx.config)).not.toEqual([]);
    expect(automaticUsageBlock("opencode", w.ctx.config)).toEqual([]);
  });
});

describe("cross-provider settle promotion", () => {
  it("does not strand a queued turn for another provider as running when its settle promotes it", async () => {
    const w = await world();
    // Whose driver runs what: the drivers are one instance per provider, so a
    // prompt reaching the wrong driver (or twice) shows up here.
    const ran: { kind: string; prompt: string }[] = [];
    for (const [instance, kind] of [["codex", "codex"], ["claude", "claude"]] as const) {
      const driver = w.ctx.driverFor(instance);
      const send = driver.sendTurn.bind(driver);
      driver.sendTurn = (input) => { ran.push({ kind, prompt: input.prompt }); return send(input); };
    }
    // The first turn must still be running while the other two queue behind
    // it; gate its completion rather than racing the background run.
    const codexDriver = w.ctx.driverFor("codex");
    const codexAwait = codexDriver.awaitTurn.bind(codexDriver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codexDriver.awaitTurn = async (threadId, turnId, signal) => { await gate; return codexAwait(threadId, turnId, signal); };
    const thread = await w.make("codex");
    await startTurn(w.ctx, { threadId: thread.id, prompt: "first" });
    await startTurn(w.ctx, { threadId: thread.id, prompt: "second on codex", delivery: "queue", modelSelection: { instanceId: "codex", model: "test-model" } });
    await startTurn(w.ctx, { threadId: thread.id, prompt: "third on claude", delivery: "queue", modelSelection: { instanceId: "claude", model: "test-model" } });
    release();
    await settleRuns();
    // The settling codex runner cannot take the claude turn: it goes back to
    // the queue for the admission path instead of sitting `running` forever.
    const held = (await w.store.readTurns(thread.id)).find((turn) => turn.modelSelection?.instanceId === "claude")!;
    expect(held.status).toBe("queued");
    expect(held.heldAtSettle).toBe(true);
    // The admission tick starts it on its own driver, once, with no new message.
    expect(await runDueScheduledTurn(w.ctx, thread.id)).toBe(true);
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).map((turn) => turn.status)).toEqual(["completed", "completed", "completed"]);
    expect(ran.map((run) => run.kind)).toEqual(["codex", "codex", "claude"]);
    for (const [index, text] of ["first", "second on codex", "third on claude"].entries()) {
      expect(ran[index]!.prompt).toContain(text);
    }
  });
});

describe("explicit handoff submissions", () => {
  it("does not turn an optional summary turn into a second automatic task recovery", async () => {
    const w = await world(); const source = await w.make();
    const summary = await sendTurn(w.store, source.id, { prompt: "write summary" });
    const entry = await sendTurn(w.store, source.id, { prompt: "continue elsewhere", queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
    await w.store.updateTurn(source.id, summary.turn.id, { queue: { ...parseQueuePolicy({ conditions: [] }), summaryFor: entry.turn.id } });
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: new Date(Date.now() + 3600_000).toISOString() }]);
    const guard = new UsageProtection(async () => w.ctx);
    await guard.wrap("codex");
    expect((await w.store.readThreadRecord(source.id))?.usagePause).toBeUndefined();
    expect((await w.store.readTurns(source.id)).filter((turn) => turn.status === "queued").map((turn) => turn.id)).toEqual([entry.turn.id]);
  });

  it("does not overwrite a submission accepted while summary generation is being stopped", async () => {
    const w = await world(); const source = await w.make();
    const summary = await sendTurn(w.store, source.id, { prompt: "summary generation" });
    const entry = await sendTurn(w.store, source.id, { prompt: "unfinished request", queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
    await w.store.updateTurn(source.id, summary.turn.id, { queue: { ...parseQueuePolicy({ conditions: [] }), summaryFor: entry.turn.id } });
    await w.store.updateTurn(source.id, entry.turn.id, { handoff: { requestId: "race", destinationThreadId: w.store.newId(), summaryTurnId: summary.turn.id } });
    w.ctx.driverFor("codex").interruptTurn = () => Effect.tryPromise({ try: () => submitHandoff(w.ctx, source.id, "race", "Accepted before stopping"), catch: (cause) => new CliError("TEST_INTERRUPT", String(cause)) });
    await runWorkQueue(w.ctx, Date.now() + 121_000);
    const handoff = (await w.store.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)!.handoff!;
    expect(handoff.summary).toBe("Accepted before stopping");
    expect(handoff.fallback).toBe(false);
    expect((await w.store.readMessages(handoff.destinationThreadId)).find((message) => message.role === "user")?.text).toContain("Accepted before stopping");
  });

  it.each(["claudeAgent", "codex", "opencode", "harness/test"])("%s uses an accepted tool payload even when the summary turn fails afterwards", async (provider) => {
    const w = await world(); const source = await w.make(provider);
    const initial = await sendTurn(w.store, source.id, { prompt: "Original task" });
    await completeTurn(w.store, source.id, initial.turn.id, { text: "Some work is done" });
    const entry = await sendTurn(w.store, source.id, { prompt: "Finish the remaining work", queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
    const driver = w.ctx.driverFor(provider);
    const send = driver.sendTurn.bind(driver);
    driver.sendTurn = (input) => Effect.flatMap(send(input), (result) => Effect.tryPromise({
      try: async () => {
        if (input.threadId === source.id) {
          const requestId = await pendingHandoff(w.ctx, source.id);
          expect(requestId).not.toBeNull();
          await submitHandoff(w.ctx, source.id, requestId!, "Accepted summary: tests remain.");
          await submitHandoff(w.ctx, source.id, requestId!, "Accepted summary: tests remain.");
          await expect(submitHandoff(w.ctx, source.id, "wrong-request", "wrong")).rejects.toThrow();
        }
        return result;
      }, catch: (cause) => new CliError("TEST_SEND", String(cause)),
    }));
    const awaitTurn = driver.awaitTurn.bind(driver);
    driver.awaitTurn = async (threadId, turnId, signal) => threadId === source.id ? { status: "failed", text: "Ignore this final prose", usage: null, error: "quota exhausted" } : awaitTurn(threadId, turnId, signal);
    await runWorkQueue(w.ctx); await settleRuns();
    await runWorkQueue(w.ctx); await runWorkQueue(w.ctx); await settleRuns();
    const original = (await w.store.readTurns(source.id)).find((t) => t.id === entry.turn.id)!;
    const destinationId = original.handoff!.destinationThreadId;
    const prompt = (await w.store.readMessages(destinationId)).find((m) => m.role === "user")!.text;
    expect(prompt).toContain("Accepted summary: tests remain.");
    expect(prompt).not.toContain("Ignore this final prose");
    expect(w.sent.filter((t) => t.threadId === destinationId)).toHaveLength(1);
    expect(await pendingHandoff(w.ctx, source.id)).toBeNull();
  });

  it("falls back to the stored handoff when the model returns prose instead of submitting", async () => {
    const w = await world(); const source = await w.make();
    const entry = await sendTurn(w.store, source.id, { prompt: "Unsent request must survive", queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
    await runWorkQueue(w.ctx); await settleRuns();
    await runWorkQueue(w.ctx);
    const original = (await w.store.readTurns(source.id)).find((t) => t.id === entry.turn.id)!;
    expect(original.handoff?.fallback).toBe(true);
    const prompt = (await w.store.readMessages(original.handoff!.destinationThreadId)).find((m) => m.role === "user")!.text;
    expect(prompt).toContain("Unsent request must survive");
    expect(prompt).not.toContain("## Model's wrap-up");
    await expect(submitHandoff(w.ctx, source.id, original.handoff!.requestId, "late")).rejects.toThrow("not active");
  });

  it("does not spend a model call against a known limit and preserves the queued destination's provider", async () => {
    const w = await world(); const source = await w.make();
    const entry = await sendTurn(w.store, source.id, { prompt: "Continue on Claude", modelSelection: { instanceId: "claudeAgent", model: "claude-test" }, queue: parseQueuePolicy({ conditions: [], continuation: "model" }) });
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3600_000).toISOString() }]);
    await runWorkQueue(w.ctx);
    const handoff = (await w.store.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)!.handoff!;
    expect(handoff.fallback).toBe(true);
    expect(handoff.summaryTurnId).toBeUndefined();
    expect(w.sent).toEqual([]);
    expect((await w.store.readThreadRecord(handoff.destinationThreadId))?.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-test" });
    await runWorkQueue(w.ctx); await settleRuns();
    expect(w.sent.map((turn) => turn.threadId)).toEqual([handoff.destinationThreadId]);
  });

  it("does not release a dependent entry just because its prerequisite was handed off", async () => {
    const w = await world(); const source = await w.make(); const dependent = await w.make("claudeAgent"); const now = Date.now();
    let releaseCompletion!: () => void;
    let completionStarted!: () => void;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const pendingCompletion = new Promise<void>((resolve) => { completionStarted = resolve; });
    const updateTurn = w.store.updateTurn.bind(w.store);
    vi.spyOn(w.store, "updateTurn").mockImplementation(async (threadId, turnId, patch) => {
      if (threadId !== source.id && threadId !== dependent.id && patch.status === "completed") {
        // Hold the completion write across a scheduler tick, as a slow filesystem can.
        completionStarted();
        await completionGate;
      }
      return updateTurn(threadId, turnId, patch);
    });
    const entry = await sendTurn(w.store, source.id, { prompt: "prerequisite", queue: parseQueuePolicy({ conditions: [{ type: "at", at: new Date(now + 60_000).toISOString() }], continuation: "stored", order: 1 }) });
    await sendTurn(w.store, dependent.id, { prompt: "after the real work", queue: parseQueuePolicy({ conditions: [{ type: "entry", threadId: source.id, turnId: entry.turn.id }], order: 2 }) });
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    const destinationId = (await w.store.readTurns(source.id)).find((turn) => turn.id === entry.turn.id)!.handoff!.destinationThreadId;
    try {
      await runWorkQueue(w.ctx, now + 61_000);
      await pendingCompletion;
      expect(w.sent.map((turn) => turn.threadId)).toEqual([destinationId]);
      await runWorkQueue(w.ctx, now + 62_000);
      expect((await readWorkQueue(w.ctx)).find((entry) => entry.threadId === dependent.id)?.blocked).toContain(`Waiting for ${source.title}`);
      expect(w.sent.map((turn) => turn.threadId)).toEqual([destinationId]);
    } finally {
      releaseCompletion();
    }
    // A bounded runner flush can return before persistence finishes; wait for the dependency itself.
    await vi.waitFor(async () => {
      expect((await w.store.readTurns(destinationId))[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    await runWorkQueue(w.ctx, now + 62_000); await settleRuns();
    expect(w.sent.at(-1)?.threadId).toBe(dependent.id);
  });
});

/**
 * An entry or thread condition can name a thread whose owner died mid-turn
 * (a crashed server, a killed CLI): nothing there will ever settle it, so
 * admitting only the waiter's own thread would hold the waiter forever.
 * The admission path recovers the threads its queued entries depend on too.
 */
describe("admission recovers depended-on threads", () => {
  /** A pid that has already exited, on this machine: a dead owner, same host. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));
    return child.pid!;
  }

  it("orphans the dependency's running turn and admits the waiter", async () => {
    const w = await world();
    const dependency = await w.make();
    const running = await sendTurn(w.store, dependency.id, { prompt: "dependency work" });
    await w.store.updateTurn(dependency.id, running.turn.id, { owner: { pid: await deadPid(), host: os.hostname() } });
    const waiter = await w.make();
    await sendTurn(w.store, waiter.id, {
      prompt: "after the dependency",
      queue: parseQueuePolicy({ conditions: [{ type: "entry", threadId: dependency.id, turnId: running.turn.id }] }),
    });
    await runWorkQueue(w.ctx);
    expect((await w.store.readTurns(waiter.id)).map((turn) => turn.status)).toEqual(["running"]);
    await settleRuns();
    expect((await w.store.readTurns(dependency.id)).map((turn) => turn.status)).toEqual(["interrupted"]);
    expect((await w.store.readTurns(waiter.id)).map((turn) => turn.status)).toEqual(["completed"]);
    expect(w.sent.map((turn) => turn.threadId)).toEqual([waiter.id]);
  });

  it("does the same for a thread condition when the dependency goes quiet", async () => {
    const w = await world();
    const dependency = await w.make();
    const running = await sendTurn(w.store, dependency.id, { prompt: "dependency work" });
    await w.store.updateTurn(dependency.id, running.turn.id, { owner: { pid: await deadPid(), host: os.hostname() } });
    const waiter = await w.make();
    await sendTurn(w.store, waiter.id, {
      prompt: "after the quiet thread",
      queue: parseQueuePolicy({ conditions: [{ type: "thread", threadId: dependency.id }] }),
    });
    await runWorkQueue(w.ctx);
    await settleRuns();
    expect((await w.store.readTurns(dependency.id)).map((turn) => turn.status)).toEqual(["interrupted"]);
    expect((await w.store.readTurns(waiter.id))).toEqual([expect.objectContaining({ status: "completed" })]);
  });
});

/**
 * A recovery whose session fails to start must not strand the turn behind
 * it: orphan recovery promotes B and fails it, and that failure promotes C
 * to `running` with no runner and no tracking — the next send then sees a
 * busy thread no orphan recovery will ever reap (its owner is alive).
 */
describe("setup failures behind a recovery", () => {
  it("holds the turn behind a recovery whose session fails to start instead of stranding it running", async () => {
    const w = await world();
    const thread = await w.make();
    const a = await sendTurn(w.store, thread.id, { prompt: "first" });
    const b = await sendTurn(w.store, thread.id, { prompt: "second on claude", delivery: "queue", modelSelection: { instanceId: "claude", model: "test-model" } });
    const c = await sendTurn(w.store, thread.id, { prompt: "third", delivery: "queue" });
    // A's runner is gone, and B's provider cannot start a session.
    await w.store.updateTurn(thread.id, a.turn.id, { owner: { pid: 2_147_483_647, host: os.hostname() } });
    const driverFor = w.ctx.driverFor;
    const spy = vi.spyOn(w.ctx, "driverFor").mockImplementation((id) => {
      if (driverKindOfInstance(id) === "claude") throw new CliError("PROVIDER_UNKNOWN", "No direct driver.");
      return driverFor(id);
    });
    try {
      await recoverOrphanedTurn(w.ctx, thread.id);
    } finally {
      spy.mockRestore();
    }
    const turns = await w.store.readTurns(thread.id);
    const statusOf = (id: string) => turns.find((turn) => turn.id === id)?.status;
    expect({ a: statusOf(a.turn.id), b: statusOf(b.turn.id), c: statusOf(c.turn.id) }).toEqual({ a: "interrupted", b: "failed", c: "queued" });
    expect(turns.find((turn) => turn.id === c.turn.id)?.heldAtSettle).toBe(true);
    expect(w.store.isTracked(b.turn.id)).toBe(false);
    expect(w.store.isTracked(c.turn.id)).toBe(false);
  });

  it("frees a recovery whose ledger read fails before its runner starts", async () => {
    const w = await world();
    const thread = await w.make();
    const a = await sendTurn(w.store, thread.id, { prompt: "first" });
    const b = await sendTurn(w.store, thread.id, { prompt: "second", delivery: "queue" });
    // A's runner is gone, and the recovery's ledger read fails: B is never
    // settled, so its admission claim must be released rather than leak —
    // or later interrupts would promote behind it and orphan recovery would
    // skip it as tracked.
    await w.store.updateTurn(thread.id, a.turn.id, { owner: { pid: 2_147_483_647, host: os.hostname() } });
    const spy = vi.spyOn(w.store, "readMessages").mockRejectedValueOnce(new Error("ledger unavailable"));
    try {
      await recoverOrphanedTurn(w.ctx, thread.id);
    } finally {
      spy.mockRestore();
    }
    expect(w.store.isTracked(b.turn.id)).toBe(false);
    expect((await w.store.readTurns(thread.id)).find((turn) => turn.id === b.turn.id)?.status).toBe("running");
  });
});

/**
 * A plain queued turn held at settle — by snooze (MXN-278) or by an
 * exhausted provider (MXN-276) — sits on an idle thread with no runner.
 * The admission path must start it once nothing blocks it, with no further
 * user message: it takes plain turns the thread is free for, through the
 * same `queueAdmission` every other entry goes through.
 */
describe("admission of held plain queued turns", () => {
  it("starts a snooze-held plain turn once the snooze is cleared, with no further message", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued while snoozed", delivery: "queue" });
    await snoozeThread(w.store, thread.id, new Date(now + 3600_000).toISOString());
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("queued");
    // Idle but still snoozed: the pass admits nothing.
    await runWorkQueue(w.ctx, now); await settleRuns();
    expect(w.sent).toEqual([]);
    // Snooze cleared: the next pass starts it.
    await unsnoozeThread(w.store, thread.id);
    await runWorkQueue(w.ctx, now); await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toContain("queued while snoozed");
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("completed");
  });

  it("starts a snooze-held plain turn once the snooze expires, without an unsnooze", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued past the snooze", delivery: "queue" });
    await snoozeThread(w.store, thread.id, new Date(now + 60_000).toISOString());
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("queued");
    await runWorkQueue(w.ctx, now); await settleRuns();
    expect(w.sent).toEqual([]);
    // Past expiry, never unsnoozed: the pass starts it.
    await runWorkQueue(w.ctx, now + 61_000); await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toContain("queued past the snooze");
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("completed");
  });

  it("starts an exhaustion-held plain turn once the reset passes, with no further message", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued past the limit", delivery: "queue" });
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("queued");
    await runWorkQueue(w.ctx, now); await settleRuns();
    expect(w.sent).toEqual([]);
    // The reset lapsed, so the snapshot no longer reports exhaustion.
    await runWorkQueue(w.ctx, now + 3600_000 + 1000); await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toContain("queued past the limit");
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.status).toBe("completed");
  });

  it("queues a fresh send behind an older held turn and runs the older first", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued past the limit", delivery: "queue" });
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)).toMatchObject({ status: "queued", heldAtSettle: true });
    // The limit lapses, but the fresh send still queues behind the older held
    // turn instead of running ahead of it — and the send says so.
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(now + 7200_000).toISOString() }]);
    const fresh = await startTurn(w.ctx, { threadId: thread.id, prompt: "newer message" });
    expect(fresh.delivery).toBe("queued");
    expect(fresh.turn).toMatchObject({ status: "queued", heldAtSettle: true });
    // The older held turn goes first: the admission run takes it, and the
    // newer message follows in the same run — older text first — rather than
    // jumping ahead of it.
    await settleRuns();
    expect((await w.store.readTurns(thread.id)).map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(w.sent.map((turn) => turn.prompt)).toEqual(["queued past the limit\n\nnewer message"]);
  });

  it("resumes a held turn with current native tools and rule changes", async () => {
    const w = await world(); const thread = await w.make("claudeAgent"); const now = Date.now();
    // Park the first turn's completion so the second queues behind a live run.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    const driver = w.ctx.driverFor("claudeAgent");
    const awaitTurn = driver.awaitTurn.bind(driver);
    driver.awaitTurn = async (...args) => { await gate; return awaitTurn(...args); };
    const first = await startTurn(w.ctx, { threadId: thread.id, prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued past the limit", delivery: "queue" });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    // The session started with no rule files; change them while it sits idle.
    await writeFile(path.join(w.work, "AGENTS.md"), "Never force-push without a confirming flag.\n");
    await completeTurn(w.store, thread.id, first.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)).toMatchObject({ status: "queued", heldAtSettle: true });
    const nativeTools: { threadId: string; names: readonly string[]; moxenPrompt?: boolean | undefined }[] = [];
    driver.updateNativeTools = async (threadId, names, moxenPrompt) => { nativeTools.push({ threadId, names, moxenPrompt }); };
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(now + 7200_000).toISOString() }]);
    await runWorkQueue(w.ctx, now);
    resolveGate();
    await settleRuns();
    // The resume re-registers native tools and carries the rule change ahead
    // of the prompt, like a fresh send does. (The first turn never reached
    // the provider: it was completed while its session was still starting,
    // so the resumed prompt is the only one the driver sees.)
    expect(nativeTools).toHaveLength(1);
    expect(nativeTools[0]?.threadId).toBe(thread.id);
    expect(w.sent.at(-1)?.prompt).toContain("<moxen-context-update>");
    expect(w.sent.at(-1)?.prompt).toContain("force-push");
    expect(w.sent.at(-1)?.prompt).toContain("queued past the limit");
    expect((await w.store.readTurns(thread.id)).map((turn) => turn.status)).toEqual(["completed", "completed"]);
  });

  it("carries rule changes into a turn promoted at settle on a warm session", async () => {
    const w = await world(); const thread = await w.make("claudeAgent");
    await writeFile(path.join(w.work, "AGENTS.md"), "Keep functions small.\n");
    // Park the first turn's completion so the second queues behind a live run.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    const driver = w.ctx.driverFor("claudeAgent");
    const awaitTurn = driver.awaitTurn.bind(driver);
    driver.awaitTurn = async (...args) => { await gate; return awaitTurn(...args); };
    const first = await startTurn(w.ctx, { threadId: thread.id, prompt: "work" });
    await sendTurn(w.store, thread.id, { prompt: "queued behind it", delivery: "queue" });
    // Change the rules after the session read them; the settle-promoted run
    // takes the patch ahead of its prompt.
    await writeFile(path.join(w.work, "AGENTS.md"), "Keep functions small.\nNever force-push without a confirming flag.\n");
    resolveGate();
    await first.run;
    await settleRuns();
    expect(w.sent.map((turn) => turn.prompt)).toHaveLength(2);
    expect(w.sent[1]?.prompt).toContain("<moxen-context-update>");
    expect(w.sent[1]?.prompt).toContain("force-push");
    expect(w.sent[1]?.prompt).toContain("queued behind it");
  });

  it("holds a queued send behind a held turn that cannot run yet, reporting it queued", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const running = await sendTurn(w.store, thread.id, { prompt: "work" });
    const queued = await sendTurn(w.store, thread.id, { prompt: "queued while snoozed", delivery: "queue" });
    await snoozeThread(w.store, thread.id, new Date(now + 3600_000).toISOString());
    await completeTurn(w.store, thread.id, running.turn.id, { text: "done" });
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)).toMatchObject({ status: "queued", heldAtSettle: true });
    // The snooze still holds the older turn, so the new message waits behind
    // it — queued with its place kept, not swallowed and not jumped ahead.
    const fresh = await startTurn(w.ctx, { threadId: thread.id, prompt: "newer message", delivery: "queue" });
    expect(fresh.delivery).toBe("queued");
    expect(fresh.turn).toMatchObject({ status: "queued", heldAtSettle: true });
    await runWorkQueue(w.ctx, now); await settleRuns();
    expect(w.sent).toEqual([]);
    expect((await w.store.readTurns(thread.id)).map((turn) => turn.status)).toEqual(["completed", "queued", "queued"]);
  });
});
