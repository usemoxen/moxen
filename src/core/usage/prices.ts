/**
 * What a model's tokens cost: the per-provider prices the user set, over
 * Moxen's shipped list. Nothing here is read at the point of use directly —
 * `modelPriceFor` resolves what applies for a provider kind and model, and
 * `usageCost` prices one turn's usage with it. A model with no price anywhere
 * stays unpriced (null), never zero; a partial price values the fields it
 * names and counts the rest as zero.
 */
import type { TurnUsage } from "../threads/types.js";
import type { CliConfig } from "../types.js";

/** USD per million tokens; any field may be absent. */
export interface ModelPrice {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * Moxen's shipped price list: API equivalents, not subscription charges.
 * https://developers.openai.com/api/docs/pricing (2026-11-01) and
 * https://platform.claude.com/docs/en/about-claude/pricing (2026-11-01).
 * Unknown models deliberately have no invented price. A user's own price
 * for a model wins over its row here, field by field.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-6": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6.1-terra": { input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },
  "gpt-5.4": { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15 },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, cacheWrite: 1.75, output: 14 },
};

export type ModelPriceKind = "claude" | "codex" | "opencode" | "harness";

/**
 * What a model costs on a provider kind: the user's rows for that kind,
 * field by field over the shipped row. Matched on the model string the stats
 * already bucket by (an OpenCode slug keeps its slash), so a user's price for
 * it applies; the same slug on another kind keeps its own price. Null when
 * neither names any field.
 */
export function modelPriceFor(
  config: Pick<CliConfig, "providers">,
  kind: ModelPriceKind | null,
  model: string,
): ModelPrice | null {
  const shipped = DEFAULT_MODEL_PRICES[model];
  const own = (kind === null ? undefined : config.providers?.[kind]) as
    | { readonly modelInputPrices?: Readonly<Record<string, number>>; readonly modelOutputPrices?: Readonly<Record<string, number>>; readonly modelCacheReadPrices?: Readonly<Record<string, number>>; readonly modelCacheWritePrices?: Readonly<Record<string, number>> }
    | undefined;
  const input = own?.modelInputPrices?.[model] ?? shipped?.input;
  const output = own?.modelOutputPrices?.[model] ?? shipped?.output;
  const cacheRead = own?.modelCacheReadPrices?.[model] ?? shipped?.cacheRead;
  const cacheWrite = own?.modelCacheWritePrices?.[model] ?? shipped?.cacheWrite;
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return null;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** What priced tokens amount to: known fields add up, missing ones count as zero. */
export function priceUsage(price: ModelPrice, usage: TurnUsage, fast = false): number {
  // The canonical usage excludes cached input from input; reasoning is already in output.
  return (
    ((usage.input * (price.input ?? 0) +
      usage.cacheRead * (price.cacheRead ?? 0) +
      usage.cacheCreate * (price.cacheWrite ?? 0) +
      usage.output * (price.output ?? 0)) /
      1e6) *
    (fast ? 2 : 1)
  );
}

export function usageCost(price: ModelPrice | null | undefined, usage: TurnUsage, fast = false): { usd: number; source: "reported" | "estimated" } | null {
  if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return { usd: usage.costUsd, source: "reported" };
  if (price === null || price === undefined) return null;
  return { usd: priceUsage(price, usage, fast), source: "estimated" };
}
