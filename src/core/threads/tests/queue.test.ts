import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { CliError } from "../../errors.js";
import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../../usage/limits.js";
import { UsageProtection } from "../../usage/protection.js";
import { createThread, sendTurn, completeTurn, promoteDueScheduledTurn } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { automaticUsageBlock, parseQueuePolicy, type QueuePolicy } from "../queue.js";
import { editWorkQueue, readWorkQueue, runWorkQueue, pendingHandoff, submitHandoff, type OperationContext } from "../operations.js";

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

  it("latches cross-provider events durably while other conditions are still blocked", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    const queued = await sendTurn(w.store, thread.id, { prompt: "after Claude stops", queue: parseQueuePolicy({ conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }, { type: "at", at: new Date(now + 60_000).toISOString() }] }) });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 3600_000).toISOString() }]);
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    expect((await w.store.readTurns(thread.id)).find((t) => t.id === queued.turn.id)?.queue?.latched).toEqual([0]);
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: new Date(now + 7200_000).toISOString() }]);
    await runWorkQueue({ ...w.ctx }, now + 61_000);
    await flushTurnRunners(1000);
    expect(w.sent.map((t) => t.threadId)).toEqual([thread.id]);
  });

  it("blocks a provider lane without blocking another provider, and respects removal/restoration", async () => {
    const w = await world(); const first = await w.make(); const second = await w.make(); const other = await w.make("claudeAgent");
    const policy = parseQueuePolicy({ conditions: [], order: 1 });
    const running = await sendTurn(w.store, first.id, { prompt: "first", queue: policy });
    await promoteDueScheduledTurn(w.store, first.id, running.turn.id);
    const queued = await sendTurn(w.store, second.id, { prompt: "preserve this draft", queue: { ...policy, order: 2 } });
    await sendTurn(w.store, other.id, { prompt: "other provider", queue: { ...policy, order: 3 } });
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
    expect(w.sent.map((t) => t.threadId)).toEqual([other.id]);
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "remove");
    expect((await readWorkQueue(w.ctx)).find((e) => e.turnId === queued.turn.id)?.policy.removed).toBe(true);
    expect((await w.store.readMessages(second.id)).find((m) => m.id === queued.messageId)?.text).toBe("preserve this draft");
    await completeTurn(w.store, first.id, running.turn.id, { text: "done" });
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "restore");
    await runWorkQueue(w.ctx);
    expect(w.sent).toHaveLength(1);
    await editWorkQueue(w.ctx, second.id, queued.turn.id, "release");
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
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
    await runWorkQueue(w.ctx, now + 66_000); await flushTurnRunners(1000);
    expect(w.sent).toHaveLength(1);
  });

  it("does not lose an exhaustion event that resets before the next scheduler tick", async () => {
    const w = await world(); const thread = await w.make(); const now = Date.now();
    await sendTurn(w.store, thread.id, { prompt: "after the event", queue: parseQueuePolicy({ conditions: [{ type: "provider", provider: "claude", state: "exhausted", mode: "after" }] }) });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: null }], now + 1);
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: null }], now + 2);
    await runWorkQueue(w.ctx, now + 3); await flushTurnRunners(1000);
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
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
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
    await runWorkQueue(w.ctx); await flushTurnRunners(1000); expect(w.sent).toHaveLength(1);
    recordUsageWindows("codex", [{ id: "weekly", label: "Weekly", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 86400_000).toISOString() }]);
    expect(automaticUsageBlock("codex", w.ctx.config)).not.toEqual([]);
    expect(automaticUsageBlock("opencode", w.ctx.config)).toEqual([]);
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
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
    await runWorkQueue(w.ctx); await runWorkQueue(w.ctx); await flushTurnRunners(1000);
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
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
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
    await runWorkQueue(w.ctx); await flushTurnRunners(1000);
    expect(w.sent.map((turn) => turn.threadId)).toEqual([handoff.destinationThreadId]);
  });

  it("does not release a dependent entry just because its prerequisite was handed off", async () => {
    const w = await world(); const source = await w.make(); const dependent = await w.make("claudeAgent"); const now = Date.now();
    const entry = await sendTurn(w.store, source.id, { prompt: "prerequisite", queue: parseQueuePolicy({ conditions: [{ type: "at", at: new Date(now + 60_000).toISOString() }], continuation: "stored", order: 1 }) });
    await sendTurn(w.store, dependent.id, { prompt: "after the real work", queue: parseQueuePolicy({ conditions: [{ type: "entry", threadId: source.id, turnId: entry.turn.id }], order: 2 }) });
    await runWorkQueue(w.ctx, now);
    expect(w.sent).toEqual([]);
    await runWorkQueue(w.ctx, now + 61_000); await flushTurnRunners(1000);
    expect(w.sent.length).toBeGreaterThan(0);
    expect(w.sent[0]?.threadId).not.toBe(dependent.id);
    await runWorkQueue(w.ctx, now + 62_000); await flushTurnRunners(1000);
    expect(w.sent.at(-1)?.threadId).toBe(dependent.id);
  });
});
