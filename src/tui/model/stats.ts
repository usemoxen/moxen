/**
 * What the stats screen draws, worked out from a `usage.stats` result: the
 * activity heatmap grid, the stacked daily bars, and how numbers are worded.
 * Pure; the modal only paints these.
 */
import type { QueryResult } from "../../server/api.js";

export type UsageStats = QueryResult<"usage.stats">;
export type StatsRange = UsageStats["range"];
export type DailyStats = UsageStats["daily"][number];

export const STATS_RANGES: readonly StatsRange[] = ["all", "30d", "7d"];

export {
  WEEKDAY_ROWS,
  addDays,
  dayKey,
  formatCost,
  formatCount,
  formatHour,
  formatPercent,
  heatmap,
  rangeStartDay,
  type HeatCell,
  type Heatmap,
} from "../../core/usage/present.js";
import { addDays, dayKey as keyOf } from "../../core/usage/present.js";

export interface BarSegment {
  readonly key: string;
  /** Terminal rows this model fills in the column, bottom first. */
  readonly rows: number;
}

function mergeColumns(
  daily: ReadonlyArray<DailyStats>,
  now: Date,
  columns: number,
  perColumn: number,
): ReadonlyArray<{ readonly tokens: number; readonly byModel: ReadonlyMap<string, number> }> {
  const byDay = new Map(daily.map((entry) => [entry.day, entry] as const));
  return Array.from({ length: columns }, (_, column) => {
    const byModel = new Map<string, number>();
    let tokens = 0;
    for (let step = 0; step < perColumn; step += 1) {
      const entry = byDay.get(keyOf(addDays(now, -((columns - 1 - column) * perColumn + step))));
      if (!entry) continue;
      tokens += entry.tokens;
      for (const [model, spent] of Object.entries(entry.byModel)) byModel.set(model, (byModel.get(model) ?? 0) + spent);
    }
    return { tokens, byModel };
  });
}

/** What the tallest column of `stackedBars` holds, for the axis label. */
export function tallestColumn(daily: ReadonlyArray<DailyStats>, now: Date, columns: number, perColumn = 1): number {
  return Math.max(0, ...mergeColumns(daily, now, columns, perColumn).map((column) => column.tokens));
}

/**
 * Daily tokens as stacked columns `height` rows tall, the newest column ending
 * today. A column is `perColumn` calendar days (1 unless the history is longer
 * than the room), their tokens added; an empty stretch is an empty column.
 * Heights scale to the busiest column; each model's part of a column is its
 * share of that column's tokens, rounded so the parts add up to it.
 */
export function stackedBars(
  daily: ReadonlyArray<DailyStats>,
  now: Date,
  columns: number,
  height: number,
  perColumn = 1,
): ReadonlyArray<ReadonlyArray<BarSegment>> {
  const merged = mergeColumns(daily, now, columns, perColumn);
  const busiest = Math.max(0, ...merged.map((column) => column.tokens));
  return merged.map(({ tokens, byModel }) => {
    if (tokens <= 0 || busiest <= 0) return [];
    const total = Math.max(1, Math.round((tokens / busiest) * height));
    const models = [...byModel].filter(([, spent]) => spent > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const sum = models.reduce((all, [, spent]) => all + spent, 0);
    // Largest remainder, so the parts add up to the column exactly.
    const parts = models.map(([key, spent]) => {
      const exact = (spent / sum) * total;
      return { key, rows: Math.floor(exact), rest: exact - Math.floor(exact) };
    });
    let left = total - parts.reduce((all, part) => all + part.rows, 0);
    for (const part of [...parts].sort((a, b) => b.rest - a.rest)) {
      if (left <= 0) break;
      part.rows += 1;
      left -= 1;
    }
    return parts.filter((part) => part.rows > 0).map(({ key, rows }) => ({ key, rows }));
  });
}

export type StatsBucket = UsageStats["byModel"][number];

/** Key of the row that gathers every model past the ones listed on their own. */
export const OTHER_KEY = "*other";

/**
 * The models worth a row: those that spent tokens, the `keep` biggest on their
 * own and the rest gathered into one `OTHER_KEY` bucket (with how many it
 * holds), so a long tail never repeats a colour or buries the leaders.
 */
export function topModels(byModel: ReadonlyArray<StatsBucket>, keep: number): { readonly buckets: ReadonlyArray<StatsBucket>; readonly otherCount: number } {
  const spent = byModel.filter((bucket) => bucket.tokens > 0);
  if (spent.length <= keep) return { buckets: spent, otherCount: 0 };
  const rest = spent.slice(keep);
  const sum = (pick: (bucket: StatsBucket) => number): number => rest.reduce((all, bucket) => all + pick(bucket), 0);
  const priced = rest.filter((bucket) => bucket.costUsd !== null);
  const other: StatsBucket = {
    key: OTHER_KEY,
    usage: {
      input: sum((bucket) => bucket.usage.input),
      cacheRead: sum((bucket) => bucket.usage.cacheRead),
      cacheCreate: sum((bucket) => bucket.usage.cacheCreate),
      output: sum((bucket) => bucket.usage.output),
      thinking: sum((bucket) => bucket.usage.thinking),
      turns: sum((bucket) => bucket.usage.turns),
    },
    tokens: sum((bucket) => bucket.tokens),
    share: sum((bucket) => bucket.share),
    sessions: sum((bucket) => bucket.sessions),
    costUsd: priced.length === 0 ? null : priced.reduce((all, bucket) => all + (bucket.costUsd ?? 0), 0),
    unpricedTurns: sum((bucket) => bucket.unpricedTurns),
  };
  return { buckets: [...spent.slice(0, keep), other], otherCount: rest.length };
}
