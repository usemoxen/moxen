import { describe, expect, it } from "vitest";

import { chipSegments, splitChipBlocks } from "../messagechips.js";

describe("chips in a sent message", () => {
  it("reads an image token and a path link as chips, the link as the padded words it shows", () => {
    expect(chipSegments("see [Image #2] and [📁 out2](</a b/out2>) now")).toEqual([
      { text: "see ", chip: false },
      { text: "[Image #2]", chip: true },
      { text: " and ", chip: false },
      { text: " 📁 out2 ", chip: true },
      { text: " now", chip: false },
    ]);
    expect(chipSegments("plain [link](https://x.y) text")).toEqual([{ text: "plain [link](https://x.y) text", chip: false }]);
  });

  it("leaves a message with no chip to markdown whole", () => {
    expect(splitChipBlocks("# title\n\nsome `code`")).toEqual([{ kind: "markdown", text: "# title\n\nsome `code`" }]);
  });

  it("cuts out only the paragraphs that hold a chip, and never inside a code fence", () => {
    const text = "intro\n\nlook [📄 a.py](/x/a.py)\nand more\n\n```\n[Image #1] in code\n\n[Image #2]\n```\nend";
    expect(splitChipBlocks(text)).toEqual([
      { kind: "markdown", text: "intro\n" },
      { kind: "chips", text: "look [📄 a.py](/x/a.py)\nand more" },
      { kind: "markdown", text: "\n```\n[Image #1] in code\n\n[Image #2]\n```\nend" },
    ]);
  });
});
