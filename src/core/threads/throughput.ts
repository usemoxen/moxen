import type { StoredTurn } from "./types.js";

/** Estimated output tokens per streaming second; tool execution is excluded. */
export function turnThroughput(turns: readonly StoredTurn[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.status !== "completed" || !turn.generation) continue;
    const { characters, durationMs } = turn.generation;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(characters) || characters <= 0) continue;
    rates[turn.id] = characters / 4 * 1000 / durationMs;
  }
  return rates;
}
