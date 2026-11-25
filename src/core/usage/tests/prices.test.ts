import { describe, expect, it } from "vitest";

import modelsSnapshot from "../../providers/opencode/models-snapshot.json" with { type: "json" };
import { extractOpencodePrices, mergeOpencodePrices } from "../../../../scripts/update-opencode-prices.js";
import {
  DEFAULT_MODEL_PRICES,
  HAND_EDITED_MODEL_PRICES,
  emptyThreadCost,
  modelPriceFor,
  priceUsage,
  resolveContextCostUsd,
  threadCostSplit,
  threadCostUsd,
  usageCost,
  type ModelPrice,
} from "../prices.js";
import type { StoredTurn } from "../../threads/types.js";
import type { ModelSelection } from "../../types.js";

/** Explicit allowlist of OpenCode Go / Zen models that deliberately ship without a price row. */
const DELIBERATELY_UNPRICED_OPENCODE_MODELS = new Set<string>([]);

const usage = { input: 1e6, cacheRead: 1e6, cacheCreate: 1e6, output: 1e6, thinking: 1e6 };

describe("model prices", () => {
  it("prices a model the user set, even one the shipped list never heard of", () => {
    const config = { providers: { opencode: { modelInputPrices: { "opencode-go/custom-preview": 2 }, modelOutputPrices: { "opencode-go/custom-preview": 10 } } } };
    const price = modelPriceFor(config, "opencode", "opencode-go/custom-preview");
    expect(price).toMatchObject({ input: 2, output: 10 });
    expect(usageCost(price, usage)).toEqual({ usd: 12, source: "estimated" });
  });

  it("lets a user value beat the shipped default for that field, keeping the rest", () => {
    const shipped = DEFAULT_MODEL_PRICES["gpt-6.1-sol"]!;
    const config = { providers: { codex: { modelInputPrices: { "gpt-6.1-sol": 7 } } } };
    const price = modelPriceFor(config, "codex", "gpt-6.1-sol");
    expect(price).toMatchObject({ input: 7, output: shipped.output, cacheRead: shipped.cacheRead, cacheWrite: shipped.cacheWrite });
    expect(price!.input).not.toBe(shipped.input);
  });

  it("falls back to the shipped default once the user value is cleared", () => {
    const withValue = { providers: { codex: { modelInputPrices: { "gpt-6.1-sol": 7 } } } };
    expect(modelPriceFor(withValue, "codex", "gpt-6.1-sol")!.input).toBe(7);
    expect(modelPriceFor({ providers: {} }, "codex", "gpt-6.1-sol")).toEqual(DEFAULT_MODEL_PRICES["gpt-6.1-sol"]);
  });

  it("prices the same model differently per provider", () => {
    const config = { providers: { codex: { modelInputPrices: { "gpt-6.1-sol": 7 } } } };
    expect(modelPriceFor(config, "codex", "gpt-6.1-sol")!.input).toBe(7);
    expect(modelPriceFor(config, "harness", "gpt-6.1-sol")).toEqual(DEFAULT_MODEL_PRICES["gpt-6.1-sol"]);
  });

  it("leaves a model with no price unpriced, and prices only the fields a partial price knows", () => {
    expect(modelPriceFor({ providers: {} }, "codex", "unknown-model")).toBeNull();
    expect(usageCost(null, usage)).toBeNull();
    // Missing fields count as zero: what is known is priced, nothing is invented.
    const partial: ModelPrice = { input: 2, output: 10 };
    expect(priceUsage(partial, usage)).toBe(12);
    expect(usageCost(partial, usage)).toEqual({ usd: 12, source: "estimated" });
  });

  it("prefers a reported cost, charges cached input once, and never adds reasoning twice", () => {
    expect(usageCost(DEFAULT_MODEL_PRICES["gpt-6.1-sol"], usage)).toEqual({ usd: 14.6, source: "estimated" });
    expect(usageCost(null, { ...usage, costUsd: 0 })).toEqual({ usd: 0, source: "reported" });
    expect(usageCost(DEFAULT_MODEL_PRICES["gpt-6.1-sol"], { ...usage, costUsd: 3 })).toEqual({ usd: 3, source: "reported" });
  });

  it("doubles the estimate for a fast-lane request", () => {
    const price = modelPriceFor({ providers: {} }, "codex", "gpt-6.1-sol");
    expect(usageCost(price, usage, true)!.usd).toBeCloseTo(usageCost(price, usage)!.usd * 2, 9);
  });

  it("ships API-equivalent prices for ChatGPT GPT-6.2 Sol and Astra", () => {
    expect(modelPriceFor({ providers: {} }, "chatgpt", "gpt-6.2-sol")).toEqual({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });
    expect(modelPriceFor({ providers: {} }, "chatgpt", "gpt-6.2-astra")).toEqual({ input: 8, cacheRead: 0.4, cacheWrite: 10, output: 40 });
  });

  it("ships API-equivalent prices for Claude Fable 5.2, Opus 4.5, and tiered Haiku 5.5", () => {
    expect(modelPriceFor({ providers: {} }, "claude", "claude-fable-5-2")).toEqual({ input: 8, cacheRead: 0.2, cacheWrite: 10, output: 40 });
    expect(modelPriceFor({ providers: {} }, "claude", "claude-opus-4-5")).toEqual({ input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 });
    const haiku = modelPriceFor({ providers: {} }, "claude", "claude-haiku-5-5")!;
    expect(haiku).toEqual({
      input: 0.1,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      output: 0.5,
      tiers: [{ afterTokens: 100_000, input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, output: 2.5 }],
    });
    const smallTurn = { input: 50_000, cacheRead: 40_000, cacheCreate: 0, output: 10_000, thinking: 0 };
    expect(priceUsage(haiku, smallTurn)).toBeCloseTo((50_000 * 0.1 + 40_000 * 0.01 + 10_000 * 0.5) / 1e6, 9);
    const largeTurn = { input: 60_000, cacheRead: 60_000, cacheCreate: 0, output: 10_000, thinking: 0 };
    expect(priceUsage(haiku, largeTurn)).toBeCloseTo((60_000 * 0.5 + 60_000 * 0.05 + 10_000 * 2.5) / 1e6, 9);
  });

  it("ships API-equivalent prices for Antigravity's Gemini and Claude models while leaving GPT-OSS unpriced", () => {
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-neon")).toEqual({ input: 3, cacheRead: 0.15, output: 15 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-argon")).toEqual({ input: 2, cacheRead: 0.1, output: 10 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-hydrogen")).toEqual({ input: 1.5, cacheRead: 0.075, output: 7.5 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-3.8-flash")).toEqual({ input: 0.75, cacheRead: 0.075, output: 3.75 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "claude-opus-5-5")).toEqual({ input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "claude-sonnet-5-5")).toEqual({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gpt-oss-120b-medium")).toBeNull();
  });

  it("ships API-equivalent prices for Mistral Vibe's native and Mistral-hosted models", () => {
    expect(modelPriceFor({ providers: {} }, "vibe", "mistral-large-4-0")).toEqual({ input: 0.7, cacheRead: 0.07, output: 2.1 });
    expect(modelPriceFor({ providers: {} }, "vibe", "mistral-medium-latest")).toEqual({ input: 1.5, cacheRead: 0.15, output: 7.5 });
    expect(modelPriceFor({ providers: {} }, "vibe", "zai-glm-5-3")).toEqual({ input: 1.4, cacheRead: 0.14, output: 4.4 });
    expect(modelPriceFor({ providers: {} }, "vibe", "zai-glm-5-3-flash")).toEqual({ input: 0.15, cacheRead: 0.03, output: 0.5 });
    expect(modelPriceFor({ providers: {} }, "vibe", "deepseek-v4-1-flash-1017")).toEqual({ input: 0.3, cacheRead: 0.007, output: 1.2 });
  });

  it("prices every OpenCode Go and OpenCode Zen model in the bundled catalog (or lists it as deliberately unpriced)", () => {
    const snap = modelsSnapshot as Record<string, { models?: Record<string, unknown> }>;
    const missing: string[] = [];
    for (const providerId of ["opencode-go", "opencode"] as const) {
      for (const modelId of Object.keys(snap[providerId]?.models ?? {})) {
        const slug = `${providerId}/${modelId}`;
        if (!(slug in DEFAULT_MODEL_PRICES) && !DELIBERATELY_UNPRICED_OPENCODE_MODELS.has(slug)) {
          missing.push(slug);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("prices free OpenCode Go models at zero (distinct from unpriced) and prices DeepSeek V4.1 Flash", () => {
    const free = modelPriceFor({ providers: {} }, "opencode", "opencode-go/ox-alpha-free");
    expect(free).toEqual({ input: 0, cacheRead: 0, output: 0 });
    expect(usageCost(free, usage)).toEqual({ usd: 0, source: "estimated" });

    const deepseek = modelPriceFor({ providers: {} }, "opencode", "opencode-go/deepseek-v4.1-flash");
    expect(deepseek).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  it("applies context-size tiers by prompt size while still letting user overrides win field by field", () => {
    const qwen = modelPriceFor({ providers: {} }, "opencode", "opencode-go/qwen3.7-plus")!;
    expect(qwen.tiers?.[0]?.afterTokens).toBe(256_000);
    // Below threshold (200k prompt): base rates ($0.40 in, $0.04 cacheRead, $1.60 out).
    const smallTurn = { input: 100_000, cacheRead: 100_000, cacheCreate: 0, output: 10_000, thinking: 0 };
    expect(priceUsage(qwen, smallTurn)).toBeCloseTo((100_000 * 0.4 + 100_000 * 0.04 + 10_000 * 1.6) / 1e6, 9);
    // Above threshold (300k prompt = 100k input + 200k cacheRead > 256k): tier rates ($1.20 in, $0.12 cacheRead, $4.80 out).
    const bigTurn = { input: 100_000, cacheRead: 200_000, cacheCreate: 0, output: 10_000, thinking: 0 };
    expect(priceUsage(qwen, bigTurn)).toBeCloseTo((100_000 * 1.2 + 200_000 * 0.12 + 10_000 * 4.8) / 1e6, 9);

    // User input override wins over both base and tier input, while output still steps up in the high tier.
    const overridden = modelPriceFor(
      { providers: { opencode: { modelInputPrices: { "opencode-go/qwen3.7-plus": 0.5 } } } },
      "opencode",
      "opencode-go/qwen3.7-plus",
    )!;
    expect(priceUsage(overridden, bigTurn)).toBeCloseTo((100_000 * 0.5 + 200_000 * 0.12 + 10_000 * 4.8) / 1e6, 9);
  });

  it("extracts models.dev prices with context tiers, preserves retired models on merge, and keeps hand-edited rows on top", () => {
    const extracted = extractOpencodePrices({
      "opencode-go": {
        models: {
          "tiered-model": {
            cost: {
              input: 1,
              output: 3,
              cache_read: 0.1,
              tiers: [{ input: 2, output: 6, cache_read: 0.2, tier: { type: "context", size: 256000 } }],
            },
          },
          "free-model": { cost: { input: 0, output: 0, cache_read: 0 } },
        },
      },
    });
    expect(extracted).toEqual({
      "opencode-go/free-model": { input: 0, cacheRead: 0, output: 0 },
      "opencode-go/tiered-model": {
        input: 1,
        cacheRead: 0.1,
        output: 3,
        tiers: [{ afterTokens: 256_000, input: 2, output: 6, cacheRead: 0.2 }],
      },
    });

    const merged = mergeOpencodePrices(
      { "opencode-go/retired-model": { input: 0.5, output: 2 }, "opencode-go/tiered-model": { input: 9, output: 9 } },
      extracted,
    );
    expect(merged["opencode-go/retired-model"]).toEqual({ input: 0.5, output: 2 });
    expect(merged["opencode-go/tiered-model"]?.input).toBe(1);

    // Every hand-edited row in prices.ts takes precedence in DEFAULT_MODEL_PRICES.
    for (const [slug, row] of Object.entries(HAND_EDITED_MODEL_PRICES)) {
      expect(DEFAULT_MODEL_PRICES[slug]).toEqual(row);
    }
  });
});

function storedTurn(
  id: string,
  selection: ModelSelection,
  turnUsage: StoredTurn["usage"],
  status: StoredTurn["status"] = "completed",
): StoredTurn {
  const when = "2026-11-22T00:00:00.000Z";
  return {
    id,
    threadId: "th-1",
    status,
    delivery: "started",
    messageId: `m-${id}`,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: selection,
    parentTurnId: null,
    error: null,
    usage: turnUsage,
    createdAt: when,
    updatedAt: when,
    completedAt: status === "completed" ? when : null,
  };
}

describe("threadCostUsd and resolveContextCostUsd (MXN-412)", () => {
  it("prices settled turns plus in-flight usage for ChatGPT, Antigravity, OpenCode, and Codex without double-counting", () => {
    const chatgpt = { instanceId: "chatgpt/default", model: "gpt-6.2-sol" };
    // gpt-6.2-sol: $2/M input, $0.10/M cacheRead, $10/M output
    const t1 = storedTurn("t1", chatgpt, { input: 500_000, cacheRead: 0, cacheCreate: 0, output: 100_000, thinking: 0 }); // $2.00
    const t2 = storedTurn("t2", chatgpt, null, "running");
    const live = { input: 100_000, cacheRead: 500_000, cacheCreate: 0, output: 50_000, thinking: 0 }; // $0.20 + $0.05 + $0.50 = $0.75
    expect(threadCostUsd({ modelSelection: chatgpt }, [t1, t2], { providers: {} }, { turnId: "t2", modelSelection: chatgpt, usage: live })).toBeCloseTo(2.75, 9);

    // Once t2 settles with stored usage, passing stale in-flight usage for t2 never counts it twice.
    const t2Done = storedTurn("t2", chatgpt, { input: 200_000, cacheRead: 500_000, cacheCreate: 0, output: 50_000, thinking: 0 }); // $0.95
    expect(threadCostUsd({ modelSelection: chatgpt }, [t1, t2Done], { providers: {} }, { turnId: "t2", modelSelection: chatgpt, usage: live })).toBeCloseTo(2.95, 9);

    // Antigravity (gemini-4-neon: $3/M in, $0.15/M cacheRead, $15/M out) + OpenCode Go (deepseek-v4.1-flash: $0.15/M in, $0.003/M cacheRead, $0.60/M out)
    const agy = { instanceId: "antigravity/default", model: "gemini-4-neon" };
    const oc = { instanceId: "opencode/opencode-go", model: "opencode-go/deepseek-v4.1-flash" };
    const mixed = [
      storedTurn("a1", agy, { input: 100_000, cacheRead: 200_000, cacheCreate: 0, output: 10_000, thinking: 0 }), // 0.30 + 0.03 + 0.15 = 0.48
      storedTurn("o1", oc, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 500_000, thinking: 0 }), // 0.15 + 0.30 = 0.45
    ];
    expect(threadCostUsd({ modelSelection: agy }, mixed, { providers: {} })).toBeCloseTo(0.93, 9);
  });

  it("handles Claude running totals, restarts, mixed providers, fast mode, free models, and unpriced models", () => {
    const claude = { instanceId: "claude/default", model: "claude-opus-5-5" };
    const t1 = storedTurn("c1", claude, { input: 100, cacheRead: 0, cacheCreate: 0, output: 50, thinking: 0, costUsd: 1.0 });
    const t2 = storedTurn("c2", claude, { input: 200, cacheRead: 0, cacheCreate: 0, output: 100, thinking: 0, costUsd: 1.4 });
    const t3 = storedTurn("c3", claude, null, "running");
    // Restarted Claude process reporting $0.25 on t3 adds onto the prior $1.40 -> $1.65.
    expect(resolveContextCostUsd({ modelSelection: claude }, [t1, t2, t3], { providers: {} }, 0.25)).toBeCloseTo(1.65, 9);
    // Monotonic live Claude reading ($1.85) stays $1.85.
    expect(resolveContextCostUsd({ modelSelection: claude }, [t1, t2, t3], { providers: {} }, 1.85)).toBeCloseTo(1.85, 9);

    // Fast-lane doubles estimated cost; free OpenCode model prices as 0 (not null); unknown model stays null.
    const fastCodex = { instanceId: "codex/default", model: "gpt-6.1-sol", options: [{ id: "serviceTier", value: "fast" }] };
    const normalCodex = { instanceId: "codex/default", model: "gpt-6.1-sol" };
    const u = { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 };
    expect(threadCostUsd({ modelSelection: fastCodex }, [storedTurn("f1", fastCodex, u)], { providers: {} })).toBeCloseTo(4, 9);
    expect(threadCostUsd({ modelSelection: normalCodex }, [storedTurn("n1", normalCodex, u)], { providers: {} })).toBeCloseTo(2, 9);

    const freeOc = { instanceId: "opencode/opencode-go", model: "opencode-go/ox-alpha-free" };
    expect(threadCostUsd({ modelSelection: freeOc }, [storedTurn("fr1", freeOc, u)], { providers: {} })).toBe(0);

    const unknown = { instanceId: "antigravity/default", model: "gpt-oss-120b-medium" };
    expect(threadCostUsd({ modelSelection: unknown }, [storedTurn("u1", unknown, u)], { providers: {} })).toBeNull();
  });

  it("adds only the unaccounted delta of an ACP cumulative reading on top of the settled ledger (LOCAL-009)", () => {
    const agy = { instanceId: "antigravity/default", model: "gemini-4-neon" };
    const u = { input: 10, cacheRead: 0, cacheCreate: 0, output: 5, thinking: 0 };
    // The ledger records each settled turn's prompt-result (per-turn) cost.
    const t1 = storedTurn("a1", agy, { ...u, costUsd: 0.25 });
    const t2 = storedTurn("a2", agy, null, "running");
    // ACP `usage_update.cost` is the session's CUMULATIVE cost; the driver reports
    // only the delta past the session baseline as the open turn's live cost.
    const live = { ...u, costUsd: 0.15 };
    // Cumulative reading 0.40 (= 0.25 settled + 0.15 in flight): the thread total is
    // 0.40, not 0.65 (the reading must not be counted again as the open turn's cost).
    expect(
      resolveContextCostUsd({ modelSelection: agy }, [t1, t2], { providers: {} }, 0.4, { turnId: "a2", modelSelection: agy, usage: live }),
    ).toBeCloseTo(0.4, 9);
    // No open turn: the settled ledger stands; a stale cumulative reading is never
    // attached to a new turn.
    expect(resolveContextCostUsd({ modelSelection: agy }, [t1], { providers: {} }, 0.4, null)).toBeCloseTo(0.25, 9);
    // While the turn settles (stored usage appears), nothing is counted twice.
    const t2Done = storedTurn("a2", agy, { ...u, costUsd: 0.25 });
    expect(
      resolveContextCostUsd({ modelSelection: agy }, [t1, t2Done], { providers: {} }, 0.5, { turnId: "a2", modelSelection: agy, usage: live }),
    ).toBeCloseTo(0.5, 9);
  });
});

describe("threadCostSplit (MXN-412)", () => {
  it("splits a thread's cost by model so the rows add up to the total exactly", () => {
    const opus = { instanceId: "claude/default", model: "claude-opus-5-5" };
    const sonnet = { instanceId: "claude/default", model: "claude-sonnet-5-5" };
    // Claude's turns store the session's running total, so each counts its gain:
    // Opus $1.00 + $2.00 = $3.00, Sonnet $0.40.
    const turns = [
      storedTurn("c1", opus, { input: 10, cacheRead: 0, cacheCreate: 0, output: 5, thinking: 0, costUsd: 1.0 }),
      storedTurn("c2", opus, { input: 20, cacheRead: 0, cacheCreate: 0, output: 5, thinking: 0, costUsd: 3.0 }),
      storedTurn("c3", sonnet, { input: 10, cacheRead: 0, cacheCreate: 0, output: 5, thinking: 0, costUsd: 3.4 }),
    ];
    const split = threadCostSplit({ modelSelection: opus }, turns, { providers: {} });
    expect(split.totalUsd).toBeCloseTo(3.4, 9);
    expect(split.byModel.map((row) => [row.model, row.costUsd, row.turns])).toEqual([
      ["claude-opus-5-5", expect.closeTo(3, 9), 2],
      ["claude-sonnet-5-5", expect.closeTo(0.4, 9), 1],
    ]);
    // The invariant every client leans on: the rows and the total cannot disagree.
    expect(split.byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(split.totalUsd!, 9);
    expect(split).toMatchObject({ pricedTurns: 3, unpricedTurns: 0, reported: true, estimated: false });
    // The flat total is the same figure, since both come from one pass over the turns.
    expect(threadCostUsd({ modelSelection: opus }, turns, { providers: {} })).toBe(split.totalUsd);
  });

  it("keeps a model with no price unpriced and flags the total partial, never counting it as zero", () => {
    const priced = { instanceId: "chatgpt/default", model: "gpt-6.2-sol" };
    const unpriced = { instanceId: "antigravity/default", model: "gpt-oss-120b-medium" };
    const turns = [
      storedTurn("p1", priced, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 }), // $2.00
      storedTurn("u1", unpriced, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 }),
      storedTurn("u2", unpriced, null),
    ];
    const split = threadCostSplit({ modelSelection: priced }, turns, { providers: {} });
    expect(split.totalUsd).toBeCloseTo(2, 9);
    expect(split).toMatchObject({ pricedTurns: 1, unpricedTurns: 2, estimated: true, reported: false });
    expect(split.byModel.find((row) => row.model === "gpt-oss-120b-medium")).toEqual({
      model: "gpt-oss-120b-medium",
      costUsd: null,
      turns: 2,
      unpricedTurns: 2,
    });
    // A turn that reported nothing is not free either: the total covers only the rest.
    expect(split.byModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBeCloseTo(2, 9);

    // Nothing priceable at all: null, not $0.
    const nothing = threadCostSplit({ modelSelection: unpriced }, [turns[1]!], { providers: {} });
    expect(nothing.totalUsd).toBeNull();
    expect(nothing.unpricedTurns).toBe(1);
  });

  it("takes a provider's reported cost over Moxen's price for the same turn", () => {
    const claude = { instanceId: "claude/default", model: "claude-opus-5-5" };
    // 1M input at $4/M would price at $4.00; the provider said $2.50, and it wins.
    const reported = storedTurn("r1", claude, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0, costUsd: 2.5 });
    const split = threadCostSplit({ modelSelection: claude }, [reported], { providers: {} });
    expect(split.totalUsd).toBeCloseTo(2.5, 9);
    expect(split).toMatchObject({ reported: true, estimated: false });

    const estimated = threadCostSplit({ modelSelection: claude }, [storedTurn("e1", claude, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 })], { providers: {} });
    expect(estimated.totalUsd).toBeCloseTo(4, 9);
    expect(estimated).toMatchObject({ reported: false, estimated: true });
  });

  it("leaves out a turn still queued and reports an empty thread as no cost", () => {
    const chatgpt = { instanceId: "chatgpt/default", model: "gpt-6.2-sol" };
    const queued = storedTurn("q1", chatgpt, { input: 1_000_000, cacheRead: 0, cacheCreate: 0, output: 0, thinking: 0 }, "queued");
    expect(threadCostSplit({ modelSelection: chatgpt }, [queued], { providers: {} })).toEqual(emptyThreadCost());
  });
});
