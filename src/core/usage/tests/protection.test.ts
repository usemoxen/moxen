import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { createThread, sendTurn, openTurn, completeTurn, interruptTurn } from "../../threads/threads.js";
import { flushTurnRunners, type TurnDriver } from "../../threads/execute.js";
import { continueThread, scheduleUsageContinue, type OperationContext } from "../../threads/operations.js";
import { driverKindOfInstance } from "../../types.js";
import { recordUsageWindows, resetUsageLimitsForTests } from "../limits.js";
import { UsageProtection, WRAP_UP_PROMPT } from "../protection.js";
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

describe("usage protection", () => {
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

  it("notify mode leaves work running until requested, and cancellation keeps queued messages unsent", async () => {
    const w = await world();
    w.ctx.config.usageProtection = "notify";
    const id = await w.make("notify");
    recordUsageWindows("codex", [{ id: "session", label: "Session", usedPercent: 96, exhausted: false, resetsAt: null }]);
    await w.guard.tick();
    expect(w.guard.read().forecasts[0]?.shouldWrap).toBe(true);
    expect(openTurn(await w.store.readTurns(id))).not.toBeNull();
    await w.guard.wrap("codex");
    const queued = await sendTurn(w.store, id, { prompt: "Keep this request", delivery: "restart" });
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
    if (queued) await sendTurn(w.store, id, { prompt: "Preserve this request" });
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
    await flushTurnRunners(1000);
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
    await flushTurnRunners(1000);
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
    await flushTurnRunners(1000);
    expect(w.sent).toEqual([first]);
    expect((await w.store.readThreadRecord(second))?.usagePause?.phase).toBe("pending");
    const queued = await sendTurn(w.store, first, { prompt: "Also test the edge case", delivery: "steer" });
    expect(queued.turn.status).toBe("queued");
    expect(openTurn(await w.store.readTurns(first))).toBeNull();
    const restarted = new UsageProtection(async () => w.ctx);
    await restarted.tick();
    await flushTurnRunners(1000);
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
    const queued = await sendTurn(w.store, id, { prompt: "queued" });
    expect(queued.turn.status).toBe("queued");
    await w.guard.tick();
    await flushTurnRunners(1000);
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
