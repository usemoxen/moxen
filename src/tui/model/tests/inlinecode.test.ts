import { describe, expect, it } from "vitest";

import { splitInlineCode } from "../inlinecode.js";

describe("splitInlineCode", () => {
  it("takes what is between a pair of backticks as code, without the backticks", () => {
    expect(splitInlineCode("Runs `claude update`. Sessions keep the old build.")).toEqual([
      { text: "Runs ", code: false },
      { text: "claude update", code: true },
      { text: ". Sessions keep the old build.", code: false },
    ]);
  });

  it("handles several, one at either end, and none", () => {
    expect(splitInlineCode("`a` and `b`").map((segment) => segment.text)).toEqual(["a", " and ", "b"]);
    expect(splitInlineCode("plain")).toEqual([{ text: "plain", code: false }]);
    expect(splitInlineCode("")).toEqual([]);
  });

  it("leaves a backtick with no partner alone, and drops an empty pair", () => {
    expect(splitInlineCode("odd ` one")).toEqual([{ text: "odd ` one", code: false }]);
    expect(splitInlineCode("a `` b")).toEqual([
      { text: "a ", code: false },
      { text: " b", code: false },
    ]);
  });
});
