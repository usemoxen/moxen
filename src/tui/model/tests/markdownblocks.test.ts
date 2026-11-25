import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "../markdownblocks.js";

describe("splitting markdown into TUI blocks", () => {
  it("leaves content without a list or blockquote whole, as one text block", () => {
    const text = "# title\n\nsome `code` and a [link](https://x.y)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n- not a list\n```";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("cuts an unordered list holding a table into its own block, table lines verbatim", () => {
    const text = "intro\n\n- item one\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\noutro";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text: "intro\n", gapBefore: false },
      { kind: "list", text: "- item one\n  | a | b |\n  |---|---|\n  | 1 | 2 |", gapBefore: true },
      { kind: "text", text: "\noutro", gapBefore: true },
    ]);
  });

  it("cuts an ordered list holding a table, and keeps a following paragraph out of the list", () => {
    const text = "1. first\n   | x | y |\n   |---|---|\n   | 3 | 4 |\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "list", text: "1. first\n   | x | y |\n   |---|---|\n   | 3 | 4 |", gapBefore: false },
      { kind: "text", text: "\nafter", gapBefore: true },
    ]);
  });

  it("keeps a lazy continuation line inside the list, but a blank line then text ends it", () => {
    const text = "- item\n  continued\n\nplain paragraph\n\n- second";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "list", text: "- item\n  continued", gapBefore: false },
      { kind: "text", text: "\nplain paragraph\n", gapBefore: true },
      { kind: "list", text: "- second", gapBefore: true },
    ]);
  });

  it("merges list items across a blank line into one loose list", () => {
    expect(splitMarkdownBlocks("- a\n\n- b")).toEqual([{ kind: "list", text: "- a\n\n- b", gapBefore: false }]);
  });

  it("ends a list at a top-level table so the table stays renderable", () => {
    const text = "- item\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "list", text: "- item", gapBefore: false },
      { kind: "text", text: "\n| a | b |\n|---|---|\n| 1 | 2 |", gapBefore: true },
    ]);
  });

  it("cuts a blockquote out with its `>` markers stripped, table lines intact", () => {
    const text = "before\n\n> quoted\n> | q | r |\n> |---|---|\n> | 5 | 6 |\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text: "before\n", gapBefore: false },
      { kind: "quote", inner: "quoted\n| q | r |\n|---|---|\n| 5 | 6 |", gapBefore: true },
      { kind: "text", text: "\nafter", gapBefore: true },
    ]);
  });

  it("strips only one quote level, so a nested quote recurses", () => {
    expect(splitMarkdownBlocks("> outer\n> > deep")).toEqual([
      { kind: "quote", inner: "outer\n> deep", gapBefore: false },
    ]);
  });

  it("keeps a lazy line in the quote but ends the quote at a blank line", () => {
    const text = "> quoted\nlazy line\n\nplain";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "quote", inner: "quoted\nlazy line", gapBefore: false },
      { kind: "text", text: "\nplain", gapBefore: true },
    ]);
  });

  it("never inspects a fenced code block: markers, quotes and table rows inside stay verbatim in the text block", () => {
    const text = "para\n\n```\n- not a list\n> not a quote\n| not | a table |\n|---|---|\n```\n\n- real list";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text: "para\n\n```\n- not a list\n> not a quote\n| not | a table |\n|---|---|\n```\n", gapBefore: false },
      { kind: "list", text: "- real list", gapBefore: true },
    ]);
  });

  it("treats an unclosed fence (mid-stream) as running to the end", () => {
    const text = "text\n\n```\n| a | b |\n|---|---|\n- still code";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text, gapBefore: false },
    ]);
  });

  it("takes a fence inside a list item verbatim, even when its body looks like markers", () => {
    const text = "- item\n  ```\n  - not a list\n  ```\n- next";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "list", text: "- item\n  ```\n  - not a list\n  ```\n- next", gapBefore: false },
    ]);
  });

  it("does not mistake a thematic break or an emphasis line for a list", () => {
    const text = "para\n\n- - -\n\n*not a list*";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("normalizes CRLF line endings", () => {
    expect(splitMarkdownBlocks("a\r\n\r\n- b\r\n  | x |\r\n  |---|")).toEqual([
      { kind: "text", text: "a\n", gapBefore: false },
      { kind: "list", text: "- b\n  | x |\n  |---|", gapBefore: true },
    ]);
  });
});
