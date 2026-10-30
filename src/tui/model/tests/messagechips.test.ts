import { describe, expect, it } from "vitest";

import { chipSegments, splitChipBlocks, splitReplyImages } from "../messagechips.js";

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

describe("images a reply shows", () => {
  it("cuts a line that is a local markdown image into its own block, and leaves URLs, inline images and code to markdown", () => {
    const text = "Here it is:\n![the chart](/tmp/chart.png)\nand a web one:\n![logo](https://x.y/a.png)\nin text ![inline](/tmp/a.png) too\n```\n![code](/tmp/b.png)\n```";
    expect(splitReplyImages(text)).toEqual([
      { kind: "markdown", text: "Here it is:" },
      { kind: "image", alt: "the chart", path: "/tmp/chart.png" },
      { kind: "markdown", text: "and a web one:\n![logo](https://x.y/a.png)\nin text ![inline](/tmp/a.png) too\n```\n![code](/tmp/b.png)\n```" },
    ]);
    expect(splitReplyImages("no images")).toEqual([{ kind: "markdown", text: "no images" }]);
  });

  it("reads a Windows path with a drive letter as local, not as a URL", () => {
    expect(splitReplyImages("![a](C:\\Users\\me\\a.png)")).toEqual([{ kind: "image", alt: "a", path: "C:\\Users\\me\\a.png" }]);
  });
});
