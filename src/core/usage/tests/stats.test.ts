import { describe, expect, it } from "vitest";

import type { StoredTurn } from "../../threads/types.js";
import { type StatsThreadInput, computeUsageStats, rangeStart } from "../stats.js";

const NOW = new Date(2026, 9, 29, 12, 0, 0);

function at(daysAgo: number, hour = 10): string {
  return new Date(2026, 9, 29 - daysAgo, hour, 0, 0).toISOString();
}

function turn(
  when: string,
  model: string | null,
  usage: StoredTurn["usage"],
  extra: Partial<StoredTurn> = {},
): StoredTurn {
  return {
    id: `t-${when}-${model}`,
    threadId: "th",
    status: "completed",
    delivery: "started",
    messageId: "m",
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: model === null ? null : { instanceId: model.startsWith("gpt") ? "codex" : "claude", model },
    parentTurnId: null,
    error: null,
    usage,
    createdAt: when,
    updatedAt: when,
    completedAt: when,
    ...extra,
  };
}

function thread(id: string, turns: StoredTurn[], messageTimes: string[] = []): StatsThreadInput {
  return {
    thread: { id, modelSelection: { instanceId: "claude", model: "opus" } },
    turns,
    messages: messageTimes.map((createdAt) => ({ role: "user" as const, createdAt })),
  };
}

const small = { input: 10, cacheRead: 0, cacheCreate: 0, output: 5, thinking: 0 };

