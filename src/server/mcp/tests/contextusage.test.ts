/**
 * `context_usage` (MXN-266, MXN-412): an agent sees how full its own context
 * window is — the same figure the TUI shows, with the time of the reading —
 * and never an estimate or an old reading passed off as the current one. It
 * also sees what fills the window and what the thread has cost, and can read
 * the same for a task it delegated, under `task_status`' own rule.
 */
import { realpath } from "node:fs/promises";

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../../core/projects/projects.js";
import { testHarness } from "../../../core/testing/harness.js";
import { createThread } from "../../../core/threads/threads.js";
import type { TurnDriver } from "../../../core/threads/execute.js";
import { DirectConnection } from "../../connection.js";
import { callMoxenTool, moxenToolsFor, MOXEN_TOOLS } from "../tools.js";

const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, "0")}:00.000Z`;
const CODEX = { instanceId: "codex/default", model: "gpt-6.2-sol" };
const CLAUDE = { instanceId: "claudeAgent", model: "claude-opus-5" };
const UNPRICED = { instanceId: "antigravity/default", model: "gpt-oss-120b-medium" };

interface Answer {
  readonly reading: {
    readonly usedTokens: number;
    readonly maxTokens: number | null;
    readonly percentUsed: number | null;
    readonly takenAt: string;
    readonly current: boolean;
  } | null;
  readonly threadId: string;
  readonly provider: string | null;
  readonly categories: ReadonlyArray<{ readonly name: string; readonly tokens: number; readonly kind: string }>;
  readonly heaviestTools: ReadonlyArray<{ readonly name: string; readonly tokens: number }>;
  readonly cost: {
    readonly totalUsd: number | null;
    readonly partial: boolean;
    readonly pricedTurns: number;
    readonly unpricedTurns: number;
    readonly reported: boolean;
    readonly estimated: boolean;
    readonly byModel: ReadonlyArray<{
      readonly model: string;
      readonly costUsd: number | null;
      readonly turns: number;
      readonly unpricedTurns: number;
    }>;
  };
  readonly providerCostByModel?: ReadonlyArray<{ readonly model: string; readonly costUsd: number }>;
  readonly taskId?: string;
  readonly note?: string;
}

/** A Codex driver whose live window the test decides: categories, or totals only. */
function liveDriver(breakdown: () => Record<string, unknown> | null) {
  return (): TurnDriver =>
    ({
      hasSession: () => Effect.succeed(true),
      startSession: () => Effect.succeed({}),
      sendTurn: () => Effect.succeed({ threadId: "", turnId: "t" }),
      interruptTurn: () => Effect.void,
      awaitTurn: async () => ({ status: "completed", text: "", usage: null, error: null }),
      streamEvents: Stream.never,
      contextBreakdown: async () => breakdown() as never,
    }) as unknown as TurnDriver;
}

async function world(options: { readonly breakdown?: () => Record<string, unknown> | null; readonly selection?: typeof CLAUDE } = {}) {
  const harness = await testHarness();
  const connection = new DirectConnection({
    storeRoot: harness.root,
    drivers: {
      ...harness.drivers,
      ...(options.breakdown === undefined ? {} : { codex: liveDriver(options.breakdown) }),
    },
  });
  const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
  await createThread(harness.store, { id: "caller", projectId: project.id, title: "Caller", modelSelection: options.selection ?? CLAUDE });
  await createThread(harness.store, { id: "other", projectId: project.id, title: "Other", modelSelection: CODEX });
  let next = 0;
  const add = (threadId: string, kind: string, payload: Record<string, unknown>, minute: number) =>
    harness.store.appendLedger(threadId, "activity", {
      id: `activity-${(next += 1)}`,
      threadId,
      turnId: null,
      kind,
      summary: "",
      payload,
      createdAt: at(minute),
    });
  const reading = (usedTokens: number, maxTokens: number | null, minute: number, threadId = "caller") =>
    add(threadId, "context-window.updated", { usedTokens, ...(maxTokens === null ? {} : { maxTokens }) }, minute);
  const compaction = (minute: number) => add("caller", "notice", { notice: "compacted" }, minute);
  const turn = (threadId: string, id: string, usage: Record<string, unknown>, selection: Record<string, unknown> = CLAUDE) =>
    harness.store.appendLedger(threadId, "turns", {
      id,
      threadId,
      status: "completed",
      delivery: "started",
      messageId: `m-${id}`,
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: selection,
      parentTurnId: null,
      error: null,
      usage,
      createdAt: at(0),
      updatedAt: at(0),
      completedAt: at(0),
    });
  const ask = async (args: Record<string, unknown> = {}, toolOptions: Parameters<typeof callMoxenTool>[4] = {}, threadId = "caller") => {
    const result = await callMoxenTool(connection, threadId, "context_usage", args, toolOptions);
    return { ...result, value: JSON.parse(result.text) as Answer };
  };
  return { harness, connection, reading, compaction, turn, ask };
}

describe("context_usage", () => {
  it("reports the latest reading's tokens, window, percent and when it was taken", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(120_000, 1_000_000, 1);
      await reading(357_000, 1_000_000, 2);
      const answer = await ask();
      expect(answer.isError).toBe(false);
      // The fields an agent already relied on are unchanged; the rest sits beside them.
      expect(answer.value.reading).toEqual({ usedTokens: 357_000, maxTokens: 1_000_000, percentUsed: 36, takenAt: at(2), current: true });
      expect(answer.value).toMatchObject({ threadId: "caller", provider: "claude" });
    } finally {
      await connection.close();
    }
  });

  it("leaves the percent unknown when the provider reports no window", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(50_000, null, 1);
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 50_000, maxTokens: null, percentUsed: null });
    } finally {
      await connection.close();
    }
  });

  it("says there is no reading, plainly, and never estimates", async () => {
    const { connection, ask } = await world();
    try {
      const answer = await ask();
      expect(answer.isError).toBe(false);
      expect(answer.value.reading).toBeNull();
      expect(answer.value.note).toMatch(/No context reading for this thread yet/u);
      // No shares or tools either: an estimate would be a guess dressed as a reading.
      expect(answer.value).toMatchObject({ categories: [], heaviestTools: [] });
    } finally {
      await connection.close();
    }
  });

  it("reads only the calling thread's own context, whatever argument is passed", async () => {
    const { connection, reading, ask } = await world();
    try {
      await reading(25_000, 200_000, 1);
      await reading(900_000, 1_000_000, 2, "other");
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 25_000, maxTokens: 200_000, percentUsed: 13 });
      // No thread id parameter: a client that sends one anyway still gets its own thread.
      expect((await ask({ threadId: "other" })).value.reading).toMatchObject({ usedTokens: 25_000 });
      const tool = MOXEN_TOOLS.find((candidate) => candidate.name === "context_usage")!;
      // One argument only, and it can only ever name a task the caller delegated.
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(["taskId"]);
    } finally {
      await connection.close();
    }
  });

  it("is offered to a delegated task as well as an ordinary thread", async () => {
    const { connection, reading, ask } = await world();
    try {
      expect(moxenToolsFor({}).map((tool) => tool.name)).toContain("context_usage");
      expect(moxenToolsFor({ delegated: true, memory: "read" }).map((tool) => tool.name)).toContain("context_usage");
      await reading(10_000, 200_000, 1);
      const answer = await ask({}, { delegated: true });
      expect(answer.isError).toBe(false);
      expect(answer.value.reading).toMatchObject({ usedTokens: 10_000 });
    } finally {
      await connection.close();
    }
  });

  it("does not pass a reading from before a compaction off as current", async () => {
    const { connection, reading, compaction, ask } = await world();
    try {
      await reading(190_000, 200_000, 1);
      await compaction(2);
      const stale = await ask();
      expect(stale.value.reading).toMatchObject({ usedTokens: 190_000, takenAt: at(1), current: false });
      expect(stale.value.note).toMatch(/compaction has happened since/u);

      // A reading recorded after the compaction is current again.
      await reading(18_000, 200_000, 3);
      expect((await ask()).value.reading).toMatchObject({ usedTokens: 18_000, current: true });
    } finally {
      await connection.close();
    }
  });

  it("adds what fills the window, the heaviest tools and the provider's own split, beside the reading", async () => {
    const { connection, reading, turn, ask } = await world({
      selection: CODEX,
      breakdown: () => ({
        usedTokens: 84_000,
        maxTokens: 200_000,
        cachedInputTokens: 10_000,
        autoCompactThreshold: 167_000,
        compactsAutomatically: true,
        estimated: false,
        categories: [
          { name: "Messages", tokens: 60_000, kind: "used" },
          { name: "Free space", tokens: 116_000, kind: "free" },
        ],
        tools: [
          { name: "Bash", tokens: 29_000 },
          { name: "Read", tokens: 12_400 },
        ],
        costByModel: [
          { model: "claude-opus-5", costUsd: 11.63 },
          { model: "claude-sonnet-5", costUsd: 1.44 },
        ],
      }),
    });
    try {
      await reading(84_000, 200_000, 1);
      // 1M input on gpt-6.2-sol would list at $2.00; the provider said $2.50, and it wins.
      await turn("caller", "t1", { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0, costUsd: 2.5 }, CODEX);
      const answer = await ask();
      expect(answer.value.reading).toMatchObject({ usedTokens: 84_000 });
      expect(answer.value.categories).toEqual([
        { name: "Messages", tokens: 60_000, kind: "used" },
        { name: "Free space", tokens: 116_000, kind: "free" },
      ]);
      expect(answer.value.heaviestTools).toEqual([
        { name: "Bash", tokens: 29_000 },
        { name: "Read", tokens: 12_400 },
      ]);
      expect(answer.value.providerCostByModel).toEqual([
        { model: "claude-opus-5", costUsd: 11.63 },
        { model: "claude-sonnet-5", costUsd: 1.44 },
      ]);
      expect(answer.value.cost).toEqual({
        totalUsd: 2.5,
        partial: false,
        pricedTurns: 1,
        unpricedTurns: 0,
        reported: true,
        estimated: false,
        byModel: [{ model: "gpt-6.2-sol", costUsd: 2.5, turns: 1, unpricedTurns: 0 }],
      });
      expect(answer.value.note).toMatch(/API-equivalent price/u);
    } finally {
      await connection.close();
    }
  });

  it("says plainly when the provider reports totals only, rather than inventing shares", async () => {
    const { connection, reading, ask } = await world({ breakdown: () => ({ usedTokens: 84_000, maxTokens: 200_000, cachedInputTokens: null, autoCompactThreshold: null, compactsAutomatically: null, categories: [], estimated: false }) });
    try {
      await reading(84_000, 200_000, 1);
      const answer = await ask();
      expect(answer.value.categories).toEqual([]);
      expect(answer.value.heaviestTools).toEqual([]);
      expect(answer.value.note).toMatch(/reports the window's total only/u);
    } finally {
      await connection.close();
    }
  });

  it("keeps an unpriced model unpriced and calls the total partial, never zero", async () => {
    const { connection, reading, turn, ask } = await world();
    try {
      await reading(20_000, 200_000, 1);
      await turn("caller", "p1", { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 });
      await turn("caller", "u1", { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 }, UNPRICED);
      const partial = await ask();
      // claude-opus-5 lists at $5/M input; the unpriced model beside it stays unpriced.
      expect(partial.value.cost).toMatchObject({ totalUsd: 5, partial: true, pricedTurns: 1, unpricedTurns: 1, reported: false, estimated: true });
      expect(partial.value.cost.byModel).toEqual([
        { model: "claude-opus-5", costUsd: 5, turns: 1, unpricedTurns: 0 },
        { model: "gpt-oss-120b-medium", costUsd: null, turns: 1, unpricedTurns: 1 },
      ]);
      expect(partial.value.note).toMatch(/Partial: 1 of this thread's turns/u);

      // A thread with nothing priceable: unknown, and said so, not $0.
      const unpricedOnly = await worldNoPrice();
      await unpricedOnly.turn("caller", "u2", { input: 1_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 });
      const nothing = await unpricedOnly.ask();
      expect(nothing.value.cost.totalUsd).toBeNull();
      expect(nothing.value.cost.byModel).toEqual([{ model: "gpt-oss-120b-medium", costUsd: null, turns: 1, unpricedTurns: 1 }]);
      expect(nothing.value.note).toMatch(/unknown rather than zero/u);
      await unpricedOnly.connection.close();
    } finally {
      await connection.close();
    }
  });
});

/** A world whose only thread runs on a model with no price. */
async function worldNoPrice() {
  const harness = await testHarness();
  const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers });
  const { project } = await ensureStoredProject(process.env.MOXEN_STORE_ROOT!, { workspaceRoot: await realpath(harness.work) });
  await createThread(harness.store, { id: "caller", projectId: project.id, title: "Caller", modelSelection: UNPRICED });
  const turn = (threadId: string, id: string, usage: Record<string, unknown>) =>
    harness.store.appendLedger(threadId, "turns", {
      id,
      threadId,
      status: "completed",
      delivery: "started",
      messageId: `m-${id}`,
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: UNPRICED,
      parentTurnId: null,
      error: null,
      usage,
      createdAt: at(0),
      updatedAt: at(0),
      completedAt: at(0),
    });
  const ask = async (args: Record<string, unknown> = {}) => {
    const result = await callMoxenTool(connection, "caller", "context_usage", args);
    return { value: JSON.parse(result.text) as Answer };
  };
  return { harness, connection, turn, ask };
}

describe("context_usage for a delegated task", () => {
  it("reads the task's own context, and refuses a thread that did not delegate it", async () => {
    const harness = await testHarness();
    const connection = new DirectConnection({ storeRoot: harness.root, drivers: harness.drivers, config: async () => harness.config });
    try {
      const orchestrator = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Orchestrate", wait: true, threadEnvMode: "local" });
      const stranger = await connection.dispatch({ type: "thread.handover", cwd: harness.work, prompt: "Someone else", wait: true, threadEnvMode: "local" });
      const delegated = await callMoxenTool(connection, orchestrator.threadId, "delegate", { task: "Do the work", title: "task", isolation: "shared" });
      expect(delegated.isError).toBe(false);
      const taskId = JSON.parse(delegated.text).taskId as string;

      const parent = await callMoxenTool(connection, orchestrator.threadId, "context_usage", { taskId });
      expect(parent.isError).toBe(false);
      const answer = JSON.parse(parent.text) as Answer;
      expect(answer).toMatchObject({ taskId, threadId: taskId });
      expect(answer.cost.byModel).toBeInstanceOf(Array);

      // The same refusal task_status gives: a thread that did not delegate it learns nothing.
      const refused = await callMoxenTool(connection, stranger.threadId, "context_usage", { taskId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/TASK_NOT_FOUND/u);
      expect(refused.text).not.toMatch(/cost|byModel/u);
    } finally {
      await connection.close();
    }
  }, 30_000);
});
