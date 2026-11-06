import { describe, expect, it } from "vitest";

import { formatPriceMap, normalizePriceMap, parsePriceMap } from "../modelprices.js";

const LABEL = "providers.codex.modelInputPrices";

describe("model price maps", () => {
  it("round-trips model=price pairs, one per line or comma-separated", () => {
    const map = { "gpt-6.1-sol": 2, "opencode-go/muse-spark-1.3-contributor": 1.5 };
    expect(parsePriceMap(formatPriceMap(map), LABEL)).toEqual(map);
    expect(parsePriceMap("gpt-6.1-sol=2, opencode-go/muse-spark-1.3-contributor=1.5", LABEL)).toEqual(map);
    expect(parsePriceMap("", LABEL)).toEqual({});
  });

  it("rejects a negative price, and anything that is not a number", () => {
    expect(() => parsePriceMap("gpt-6.1-sol=-1", LABEL)).toThrow("must be a price in USD per million tokens, zero or more");
    expect(() => parsePriceMap("gpt-6.1-sol=many", LABEL)).toThrow("must be a price in USD per million tokens, zero or more");
    expect(() => parsePriceMap("gpt-6.1-sol=", LABEL)).toThrow("must be a price in USD per million tokens, zero or more");
    expect(() => parsePriceMap("=2", LABEL)).toThrow("takes model=price pairs");
  });

  it("reads the file's object form, with numbers or numeric text", () => {
    expect(normalizePriceMap({ "gpt-6.1-sol": 2, "other": "1.5" }, LABEL)).toEqual({ "gpt-6.1-sol": 2, "other": 1.5 });
    expect(normalizePriceMap("gpt-6.1-sol=2", LABEL)).toEqual({ "gpt-6.1-sol": 2 });
    expect(normalizePriceMap({}, LABEL)).toBeUndefined();
    expect(() => normalizePriceMap({ "gpt-6.1-sol": -2 }, LABEL)).toThrow("zero or more");
    expect(() => normalizePriceMap({ "gpt-6.1-sol": true }, LABEL)).toThrow("must be a price");
  });
});
