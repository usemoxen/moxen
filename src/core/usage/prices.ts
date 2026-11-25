/**
 * What a model's tokens cost: the per-provider prices the user set, over
 * Moxen's shipped list. Nothing here is read at the point of use directly —
 * `modelPriceFor` resolves what applies for a provider kind and model, and
 * `usageCost` prices one turn's usage with it. A model with no price anywhere
 * stays unpriced (null), never zero; a partial price values the fields it
 * names and counts the rest as zero.
 */
import type { StoredThread, StoredTurn, TurnUsage } from "../threads/types.js";
import { driverKindOfInstance, resolveProfileProviderConfig, type CliConfig, type ModelSelection } from "../types.js";
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
 * - https://developers.openai.com/api/docs/pricing (2026-11-19)
 * - https://platform.claude.com/docs/en/about-claude/pricing (2026-11-22)
 * - https://ai.google.dev/gemini-api/docs/pricing (2026-11-20)
 * - https://mistral.ai/pricing & mistral-vibe v3.1.4 vibe_schema.py (2026-11-24)
 */
export const HAND_EDITED_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-6": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  "claude-haiku-5-5": {
    input: 0.1,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    tiers: [{ afterTokens: 100_000, input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, output: 2.5 }],
  },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  "claude-fable-5-2": { input: 8, cacheRead: 0.2, cacheWrite: 10, output: 40 },
  "gemini-4-neon": { input: 3, cacheRead: 0.15, output: 15 },
  // Introductory pricing through 2026-11-30 (standard $4/$20 from 2026-12-01).
  "gemini-4-argon": { input: 2, cacheRead: 0.1, output: 10 },
  "gemini-4-hydrogen": { input: 1.5, cacheRead: 0.075, output: 7.5 },
  // Introductory pricing through 2026-12-31 (standard $1.50/$7.50 from 2027-01-01).
  "gemini-3.8-flash": { input: 0.75, cacheRead: 0.075, output: 3.75 },
  "gpt-6.2-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6.2-astra": { input: 8, cacheRead: 0.4, cacheWrite: 10, output: 40 },
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
  "mistral-large-4-0": { input: 0.7, cacheRead: 0.07, output: 2.1 },
  "mistral-medium-latest": { input: 1.5, cacheRead: 0.15, output: 7.5 },
  "mistral-vibe-cli-latest": { input: 1.5, cacheRead: 0.15, output: 7.5 },
  "zai-glm-5-3": { input: 1.4, cacheRead: 0.14, output: 4.4 },
  "zai-glm-5-3-flash": { input: 0.15, cacheRead: 0.03, output: 0.5 },
  "zai-glm-5-3-flash-vibe-free": { input: 0, cacheRead: 0, output: 0 },
  "deepseek-v4-1-flash-1017": { input: 0.3, cacheRead: 0.007, output: 1.2 },
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

