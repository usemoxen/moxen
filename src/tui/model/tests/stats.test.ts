import { describe, expect, it } from "vitest";

import { OTHER_KEY, stackedBars, tallestColumn, topModels, type DailyStats, type StatsBucket } from "../stats.js";

// A Thursday.
const NOW = new Date(2026, 9, 29, 12, 0, 0);

function day(key: string, tokens: number, byModel: Record<string, number> = {}): DailyStats {
  return { day: key, tokens, byModel, byProvider: {} };
}

describe("stackedBars", () => {
  it("makes one column a day ending today, empty where nothing happened", () => {
    const bars = stackedBars([day("2026-10-29", 10, { opus: 10 })], NOW, 3, 8);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual([]);
    expect(bars[2]).toEqual([{ key: "opus", rows: 8 }]);
  });

  it("scales to the busiest day and splits a column by model so the parts add up to it", () => {
    const bars = stackedBars(
      [day("2026-10-28", 100, { a: 50, b: 30, c: 20 }), day("2026-10-29", 50, { a: 50 })],
      NOW,
      2,
      10,
    );
    expect(bars[0]!.reduce((all, part) => all + part.rows, 0)).toBe(10);
    expect(bars[0]!.map((part) => part.key)).toEqual(["a", "b", "c"]);
    expect(bars[1]).toEqual([{ key: "a", rows: 5 }]);
  });

  it("adds days together when a column holds several, the newest column ending today", () => {
    const bars = stackedBars(
      [day("2026-10-26", 30, { a: 30 }), day("2026-10-27", 30, { b: 30 }), day("2026-10-28", 50, { a: 50 }), day("2026-10-29", 10, { a: 10 })],
      NOW,
      2,
      6,
      2,
    );
    // Oct 26–27 is 60 (a 30, b 30), Oct 28–29 is 60 (a 60): the same height.
    expect(bars[0]!.reduce((all, part) => all + part.rows, 0)).toBe(6);
    expect(bars[0]).toEqual([{ key: "a", rows: 3 }, { key: "b", rows: 3 }]);
    expect(bars[1]).toEqual([{ key: "a", rows: 6 }]);
    // The axis names the tallest column, not the tallest day in it.
    expect(tallestColumn([day("2026-10-28", 50, { a: 50 }), day("2026-10-29", 10, { a: 10 })], NOW, 1, 2)).toBe(60);
  });

  it("keeps a day with a few tokens at least one row tall", () => {
    const bars = stackedBars([day("2026-10-28", 1_000_000, { a: 1_000_000 }), day("2026-10-29", 1, { a: 1 })], NOW, 2, 8);
    expect(bars[1]).toEqual([{ key: "a", rows: 1 }]);
  });
});

describe("topModels", () => {
  const bucket = (key: string, tokens: number, costUsd: number | null): StatsBucket => ({
    key,
    usage: { input: tokens, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0, turns: 1 },
    tokens,
    share: tokens / 100,
    sessions: 1,
    costUsd,
    unpricedTurns: costUsd === null ? 1 : 0,
  });

  it("drops models that spent nothing", () => {
    const { buckets, otherCount } = topModels([bucket("a", 60, 1), bucket("zero", 0, 0), bucket("b", 40, null)], 5);
    expect(buckets.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(otherCount).toBe(0);
  });

  it("keeps the biggest on their own and gathers the rest, so a long tail never repeats a colour", () => {
    const models = [bucket("a", 50, 5), bucket("b", 30, null), bucket("c", 10, 1), bucket("d", 6, null), bucket("e", 4, 2)];
    const { buckets, otherCount } = topModels(models, 2);
    expect(buckets.map((entry) => entry.key)).toEqual(["a", "b", OTHER_KEY]);
    expect(otherCount).toBe(3);
    const other = buckets[2]!;
    expect(other.tokens).toBe(20);
    expect(other.share).toBeCloseTo(0.2);
    // Cost adds what was reported; one unreported model leaves the bucket partly priced.
    expect(other.costUsd).toBe(3);
    expect(other.unpricedTurns).toBe(1);
  });

  it("leaves the cost of a gathered bucket unpriced when none of them reported one", () => {
    const { buckets } = topModels([bucket("a", 50, 1), bucket("b", 30, null), bucket("c", 20, null)], 1);
    expect(buckets[1]!.costUsd).toBeNull();
  });
});
