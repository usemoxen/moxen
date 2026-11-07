import { describe, expect, it } from "vitest";

import { middleTruncate } from "../textoverflow.js";

describe("middleTruncate", () => {
  it("leaves a short path whole", () => {
    expect(middleTruncate("/store/threads/demo/turns.jsonl", 60)).toBe("/store/threads/demo/turns.jsonl");
  });

  it("keeps the start and the end of a long path", () => {
    expect(middleTruncate("/store/threads/demo/messages.jsonl:7", 20)).toBe("/store/thr…s.jsonl:7");
  });

  it("leaves room for the ellipsis in a tiny width", () => {
    expect(middleTruncate("abcdefghij", 9)).toBe("abcd…ghij");
    expect(middleTruncate("abcdefghijk", 9)).toBe("abcd…hijk");
  });
});
