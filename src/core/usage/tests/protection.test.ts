import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn, interruptTurn } from "../../threads/threads.js";
import { flushTurnRunners, type TurnDriver } from "../../threads/execute.js";
import { continueThread, scheduleUsageContinue, type OperationContext } from "../../threads/operations.js";
import { parseQueuePolicy } from "../../threads/queue.js";
import { openThreadStore } from "../../threads/store.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../limits.js";
import { UsageProtection, USAGE_CANDIDATE_RESCAN_MS, WRAP_UP_PROMPT } from "../protection.js";
import { UsageForecaster, usageCost } from "../forecast.js";

afterEach(resetUsageLimitsForTests);

async function world(provider: "claude" | "codex" = "codex") {
  const sent: string[] = [];
  const harness = await testHarness({ onSendTurn: (turn) => sent.push(turn.threadId) });
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: { ...harness.config, usageProtection: "auto", usageRecovery: "sequential" }, driverFor: (id) => {
    const kind = driverKindOfInstance(id)!;
    let driver = drivers.get(kind);
    if (!driver) { driver = harness.drivers[kind]!(); drivers.set(kind, driver); }
    return driver;
  } };
  const make = async (title: string) => {
    const thread = await createThread(harness.store, { projectId: "p", title, env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: provider === "claude" ? "claudeAgent" : "codex", model: provider === "claude" ? "claude-opus-5" : "gpt-6.1-sol" } });
    await sendTurn(harness.store, thread.id, { prompt: "Finish the feature" });
    return thread.id;
  };
  return { ...harness, ctx, sent, make, guard: new UsageProtection(async () => ctx) };
}

async function settleStartedTurns(w: Awaited<ReturnType<typeof world>>, threadId: string) {
  const started = (await w.store.readTurns(threadId)).filter((turn) => turn.status === "running");
  await flushTurnRunners();
  const turns = await w.store.readTurns(threadId);
  for (const turn of started) expect(turns.find((settled) => settled.id === turn.id)?.status).toBe("completed");
  expect(openTurn(turns)).toBeNull();
}

