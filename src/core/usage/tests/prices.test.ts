import { describe, expect, it } from "vitest";

import modelsSnapshot from "../../providers/opencode/models-snapshot.json" with { type: "json" };
import { extractOpencodePrices, mergeOpencodePrices } from "../../../../scripts/update-opencode-prices.js";
import {
  DEFAULT_MODEL_PRICES,
  HAND_EDITED_MODEL_PRICES,
  modelPriceFor,
  priceUsage,
  usageCost,
  type ModelPrice,
} from "../prices.js";

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

  it("ships API-equivalent prices for Antigravity's Gemini and Claude models while leaving GPT-OSS unpriced", () => {
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-neon")).toEqual({ input: 3, cacheRead: 0.15, output: 15 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-argon")).toEqual({ input: 2, cacheRead: 0.1, output: 10 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-4-hydrogen")).toEqual({ input: 1.5, cacheRead: 0.075, output: 7.5 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gemini-3.8-flash")).toEqual({ input: 0.75, cacheRead: 0.075, output: 3.75 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "claude-opus-5-5")).toEqual({ input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "claude-sonnet-5-5")).toEqual({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });
    expect(modelPriceFor({ providers: {} }, "antigravity", "gpt-oss-120b-medium")).toBeNull();
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