export type ModelPriceKind = "claude" | "codex" | "chatgpt" | "opencode" | "harness" | "acp" | "antigravity" | "vibe";

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
  instanceId?: string,
): ModelPrice | null {
  const shipped = DEFAULT_MODEL_PRICES[model];
  const own = (instanceId ? resolveProfileProviderConfig(config, instanceId) : (kind === null ? undefined : config.providers?.[kind])) as
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

/** Whether a model selection asks for fast-lane (2x) pricing. */
export function isFastSelection(selection: Pick<ModelSelection, "options"> | null | undefined): boolean {
  return (
    selection?.options?.some(
      (option) =>
        (option.id === "fastMode" && option.value === true) ||
        (option.id === "serviceTier" && option.value === "fast"),
    ) ?? false
  );
}

export interface InFlightTurnUsage {
  readonly turnId?: string;
  readonly modelSelection?: ModelSelection | null;
  readonly usage: TurnUsage;
}

function gain(before: number, after: number): number {
  return after >= before ? after - before : after;
}

function diffRunningUsage(before: TurnUsage | undefined, current: TurnUsage): TurnUsage {
  if (!before) return current;
  return {
    input: gain(before.input, current.input),
    cacheRead: gain(before.cacheRead, current.cacheRead),
    cacheCreate: gain(before.cacheCreate, current.cacheCreate),
    output: gain(before.output, current.output),
    thinking: gain(before.thinking, current.thinking),
    ...(current.costUsd === undefined ? {} : { costUsd: gain(before.costUsd ?? 0, current.costUsd) }),
  };
}

/** One model's share of a thread's cost, as the thread's own turns add up. */
export interface ThreadModelCost {
  /** The model slug the turns selected. */
  readonly model: string;
  /** USD for its turns; null when none of them could be priced (unpriced, never $0). */
  readonly costUsd: number | null;
  readonly turns: number;
  /** Its turns that could not be priced, so `costUsd` covers only the rest. */
  readonly unpricedTurns: number;
}

/**
 * What a thread has cost: the sum of its priced turns, by model. The rules are
 * `computeUsageStats`' — a provider-reported cost beats Moxen's price list,
 * Claude turns store running totals so each counts the gain over the one
 * before it, and an unpriced model stays unpriced rather than zero. Computed
 * from the turns on every read; never stored on the thread.
 */
export interface ThreadCost {
  /** USD over every priced turn; null when no turn could be priced. */
  readonly totalUsd: number | null;
  readonly pricedTurns: number;
  /** Turns that could not be priced; when above zero `totalUsd` is partial. */
  readonly unpricedTurns: number;
  /** Some cost came from a provider's own report rather than a price list. */
  readonly reported: boolean;
  /** Some cost was priced from Moxen's list, so the total is partly an estimate. */
  readonly estimated: boolean;
  /** Per model, costliest first (unpriced last, then by model); sums to `totalUsd`. */
  readonly byModel: readonly ThreadModelCost[];
}

interface ModelCostAccumulator {  costUsd: number | null;
  turns: number;
  unpricedTurns: number;
}

/** No turns to price at all — a thread that has not run, or an unknown one. */
export function emptyThreadCost(): ThreadCost {
  return { totalUsd: null, pricedTurns: 0, unpricedTurns: 0, reported: false, estimated: false, byModel: [] };
}

/**
 * A thread's cost by model — settled turns from the store plus any live
 * in-flight turn usage not yet written, priced exactly as `threadCostUsd` and
 * the stats screen do. `byModel` adds up to `totalUsd` by construction, so a
 * client never has to reconcile two figures.
 */
export function threadCostSplit(
  thread: Pick<StoredThread, "modelSelection">,
  turns: ReadonlyArray<StoredTurn>,
  config: Pick<CliConfig, "providers">,
  inFlight?: InFlightTurnUsage | null,
): ThreadCost {
  const previousClaude = new Map<string, TurnUsage>();
  const models = new Map<string, ModelCostAccumulator>();
  let total: number | null = null;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  let reported = false;
  let estimated = false;
  let inFlightConsumed = false;

  const bucketOf = (selection: ModelSelection): ModelCostAccumulator => {
    const existing = models.get(selection.model);
    if (existing) return existing;
    const created: ModelCostAccumulator = { costUsd: null, turns: 0, unpricedTurns: 0 };
    models.set(selection.model, created);
    return created;
  };

  /** Count one turn that carries no usage: it spent nothing knowable, so it is unpriced rather than free. */
  const unpriced = (selection: ModelSelection): void => {
    const bucket = bucketOf(selection);
    bucket.turns += 1;
    bucket.unpricedTurns += 1;
    unpricedTurns += 1;
  };

  const account = (selection: ModelSelection, usage: TurnUsage): void => {
    const kind = driverKindOfInstance(selection.instanceId);
    let spend = usage;
    if (kind === "claude") {
      spend = diffRunningUsage(previousClaude.get(selection.instanceId), usage);
      previousClaude.set(selection.instanceId, usage);
    }
    const cost = usageCost(
      modelPriceFor(config, kind, selection.model, selection.instanceId),
      spend,
      isFastSelection(selection),
    );
    const bucket = bucketOf(selection);
    bucket.turns += 1;
    if (cost !== null && Number.isFinite(cost.usd)) {
      total = (total ?? 0) + cost.usd;
      bucket.costUsd = (bucket.costUsd ?? 0) + cost.usd;
      pricedTurns += 1;
      if (cost.source === "reported") reported = true;
      else estimated = true;
      return;
    }
    bucket.unpricedTurns += 1;
    unpricedTurns += 1;
  };

  for (const turn of turns) {
    if (turn.status === "queued") continue;
    const matchesInFlight =
      inFlight != null &&
      !inFlightConsumed &&
      (inFlight.turnId !== undefined ? turn.id === inFlight.turnId : turn.status === "running");
    const selection =
      (matchesInFlight ? inFlight.modelSelection : undefined) ??
      turn.modelSelection ??
      thread.modelSelection;
    if (matchesInFlight) {
      inFlightConsumed = true;
      // A turn that already settled with its own stored usage keeps that truth
      // instead of counting stale in-flight usage twice.
      const effective = turn.status !== "running" && turn.usage !== null ? turn.usage : inFlight.usage;
      account(selection, effective);
      continue;
    }
    if (!turn.usage) {
      unpriced(selection);
      continue;
    }
    account(selection, turn.usage);
  }

  if (inFlight != null && !inFlightConsumed) {
    account(inFlight.modelSelection ?? thread.modelSelection, inFlight.usage);
  }

  const byModel = [...models.entries()]
    .map(([model, bucket]): ThreadModelCost => ({ model, ...bucket }))
    .sort((left, right) => {
      const leftCost = left.costUsd ?? -1;
      const rightCost = right.costUsd ?? -1;
      return rightCost - leftCost || left.model.localeCompare(right.model);
    });

  return {
    totalUsd: total,
    pricedTurns,
    unpricedTurns,
    reported,
    estimated,
    byModel,
  };
}

/**
 * Total cost in USD across a thread's turns — settled turns from the store plus
 * any live in-flight turn usage not yet written — using the same rules as
 * `computeUsageStats` (provider-reported costs win; Claude turns store running
 * totals and count gains over the previous turn; unreported turns price at the
 * user's per-provider rates over Moxen's shipped list). Null when no turn can
 * be priced (never invents $0). `threadCostSplit` is the same sum with its
 * per-model breakdown.
 */
export function threadCostUsd(
  thread: Pick<StoredThread, "modelSelection">,
  turns: ReadonlyArray<StoredTurn>,
  config: Pick<CliConfig, "providers">,
  inFlight?: InFlightTurnUsage | null,
): number | null {
  return threadCostSplit(thread, turns, config, inFlight).totalUsd;
}

/**
 * Resolve the thread's total `costUsd` for a context reading or live breakdown:
 * keeps a driver's own reported cost while still combining earlier turns across
 * restarts or provider switches, and prices threads whose driver reports no
 * cost using `threadCostUsd`. The reading's reported cost means different
 * things per provider: Claude reports a running session total; ACP's
 * `usage_update.cost` is also cumulative for the session (ACP v1), and the
 * driver reports only the delta past the session's baseline as the open turn's
 * live cost — so settled turns plus the in-flight turn count the reading
 * exactly once, and with no open turn the settled ledger stands.
 */
export function resolveContextCostUsd(
  thread: Pick<StoredThread, "modelSelection">,
  turns: ReadonlyArray<StoredTurn>,
  config: Pick<CliConfig, "providers">,
  reportedCostUsd: number | undefined,
  inFlight?: InFlightTurnUsage | null,
): number | null {
  const hasReported = typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0;
  if (hasReported) {
    const open = turns.find((turn) => turn.status === "running");
    const activeSelection = inFlight?.modelSelection ?? open?.modelSelection ?? thread.modelSelection;
    const kind = driverKindOfInstance(activeSelection.instanceId);
    if (kind === "claude") {
      const claudeInFlight: InFlightTurnUsage | null = open
        ? {
            turnId: open.id,
            modelSelection: activeSelection,
            usage: {
              ...(inFlight?.usage ?? { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 }),
              costUsd: reportedCostUsd,
            },
          }
        : inFlight ?? null;
      const computed = threadCostUsd(thread, turns, config, claudeInFlight);
      return computed === null ? reportedCostUsd : Math.max(computed, reportedCostUsd);
    }
    if (kind === "acp" || kind === "antigravity") {
      // ACP's reading is the session's cumulative cost, but the driver carries
      // only the unaccounted delta as the open turn's live cost, so combining
      // settled turns with the in-flight turn counts it exactly once. A turn
      // that already settled keeps its stored usage (never both), and with no
      // open turn a stale reading is not attached to a new turn — the settled
      // ledger is the answer.
      const computed = threadCostUsd(thread, turns, config, inFlight);
      return computed === null ? reportedCostUsd : computed;
    }
    return reportedCostUsd;
  }
  return threadCostUsd(thread, turns, config, inFlight);
}
