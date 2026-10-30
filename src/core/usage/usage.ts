/**
 * Token usage aggregation over turn ledgers. Drivers report usage at settle
 * (recorded on `StoredTurn.usage`); this module sums turns that each hold
 * their own spend — `stats.ts` first turns a running total into that.
 * Providers that report nothing contribute zeros — graceful degradation,
 * never invention. See docs/threads.md.
 */
import type { StoredTurn } from "../threads/types.js";

export interface UsageTotals {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly output: number;
  readonly thinking: number;
  readonly turns: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0, turns: 0 };
}

export function summarizeUsage(turns: ReadonlyArray<StoredTurn>): UsageTotals {
  const totals = { ...emptyUsageTotals() };
  let counted = 0;
  for (const turn of turns) {
    const usage = turn.usage;
    if (!usage) continue;
    counted += 1;
    totals.input += usage.input;
    totals.cacheRead += usage.cacheRead;
    totals.cacheCreate += usage.cacheCreate;
    totals.output += usage.output;
    totals.thinking += usage.thinking;
  }
  return { ...totals, turns: counted };
}
