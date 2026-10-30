/**
 * How stats are worded and laid out, shared by the stats screen and the image
 * card: short counts, cost, share, the hour, and the activity heatmap grid.
 * Pure rules over a stats result, with no store and no drawing, so a client
 * applies them to what the server returned (like `threads/views`).
 */
import { type DailyStats, type StatsRange, dayKey } from "./stats.js";

export { dayKey };

/** 1234 → `1.2k`, 4_600_000_000 → `4.6B`: three significant figures at most, never a trailing `.0`. */
export function formatCount(value: number): string {
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      const text = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/u, "");
      // 999.9k rounds to 1000k: that is 1M.
      if (text === "1000" && size < 1e9) return `1${suffix === "k" ? "M" : "B"}`;
      return `${text}${suffix}`;
    }
  }
  return Math.round(value).toString();
}

/** A reported cost as dollars; null (nobody reported one) is the caller's word, not `$0.00`. */
export function formatCost(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
}

export function formatPercent(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1).replace(/\.0$/u, "")}%`;
}

/** 24-hour, so no locale decides how it reads. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Days since the Monday of `date`'s week: Monday 0 … Sunday 6. */
function mondayOffset(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/** Row labels of the heatmap, Monday first. */
export const WEEKDAY_ROWS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export interface HeatCell {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  /**
   * 0 nothing that day … 4 the busiest of the range; 1 also covers a day of
   * work whose tokens nobody reported. A day with activity outside the range
   * is 0 and `muted`: still drawn, but grey.
   */
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly muted: boolean;
}

export interface Heatmap {
  /** `rows[weekday][week]`, null past today. */
  readonly rows: ReadonlyArray<ReadonlyArray<HeatCell | null>>;
  /** The month name's column, for the header line: the first week that starts a new month. */
  readonly monthStarts: ReadonlyArray<{ readonly week: number; readonly month: number }>;
}

/** First day of a range as `YYYY-MM-DD`, today included in its count; null for all time. */
export function rangeStartDay(range: StatsRange, now: Date): string | null {
  if (range === "all") return null;
  return dayKey(addDays(now, -((range === "7d" ? 7 : 30) - 1)));
}

/**
 * The last `weeks` weeks ending with the one holding `now`, a column a week
 * and a row a weekday. `daily` is every active day (all time), so changing
 * the range never removes a square: days inside `range` are graded in
 * quarters of the range's busiest day, active days before it turn grey.
 */
export function heatmap(daily: ReadonlyArray<DailyStats>, now: Date, weeks: number, range: StatsRange = "all"): Heatmap {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const first = addDays(today, -mondayOffset(today) - (weeks - 1) * 7);
  const start = rangeStartDay(range, now);
  const inRange = (day: string): boolean => start === null || day >= start;
  const byDay = new Map(daily.map((entry) => [entry.day, entry.tokens] as const));
  const shown = [...byDay.entries()].filter(([day]) => inRange(day) && parseDay(day) >= first && parseDay(day) <= today);
  const busiest = Math.max(0, ...shown.map(([, tokens]) => tokens));
  const level = (tokens: number | undefined): HeatCell["level"] => {
    if (tokens === undefined) return 0;
    if (busiest <= 0 || tokens <= 0) return 1;
    const share = tokens / busiest;
    return share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
  };
  const rows: Array<Array<HeatCell | null>> = Array.from({ length: 7 }, () => []);
  const monthStarts: Array<{ week: number; month: number }> = [];
  let lastMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(first, week * 7 + weekday);
      const key = dayKey(date);
      if (date > today) {
        rows[weekday]!.push(null);
        continue;
      }
      const tokens = byDay.get(key);
      const active = tokens !== undefined;
      rows[weekday]!.push(
        active && !inRange(key) ? { day: key, level: 0, muted: true } : { day: key, level: level(tokens), muted: false },
      );
    }
    const monday = addDays(first, week * 7);
    if (monday.getMonth() !== lastMonth) {
      monthStarts.push({ week, month: monday.getMonth() });
      lastMonth = monday.getMonth();
    }
  }
  return { rows, monthStarts };
}

