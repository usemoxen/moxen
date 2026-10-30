import { describe, expect, it } from "vitest";

import { formatCost, formatCount, formatHour, formatPercent, heatmap, rangeStartDay } from "../present.js";
import type { DailyStats } from "../stats.js";

// A Thursday.
const NOW = new Date(2026, 9, 29, 12, 0, 0);

function day(key: string, tokens: number, byModel: Record<string, number> = {}): DailyStats {
  return { day: key, tokens, byModel, byProvider: {} };
}

describe("stats wording", () => {
  it("shortens counts without a trailing zero or a spill into the next unit", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1k");
    expect(formatCount(14_900)).toBe("14.9k");
    expect(formatCount(254_300)).toBe("254k");
    expect(formatCount(999_900)).toBe("1M");
    expect(formatCount(4_600_000_000)).toBe("4.6B");
  });

  it("words cost, share and hour the same on every machine", () => {
    expect(formatCost(467.934)).toBe("$467.93");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatPercent(0.389)).toBe("38.9%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatHour(5)).toBe("05:00");
  });
});

describe("heatmap", () => {
  it("lays weeks out as columns and Monday first, nothing past today", () => {
    const map = heatmap([day("2026-10-29", 10), day("2026-10-26", 100)], NOW, 2);
    expect(map.rows).toHaveLength(7);
    expect(map.rows.every((row) => row.length === 2)).toBe(true);
    // Thursday is row 3; Friday to Sunday of this week have not happened.
    expect(map.rows[3]![1]).toEqual({ day: "2026-10-29", level: 1, muted: false });
    expect(map.rows[0]![1]).toEqual({ day: "2026-10-26", level: 4, muted: false });
    expect(map.rows[4]![1]).toBeNull();
    expect(map.rows[6]![0]).toEqual({ day: "2026-10-25", level: 0, muted: false });
  });

  it("grades days by quarters of the busiest, and a day with no reported tokens still shows as active", () => {
    const map = heatmap([day("2026-10-26", 100), day("2026-10-27", 60), day("2026-10-28", 30), day("2026-10-29", 0)], NOW, 1);
    expect(map.rows.slice(0, 4).map((row) => row[0]?.level)).toEqual([4, 3, 2, 1]);
  });

  it("keeps every active day on screen when the range narrows: those before it turn grey, those in it are graded among themselves", () => {
    const daily = [day("2026-10-12", 1_000), day("2026-10-27", 40), day("2026-10-29", 100)];
    expect(rangeStartDay("7d", NOW)).toBe("2026-10-23");
    expect(rangeStartDay("30d", NOW)).toBe("2026-09-30");
    expect(rangeStartDay("all", NOW)).toBeNull();
    const week = heatmap(daily, NOW, 3, "7d");
    const cell = (key: string) => week.rows.flat().find((entry) => entry?.day === key);
    // Oct 12 was the busiest ever, but it is outside the week: grey, not graded.
    expect(cell("2026-10-12")).toEqual({ day: "2026-10-12", level: 0, muted: true });
    // Inside the week the busiest day is Oct 29, so Oct 27 (40%) is a level 2.
    expect(cell("2026-10-29")).toMatchObject({ level: 4, muted: false });
    expect(cell("2026-10-27")).toMatchObject({ level: 2, muted: false });
    // A day nothing happened on stays an empty cell, in or out of the range.
    expect(cell("2026-10-13")).toEqual({ day: "2026-10-13", level: 0, muted: false });
    // All time is what `all` always was.
    expect(heatmap(daily, NOW, 3, "all").rows.flat().some((entry) => entry?.muted)).toBe(false);
  });

  it("marks where a month begins", () => {
    const map = heatmap([], NOW, 6);
    expect(map.monthStarts.map((start) => start.month)).toEqual([8, 9]);
    expect(map.monthStarts[0]).toEqual({ week: 0, month: 8 });
  });
});

