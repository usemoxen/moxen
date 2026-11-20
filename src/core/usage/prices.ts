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
import generatedOpencodePrices from "./opencode-prices.generated.json" with { type: "json" };

/** Context-size pricing tier: applies when prompt tokens (`input + cacheRead + cacheCreate`) exceed `afterTokens`. */
export interface ModelPriceTier {
  readonly afterTokens: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** USD per million tokens; any field may be absent. */
export interface ModelPrice {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Optional context-size tiers (sorted ascending by `afterTokens`), evaluated per turn by prompt size. */
  readonly tiers?: readonly ModelPriceTier[];
}

/**
 * Hand-maintained API-equivalent rows (Claude, OpenAI, Gemini, and any manual
 * overrides). Kept separate from `opencode-prices.generated.json` so running
 * `bun run update:opencode-prices` never overwrites a hand-edited row.
 *
 * Sources:
 * - https://developers.openai.com/api/docs/pricing (2026-11-01)
 * - https://platform.claude.com/docs/en/about-claude/pricing (2026-11-01)
 * - https://ai.google.dev/gemini-api/docs/pricing (2026-11-20)
 */
export const HAND_EDITED_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
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
  "gemini-4-neon": { input: 3, cacheRead: 0.15, output: 15 },
  // Introductory pricing through 2026-11-30 (standard $4/$20 from 2026-12-01).
  "gemini-4-argon": { input: 2, cacheRead: 0.1, output: 10 },
  "gemini-4-hydrogen": { input: 1.5, cacheRead: 0.075, output: 7.5 },
  // Introductory pricing through 2026-12-31 (standard $1.50/$7.50 from 2027-01-01).
  "gemini-3.8-flash": { input: 0.75, cacheRead: 0.075, output: 3.75 },
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

/**
 * Moxen's shipped price list: API equivalents, not subscription charges.
 * Combines the generated OpenCode Go / Zen table (`bun run update:opencode-prices`)
 * with `HAND_EDITED_MODEL_PRICES` (hand-edited entries always win).
 * Unknown models deliberately have no invented price. A user's own price
 * for a model wins over its row here, field by field.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  ...(generatedOpencodePrices as Readonly<Record<string, ModelPrice>>),
  ...HAND_EDITED_MODEL_PRICES,
};

export type ModelPriceKind = "claude" | "codex" | "opencode" | "harness" | "acp" | "antigravity";

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
  const userInput = own?.modelInputPrices?.[model];
  const userOutput = own?.modelOutputPrices?.[model];
  const userCacheRead = own?.modelCacheReadPrices?.[model];
  const userCacheWrite = own?.modelCacheWritePrices?.[model];
  const input = userInput ?? shipped?.input;
  const output = userOutput ?? shipped?.output;
  const cacheRead = userCacheRead ?? shipped?.cacheRead;
  const cacheWrite = userCacheWrite ?? shipped?.cacheWrite;
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return null;
  const tiers = shipped?.tiers?.map((tier): ModelPriceTier => {
    const tInput = userInput ?? tier.input;
    const tOutput = userOutput ?? tier.output;
    const tCacheRead = userCacheRead ?? tier.cacheRead;
    const tCacheWrite = userCacheWrite ?? tier.cacheWrite;
    return {
      afterTokens: tier.afterTokens,
      ...(tInput === undefined ? {} : { input: tInput }),
      ...(tOutput === undefined ? {} : { output: tOutput }),
      ...(tCacheRead === undefined ? {} : { cacheRead: tCacheRead }),
      ...(tCacheWrite === undefined ? {} : { cacheWrite: tCacheWrite }),
    };
  });
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

/** Resolve the effective rate row for one turn, applying any context-size tier exceeded by its prompt size. */
function effectiveRates(price: ModelPrice, usage: TurnUsage): Pick<ModelPrice, "input" | "output" | "cacheRead" | "cacheWrite"> {
  if (!price.tiers || price.tiers.length === 0) return price;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheCreate;
  let active: ModelPriceTier | undefined;
  for (const tier of price.tiers) {
    if (promptTokens > tier.afterTokens && (active === undefined || tier.afterTokens > active.afterTokens)) {
      active = tier;
    }
  }
  if (!active) return price;
  return {
    ...(active.input !== undefined ? { input: active.input } : price.input !== undefined ? { input: price.input } : {}),
    ...(active.output !== undefined ? { output: active.output } : price.output !== undefined ? { output: price.output } : {}),
    ...(active.cacheRead !== undefined ? { cacheRead: active.cacheRead } : price.cacheRead !== undefined ? { cacheRead: price.cacheRead } : {}),
    ...(active.cacheWrite !== undefined ? { cacheWrite: active.cacheWrite } : price.cacheWrite !== undefined ? { cacheWrite: price.cacheWrite } : {}),
  };
}

/** What priced tokens amount to: known fields add up, missing ones count as zero. */
export function priceUsage(price: ModelPrice, usage: TurnUsage, fast = false): number {
  const rates = effectiveRates(price, usage);
  // The canonical usage excludes cached input from input; reasoning is already in output.
  return (
    ((usage.input * (rates.input ?? 0) +
      usage.cacheRead * (rates.cacheRead ?? 0) +
      usage.cacheCreate * (rates.cacheWrite ?? 0) +
      usage.output * (rates.output ?? 0)) /
      1e6) *
    (fast ? 2 : 1)
  );
}

export function usageCost(price: ModelPrice | null | undefined, usage: TurnUsage, fast = false): { usd: number; source: "reported" | "estimated" } | null {
  if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return { usd: usage.costUsd, source: "reported" };
  if (price === null || price === undefined) return null;
  return { usd: priceUsage(price, usage, fast), source: "estimated" };
}
