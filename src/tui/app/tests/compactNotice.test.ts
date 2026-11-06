import { describe, expect, it } from "vitest";

import { compactNoticeKey } from "../utils.js";

describe("compactNoticeKey", () => {
  it("stays put while the usage figure it shows keeps moving, so the pager keeps its page", () => {
    expect(compactNoticeKey("t1", 100_000)).toBe(compactNoticeKey("t1", 100_001));
    expect(compactNoticeKey("t1", 100_000)).toBe(compactNoticeKey("t1", 199_999));
  });

  it("tells threads apart", () => {
    expect(compactNoticeKey("t1", 100_000)).not.toBe(compactNoticeKey("t2", 100_000));
  });

  it("is null with no open thread or no usage snapshot", () => {
    expect(compactNoticeKey(null, 100_000)).toBeNull();
    expect(compactNoticeKey("t1", null)).toBeNull();
  });
});
