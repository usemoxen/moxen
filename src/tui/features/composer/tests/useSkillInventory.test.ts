import { describe, expect, it } from "vitest";

import { isStale, STALE_MS } from "../useSkillInventory.js";

describe("isStale", () => {
  it("trusts an answer for a while, then asks again", () => {
    expect(isStale(1_000, 1_000)).toBe(false);
    expect(isStale(1_000, 1_000 + STALE_MS - 1)).toBe(false);
    expect(isStale(1_000, 1_000 + STALE_MS)).toBe(true);
  });
});
