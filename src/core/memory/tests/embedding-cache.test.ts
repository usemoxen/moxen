import { describe, expect, it } from "vitest";
import { cachedVector, embeddingKey, EMBEDDING_DIMENSIONS } from "../embedding-cache.js";

describe("memory embedding cache", () => {
  it("rejects stale, incompatible and invalid vectors", () => {
    const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = 1;
    const record = { key: embeddingKey("original"), vector };
    expect(cachedVector(record, "original")).toEqual(vector);
    expect(cachedVector(record, "edited")).toBeNull();
    expect(cachedVector({ ...record, key: "older-model" }, "original")).toBeNull();
    expect(cachedVector({ ...record, vector: [1] }, "original")).toBeNull();
    expect(cachedVector({ ...record, vector: vector.map(() => NaN) }, "original")).toBeNull();
    expect(cachedVector({ ...record, vector: vector.map(() => 0) }, "original")).toBeNull();
  });
});