describe("usage protection", () => {
  it("keeps queued input held while the wrap-up settles slowly, before and after completion", async () => {
    const w = await world();
    const id = await w.make("gated wrap-up");
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checkpoint = new Promise<void>((resolve) => { reached = resolve; });
    const append = w.store.appendLedger.bind(w.store);
    const persist = vi.spyOn(w.store, "appendLedger").mockImplementation(async (threadId, name, row) => {
      if (threadId === id && name === "checkpoints") { reached(); await gate; }
      return append(threadId, name, row);
    });
    let unsubscribe = () => {};
    try {
      recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
      await w.guard.tick();
      await checkpoint;
      const running = openTurn(await w.store.readTurns(id))!;
      expect((await w.store.readMessages(id)).find((message) => message.id === running.messageId)?.origin).toBe("usage-protection");
      const completed = new Promise<void>((resolve) => {
        unsubscribe = w.store.subscribe((event) => {
          if (event.type === "backend.thread.changed" && event.threadId === id && event.reason === "turn-completed") resolve();
        });
      });
      const queued = await sendTurn(w.store, id, { prompt: "held input", delivery: "queue" });
      expect(queued.turn.status).toBe("queued");
      expect(running.id).not.toBe(queued.turn.id);
      await w.guard.tick();
      expect(openTurn(await w.store.readTurns(id))?.id).toBe(running.id);
      expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
      release();
      await completed;
      expect((await w.store.readTurns(id)).find((turn) => turn.id === running.id)?.status).toBe("completed");
      await w.guard.tick();
      expect(openTurn(await w.store.readTurns(id))).toBeNull();
      expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
    } finally {
      release();
      unsubscribe();
      await flushTurnRunners();
      persist.mockRestore();
      w.guard.close();
    }
  });

  it.each(["off", "auto"] as const)("%s ticks do not reread idle history and discover queued work from store events", async (mode) => {
    const w = await world();
    w.ctx.config.usageProtection = mode;
    const idle: string[] = [];
    for (let index = 0; index < 50; index++) {
      const id = await w.make(`idle ${index}`);
      await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "done" });
      await w.store.rewriteLedger(id, "activity", Array.from({ length: 20 }, (_, index) => ({
        id: `activity-${index}`, threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(),
        payload: { usedTokens: 10_000, cachedInputTokens: 5000, detail: "history".repeat(100) },
      })));
      idle.push(id);
    }
    const running = await w.make("running");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const now = Date.now();
    await w.guard.tick(now);
    const turns = vi.spyOn(w.store, "readTurns");
    const activities = vi.spyOn(w.store, "readActivities");
    const records = vi.spyOn(w.store, "readThreadRecord");
    const lists = vi.spyOn(w.store, "listThreadIds");
    for (let tick = 1; tick <= 3; tick++) await w.guard.tick(now + tick * 2000);
    expect(turns.mock.calls.every(([id]) => id === running)).toBe(true);
    expect(records.mock.calls.every(([id]) => id === running)).toBe(true);
    expect(activities).not.toHaveBeenCalled();
    expect(lists).not.toHaveBeenCalled();
    await sendTurn(w.store, idle[0]!, { prompt: "queued through the API", queue: parseQueuePolicy({ conditions: [], held: true }) });
    turns.mockClear(); records.mockClear();
    await w.guard.tick(now + 8000);
    expect(turns.mock.calls.some(([id]) => id === idle[0])).toBe(true);
    expect(turns.mock.calls.every(([id]) => id === running || id === idle[0])).toBe(true);
    expect(lists).not.toHaveBeenCalled();
    // Another process has no local emitter: a periodic scan must still find its work.
    const outside = await openThreadStore(w.root);
    const external = await createThread(outside, {
      projectId: "p", title: "external write", env: { mode: "local", path: w.work, branch: null },
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    });
    await sendTurn(outside, external.id, { prompt: "work from another process" });
    await w.guard.tick(now + 10_000);
    expect(turns.mock.calls.some(([id]) => id === external.id)).toBe(false);
    await w.guard.tick(now + USAGE_CANDIDATE_RESCAN_MS);
    expect(turns.mock.calls.some(([id]) => id === external.id)).toBe(true);
    expect(lists).toHaveBeenCalledTimes(1);
    w.guard.close();
  });

  it("keeps context readings live without rereading activity history, and replaces live cost on settlement", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("live context");
    const turn = openTurn(await w.store.readTurns(id))!;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    await w.guard.tick();
    const activities = vi.spyOn(w.store, "readActivities");
    await w.store.appendLedger(id, "activity", {
      id: "context", threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(),
      payload: { usedTokens: 20_000, cachedInputTokens: 10_000 },
    });
    w.guard.observe({ type: "token-usage.updated", threadId: id, provider: "codex",
      usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 2 } });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2]).toMatchObject({ costUsd: 2 });
    expect(forecast.mock.calls.at(-1)?.[2].wrapCostUsd).toBeGreaterThan(0);
    await completeTurn(w.store, id, turn.id, {
      text: "done", usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 3 },
    });
    w.guard.observe({ type: "turn.completed", threadId: id, provider: "codex", turnId: turn.id });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBe(3);
    expect(activities).not.toHaveBeenCalled();
    forecast.mockRestore();
    w.guard.close();
  });

  it("prices recorded usage as it is: input already excludes cached reads, so the cache is not subtracted again", async () => {
    // Every driver records `input` and `cacheRead` as disjoint (MXN-235): 10,000 uncached plus 90,000 cached.
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("cached work");
    const turn = openTurn(await w.store.readTurns(id))!;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    const usage = { input: 10_000, cacheRead: 90_000, cacheCreate: 0, output: 0, thinking: 0 };
    w.guard.observe({ type: "token-usage.updated", threadId: id, provider: "codex", usage });
    await w.guard.tick();
    const priced = usageCost("gpt-6.1-sol", usage)!.usd;
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(priced, 9);
    await completeTurn(w.store, id, turn.id, { text: "done", usage });
    w.guard.observe({ type: "turn.completed", threadId: id, provider: "codex", turnId: turn.id });
    await w.guard.tick();
    expect(forecast.mock.calls.at(-1)?.[2].costUsd).toBeCloseTo(priced, 9);
    forecast.mockRestore();
    w.guard.close();
  });

  it("counts Claude cumulative gains and session resets once, not every historical snapshot", async () => {
    const w = await world("claude");
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("cumulative costs");
    const usage = { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0 };
    for (const costUsd of [2, 5, 1]) {
      await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "done", usage: { ...usage, costUsd } });
      await sendTurn(w.store, id, { prompt: "more work" });
    }
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null }]);
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    await w.guard.tick();
    await w.store.appendLedger(id, "activity", {
      id: "context", threadId: id, kind: "context-window.updated", createdAt: w.store.nowIso(), payload: { costUsd: 3 },
    });
    await w.guard.tick();
    await w.guard.tick();
    expect(forecast.mock.calls.map(([, , work]) => work.costUsd)).toEqual([6, 8, 8]);
    forecast.mockRestore();
    w.guard.close();
  });

  it.each(["codex", "claude"] as const)("%s cost stays monotone when paid threads leave the candidate set", async (provider) => {
    const w = await world(provider);
    w.ctx.config.usageProtection = "notify";
    const paid = await w.make("paid work");
    const other = await w.make("still running");
    const turn = openTurn(await w.store.readTurns(paid))!;
    const forecast = vi.spyOn(UsageForecaster.prototype, "forecast");
    const window = { id: "session", label: "Session", usedPercent: 20, exhausted: false, resetsAt: null };
    recordUsageWindows(provider, [window]);
    const now = Date.now();
    await w.guard.tick(now);
    await completeTurn(w.store, paid, turn.id, {
      text: "done", usage: { input: 100, output: 100, thinking: 0, cacheRead: 0, cacheCreate: 0, costUsd: 4 },
    });
    recordUsageWindows(provider, [{ ...window, usedPercent: 21 }]);
    await w.guard.tick(now + 2000);
    const calibrated = w.guard.read().forecasts[0]!.remainingWorkMs;
    expect(calibrated).not.toBeNull();
    const turns = vi.spyOn(w.store, "readTurns");
    await w.guard.tick(now + 4000);
    expect(turns.mock.calls.every(([id]) => id === other)).toBe(true);
    const costs = forecast.mock.calls.map(([, , work]) => work.costUsd);
    expect(costs).toEqual([0, 4, 4]);
    expect(w.guard.read().forecasts[0]!.remainingWorkMs).toBe(calibrated);
    forecast.mockRestore();
    w.guard.close();
  });

  it.each(["claude", "codex"] as const)("%s lets a manual message override only its thread until the next reset, across restart", async (provider) => {
    const w = await world(provider);
    const first = await w.make("override");
    const second = await w.make("still protected");
    const reset = new Date(Date.now() + 60_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: reset }]);
    await w.guard.tick();
    const recovery = (await w.store.readThreadRecord(first))!.usagePause!.recoveryTurnId!;
    await sendTurn(w.store, first, { prompt: "later", scheduledFor: new Date(Date.now() + 86400_000).toISOString() });
    await sendTurn(w.store, first, { prompt: "task settled", origin: "task-notification" });
    expect((await w.store.readThreadRecord(first))?.usagePause).not.toBeNull();
    await expect(sendTurn(w.store, first, { prompt: "invalid restart", delivery: "restart" })).rejects.toThrow("no active turn");
    expect((await w.store.readThreadRecord(first))?.usageProtectionOverride).toBeUndefined();
    const sent = await sendTurn(w.store, first, { prompt: "Continue anyway" });
    expect(sent.turn.status).toBe("running");
    expect(sent.thread.usagePause).toBeNull();
    expect(sent.thread.usageProtectionOverride?.provider).toBe(provider);
    expect((await w.store.readTurns(first)).find((turn) => turn.id === recovery)).toMatchObject({ status: "interrupted", queue: { removed: true } });
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    expect(openTurn(await w.store.readTurns(first))?.id).toBe(sent.turn.id);
    expect((await w.store.readThreadRecord(second))?.usagePause).not.toBeNull();
    // Reset ends the override permanently, not just for the first low report.
    const nextReset = new Date(Date.parse(reset) + 3600_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 0, exhausted: false, resetsAt: nextReset }]);
    await restarted.tick();
    expect((await w.store.readThreadRecord(first))?.usageProtectionOverride).toBeNull();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: nextReset }]);
    await restarted.tick();
    expect((await w.store.readThreadRecord(first))?.usagePause).not.toBeNull();
    expect(openTurn(await w.store.readTurns(first))).toBeNull();
  });

  it("does not interrupt or double-wrap Claude's native allowance, including after restart", async () => {
    const w = await world("claude");
    w.ctx.config.providers = { claude: { usageWrapUp: "provider" } };
    const id = await w.make("native");
    const turn = openTurn(await w.store.readTurns(id))!;
    const stop = vi.spyOn(w.ctx.driverFor("claudeAgent"), "interruptTurn");
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: true, resetsAt: new Date(Date.now() + 3600_000).toISOString() }]);
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    expect(stop).not.toHaveBeenCalled();
    expect(w.sent).toEqual([]);
    expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ phase: "wrapping", native: true });
    await expect(w.guard.wrap("claude")).rejects.toThrow("Claude Code manages wrap-up");
    await completeTurn(w.store, id, turn.id, { text: "Stopped safely. Next: tests." });
    await restarted.tick();
    expect(restarted.read().queue[0]?.phase).toBe("waiting");
  });

  it("does not interrupt Claude's native allowance when it starts during a Moxen wrap-up", async () => {
    const w = await world("claude");
    const id = await w.make("Moxen wrap-up");
    const turn = openTurn(await w.store.readTurns(id))!;
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    const thread = (await w.store.readThreadRecord(id))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: {
      provider: "claude", phase: "wrapping", resetsAt, order: 1, handoff: false, turnId: turn.id,
    } });
    recordUsageWindows("claude", [{ id: "session", label: "Session", usedPercent: 100, exhausted: false, resetsAt }]);
    const stop = vi.spyOn(w.ctx.driverFor("claudeAgent"), "interruptTurn");
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    expect(stop).not.toHaveBeenCalled();
    expect(openTurn(await w.store.readTurns(id))?.id).toBe(turn.id);
    expect((await w.store.readThreadRecord(id))?.usagePause).toMatchObject({ phase: "wrapping", native: true, turnId: turn.id, order: 1 });
    expect(w.sent).toEqual([]);
    await completeTurn(w.store, id, turn.id, { text: "safe stopping point" });
    await w.guard.tick();
    expect(w.guard.read().queue[0]?.phase).toBe("waiting");
    w.guard.close();
  });

  it("does not wait for a weekly reset when the session reserve triggers below 90 percent", async () => {
    const w = await world();
    const ids = [];
    for (let index = 0; index < 4; index++) ids.push(await w.make(`work ${index}`));
    const now = Date.now();
    const session = new Date(now + 3600_000).toISOString();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 89, exhausted: false, resetsAt: session },
      { id: "weekly", label: "Weekly", usedPercent: 20, exhausted: false, resetsAt: new Date(now + 6 * 86400_000).toISOString() },
    ]);
    await w.guard.tick(now);
    expect(w.guard.read().queue).toHaveLength(4);
    expect(w.guard.read().queue.map((entry) => entry.resetsAt)).toEqual(ids.map(() => session));
    for (const id of ids) {
      await settleStartedTurns(w, id);
      await w.guard.tick(now);
    }
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick(Date.parse(session) + 6000);
    await flushTurnRunners();
    expect(w.sent).toHaveLength(5);
    restarted.close();
    w.guard.close();
  });

  it("does not lose native wrap-up when its turn settles before the next scheduler tick", async () => {
    const w = await world("claude");
    w.ctx.config.providers = { claude: { usageWrapUp: "provider" } };
    const id = await w.make("already stopped");
    await completeTurn(w.store, id, openTurn(await w.store.readTurns(id))!.id, { text: "safe stopping point" });
    recordUsageWindows("claude", [{
      id: "session", label: "Session", usedPercent: 100, exhausted: true,
      resetsAt: new Date(Date.now() + 3600_000).toISOString(),
    }]);
    w.guard.observe({ type: "thread.state.changed", provider: "claude", threadId: id, state: "usage-wrap-up" });
    await w.guard.tick();
    expect(w.guard.read().queue[0]).toMatchObject({ threadId: id, phase: "waiting", native: true });
    expect((await w.store.readThreadRecord(id))?.usagePause?.recoveryTurnId).toBeTruthy();
    w.guard.close();
  });

  it("notify mode leaves work running until requested, and cancellation keeps queued messages unsent", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("notify");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    expect(w.guard.read().forecasts[0]?.shouldWrap).toBe(true);
    expect(openTurn(await w.store.readTurns(id))).not.toBeNull();
    await w.guard.wrap("codex");
    const queued = await sendTurn(w.store, id, { prompt: "Keep this request", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    expect(await scheduleUsageContinue(w.ctx, id, queued.turn.id, new Date(Date.now() + 1000).toISOString())).toBeNull();
    await w.guard.reorder(id, "cancel");
    await w.guard.tick();
    expect(w.guard.read().queue).toEqual([]);
    expect(openTurn(await w.store.readTurns(id))).toBeNull();
    expect((await w.store.readTurns(id)).find((turn) => turn.id === queued.turn.id)?.status).toBe("queued");
  });

  it("recovers a missing reset time when telemetry supplies it, and releases parallel threads together", async () => {
    const w = await world();
    w.ctx.config.usageRecovery = "parallel";
    await w.make("one");
    await w.make("two");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.tick();
    expect(w.guard.read().queue.every((entry) => entry.resetsAt === new Date(reset).toISOString())).toBe(true);
    await w.guard.tick(reset + 6000);
    await flushTurnRunners(1000);
    expect(w.sent).toHaveLength(2);
  });

  it.each([false, true])("resumes after a crash before recovery admission when wrap-up was skipped (queued input: %s)", async (queued) => {
    const w = await world();
    const id = await w.make("skipped wrap-up");
    const reset = Date.now() + 60_000;
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(reset).toISOString() }]);
    await w.guard.tick();
    if (queued) await sendTurn(w.store, id, { prompt: "Preserve this request", delivery: "queue" });
    const write = w.store.writeThreadRecord.bind(w.store);
    const crash = vi.spyOn(w.store, "writeThreadRecord").mockImplementation(async (thread) => {
      await write(thread);
      if (thread.usagePause?.phase === "resuming") throw new Error("server stopped before turn admission");
    });
    await expect(w.guard.tick(reset + 6000)).rejects.toThrow("server stopped");
    crash.mockRestore();
    expect(w.sent).toEqual([]);
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick(reset + 6000);
    await settleStartedTurns(w, id);
    expect(w.sent.filter((threadId) => threadId === id).length).toBe(queued ? 2 : 1);
    expect((await w.store.readMessages(id)).filter((message) => message.role === "user" && message.origin === "usage-continue")).toHaveLength(1);
    await restarted.tick(reset + 7000);
    expect(restarted.read().queue).toEqual([]);
  });

  it("reuses a persisted handoff and keeps future scheduled requests out of its prompt", async () => {
    const w = await world();
    const id = await w.make("handoff");
    const turn = openTurn(await w.store.readTurns(id))!;
    await completeTurn(w.store, id, turn.id, { text: "Model summary: implementation finished, tests remain." });
    const thread = (await w.store.readThreadRecord(id))!;
    await w.store.writeThreadRecord({ ...thread, usagePause: { provider: "codex", phase: "waiting", resetsAt: null, order: 1, handoff: true, turnId: turn.id } });
    await sendTurn(w.store, id, { prompt: "Do this next week only", scheduledFor: new Date(Date.now() + 7 * 86400_000).toISOString() });
    const first = await continueThread(w.ctx, { threadId: id, automatic: true });
    await settleStartedTurns(w, first.threadId);
    const again = await continueThread(w.ctx, { threadId: id, automatic: true });
    expect(again.threadId).toBe(first.threadId);
    expect(w.sent).toEqual([first.threadId]);
    const prompt = (await w.store.readMessages(first.threadId)).find((message) => message.role === "user")!.text;
    expect(prompt).toContain("Model summary: implementation finished, tests remain.");
    expect(prompt).not.toContain("Do this next week only");
    expect((await w.store.readTurns(id)).at(-1)?.status).toBe("queued");
    await interruptTurn(w.store, id, (await w.store.readTurns(id)).at(-1)!.id);
  });

  it.each(["claude", "codex"] as const)("%s holds queued input across restart and wraps only one thread at a time", async (provider) => {
    const w = await world(provider);
    const first = await w.make("first");
    const second = await w.make("second");
    const reset = new Date(Date.now() + 3600_000).toISOString();
    recordUsageWindows(provider, [{ id: "session", label: "Session", usedPercent: 94, exhausted: false, resetsAt: reset }]);
    await w.guard.tick();
    await settleStartedTurns(w, first);
    expect(w.sent).toEqual([first]);
    expect((await w.store.readThreadRecord(second))?.usagePause?.phase).toBe("pending");
    const queued = await sendTurn(w.store, first, { prompt: "Also test the edge case", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    expect(openTurn(await w.store.readTurns(first))).toBeNull();
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    await settleStartedTurns(w, second);
    expect(w.sent).toEqual([first, second]);
    await restarted.tick();
    expect(restarted.read().queue.every((entry) => entry.phase === "waiting")).toBe(true);
    expect((await w.store.readMessages(first)).find((message) => message.text === WRAP_UP_PROMPT)?.origin).toBe("usage-protection");
    await restarted.reorder(second, "first");
    expect(restarted.read().queue[0]?.threadId).toBe(second);
    await restarted.tick(Date.parse(reset) + 6000);
    await flushTurnRunners(1000);
    expect(w.sent[2]).toBe(second);
    expect((await w.store.readThreadRecord(first))?.usagePause?.phase).toBe("waiting");
  });

  it("does not release a session reset through a spent weekly window or invent OpenCode quota", async () => {
    const w = await world();
    const id = await w.make("blocked");
    const now = Date.now();
    recordUsageWindows("codex", [
      { id: "session", label: "Session", usedPercent: 99, exhausted: false, resetsAt: new Date(now + 1000).toISOString() },
      { id: "weekly", label: "Weekly", usedPercent: 100, exhausted: true, resetsAt: new Date(now + 86400_000).toISOString() },
    ]);
    await w.guard.tick(now);
    expect(w.sent).toEqual([]);
    await w.guard.tick(now + 10_000);
    expect((await w.store.readThreadRecord(id))?.usagePause?.phase).toBe("waiting");
    expect(w.sent).toEqual([]);
    await expect(w.guard.wrap("opencode")).rejects.toThrow("has not reported usage");
  });

  it("opt-out never interrupts work and held queues do not promote on completion", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "off";
    const id = await w.make("manual");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    expect(openTurn(await w.store.readTurns(id))).not.toBeNull();
    expect(w.guard.read().forecasts).toEqual([]);
    await w.guard.wrap("codex");
    const queued = await sendTurn(w.store, id, { prompt: "queued", delivery: "queue" });
    expect(queued.turn.status).toBe("queued");
    await w.guard.tick();
    await settleStartedTurns(w, id);
    await w.guard.tick();
    expect(w.guard.read().queue[0]?.resetsAt).toBeNull();
    expect(openTurn(await w.store.readTurns(id))).toBeNull();
  });
});

