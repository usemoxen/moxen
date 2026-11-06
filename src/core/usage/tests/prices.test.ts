import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_PRICES, modelPriceFor, priceUsage, usageCost, type ModelPrice } from "../prices.js";

const usage = { input: 1e6, cacheRead: 1e6, cacheCreate: 1e6, output: 1e6, thinking: 1e6 };

describe("model prices", () => {
  it("prices a model the user set, even one the shipped list never heard of", () => {
    const config = { providers: { opencode: { modelInputPrices: { "opencode-go/muse-spark-1.3-contributor": 2 }, modelOutputPrices: { "opencode-go/muse-spark-1.3-contributor": 10 } } } };
    const price = modelPriceFor(config, "opencode", "opencode-go/muse-spark-1.3-contributor");
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
});