describe("computeUsageStats", () => {
  it("is all zeros with nothing recorded", () => {
    const stats = computeUsageStats([], "all", NOW);
    expect(stats).toMatchObject({
      sessions: 0,
      messages: 0,
      totalTokens: 0,
      activeDays: 0,
      bestStreak: 0,
      peakHour: null,
      favoriteModel: null,
      byProvider: [],
      byModel: [],
      daily: [],
    });
  });

  it("splits tokens by provider and model, with shares that sum to one", () => {
    const stats = computeUsageStats(
      [
        thread("a", [turn(at(0), "opus", { ...small, output: 85 })]),
        thread("b", [turn(at(0), "gpt-5", small)]),
      ],
      "all",
      NOW,
    );
    expect(stats.totalTokens).toBe(110);
    expect(stats.byProvider.map((p) => [p.key, p.tokens])).toEqual([
      ["claude", 95],
      ["codex", 15],
    ]);
    expect(stats.byModel.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(1);
    expect(stats.favoriteModel).toBe("opus");
  });

  it("counts a turn without usage as activity but not tokens, and an unrecorded model as unknown", () => {
    const stats = computeUsageStats([thread("a", [turn(at(0), null, null)])], "all", NOW);
    expect(stats.sessions).toBe(1);
    expect(stats.turns).toBe(1);
    expect(stats.totalTokens).toBe(0);
    expect(stats.byModel.map((m) => m.key)).toEqual(["unknown"]);
    expect(stats.favoriteModel).toBeNull();
  });

  it("carries provider-reported cost: summed where reported, null where no turn reported one", () => {
    const stats = computeUsageStats(
      [
        thread("a", [turn(at(0), "opus", { ...small, costUsd: 0.25 }), turn(at(0, 11), "opus", { ...small, costUsd: 0.5 })]),
        thread("b", [turn(at(0), "gpt-5", small), turn(at(1), "opus", small)]),
      ],
      "all",
      NOW,
    );
    const opus = stats.byModel.find((m) => m.key === "opus");
    expect(opus?.costUsd).toBeCloseTo(0.75);
    expect(opus?.unpricedTurns).toBe(1);
    // Unreported is not free: no cost, not a cost of 0.
    const gpt = stats.byModel.find((m) => m.key === "gpt-5");
    expect(gpt?.costUsd).toBeNull();
    expect(gpt?.unpricedTurns).toBe(1);
    expect(stats.costUsd).toBeCloseTo(0.75);
    expect(stats.unpricedTurns).toBe(2);
    expect(computeUsageStats([], "all", NOW).costUsd).toBeNull();
  });

  it("reads a reported cost of zero as free, not unpriced", () => {
    const stats = computeUsageStats([thread("a", [turn(at(0), "opus", { ...small, costUsd: 0 })])], "all", NOW);
    expect(stats.costUsd).toBe(0);
    expect(stats.unpricedTurns).toBe(0);
  });

  describe("running totals", () => {
    const total = (input: number, costUsd?: number) => ({ ...small, input, ...(costUsd === undefined ? {} : { costUsd }) });
    const claude = new Set(["claude"]);

    it("reads each turn's spend as the gain over the previous total, so the final value is the thread's total", () => {
      const inputs = [thread("a", [turn(at(2), "opus", total(100, 1)), turn(at(1), "opus", total(150, 1.5)), turn(at(0), "opus", total(180, 2))])];
      const stats = computeUsageStats(inputs, "all", NOW, { runningTotals: claude });
      expect(stats.totals.input).toBe(180);
      expect(stats.costUsd).toBeCloseTo(2);
      // Day by day: the range counts what was spent in it.
      const lastDay = computeUsageStats(inputs, "7d", NOW, { runningTotals: claude });
      expect(lastDay.totals.input).toBe(180);
      expect(computeUsageStats([thread("a", [turn(at(40), "opus", total(100)), turn(at(0), "opus", total(130))])], "7d", NOW, { runningTotals: claude }).totals.input).toBe(30);
    });

    it("counts a total that went down as a restart, and leaves other providers' turns alone", () => {
      const stats = computeUsageStats(
        [thread("a", [turn(at(2), "opus", total(100)), turn(at(1), "opus", total(10)), turn(at(0), "gpt-5", total(7))])],
        "all",
        NOW,
        { runningTotals: claude },
      );
      // 100, then 10 more after the restart, plus the per-turn 7 from the other provider.
      expect(stats.totals.input).toBe(117);
    });

    it("without the option every turn is its own spend", () => {
      const stats = computeUsageStats([thread("a", [turn(at(1), "opus", total(100)), turn(at(0), "opus", total(150))])], "all", NOW);
      expect(stats.totals.input).toBe(250);
    });
  });

  it("ignores turns still queued", () => {
    const stats = computeUsageStats([thread("a", [turn(at(0), "opus", small, { status: "queued" })])], "all", NOW);
    expect(stats.sessions).toBe(0);
  });

  it("filters by range, covering today and the days before it", () => {
    const inputs = [thread("a", [turn(at(6), "opus", small), turn(at(7), "opus", small), turn(at(40), "opus", small)])];
    expect(computeUsageStats(inputs, "7d", NOW).turns).toBe(1);
    expect(computeUsageStats(inputs, "30d", NOW).turns).toBe(2);
    expect(computeUsageStats(inputs, "all", NOW).turns).toBe(3);
    expect(rangeStart("all", NOW)).toBeNull();
  });

  it("finds the best streak of consecutive days, and the peak hour", () => {
    const stats = computeUsageStats(
      [
        thread("a", [
          turn(at(10, 5), "opus", small),
          turn(at(9, 5), "opus", small),
          turn(at(8, 5), "opus", small),
          turn(at(3, 14), "opus", small),
          turn(at(2, 14), "opus", small),
          turn(at(2, 5), "opus", small),
        ]),
      ],
      "all",
      NOW,
    );
    expect(stats.activeDays).toBe(5);
    expect(stats.bestStreak).toBe(3);
    expect(stats.peakHour).toBe(5);
    expect(stats.daily.map((d) => d.day)).toEqual([...stats.daily.map((d) => d.day)].sort());
  });

  it("counts user messages in range, not notes moxen wrote", () => {
    const input = thread("a", [turn(at(0), "opus", small)], [at(0), at(50)]);
    const withNote: StatsThreadInput = {
      ...input,
      messages: [...input.messages, { role: "user", createdAt: at(0), origin: "task-notification" }],
    };
    expect(computeUsageStats([withNote], "30d", NOW).messages).toBe(1);
  });
});