describe("usage forecasts", () => {
  it("learns cost per percent separately per window and forgets it at reset", () => {
    const f = new UsageForecaster();
    const window = { id: "s", kind: "session", label: "Session", usedPercent: 90, resetsAt: "2030-01-01" };
    f.forecast("codex", window, { activeMs: 0, costUsd: 10, wrapCostUsd: 1, running: 2 });
    const forecast = f.forecast("codex", { ...window, usedPercent: 94 }, { activeMs: 240_000, costUsd: 12, wrapCostUsd: 1, running: 2 });
    expect(forecast).toMatchObject({ reservePercent: 3, remainingWorkMs: 90_000, shouldWrap: true });
    expect(f.forecast("codex", { ...window, resetsAt: "2030-01-02", usedPercent: 1 }, { activeMs: 250_000, costUsd: 13, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
    expect(f.forecast("codex", { ...window, id: "w" }, { activeMs: 250_000, costUsd: 13, wrapCostUsd: 1, running: 2 }).remainingWorkMs).toBeNull();
  });

  it("prefers reported cost, charges cached input once, and never adds reasoning twice", () => {
    const usage = { input: 1e6, cacheRead: 1e6, cacheCreate: 1e6, output: 1e6, thinking: 1e6 };
    expect(usageCost("gpt-6.1-sol", usage)).toEqual({ usd: 14.6, source: "estimated" });
    expect(usageCost("unknown", { ...usage, costUsd: 0 })).toEqual({ usd: 0, source: "reported" });
    expect(usageCost("unknown", usage)).toBeNull();
  });
});
