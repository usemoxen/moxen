import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "../markdownblocks.js";

describe("splitting markdown into TUI blocks", () => {
  it("leaves content without a quote or table-holding list whole, as one text block", () => {
    const text = "# title\n\nsome `code` and a [link](https://x.y)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n- not a list\n```\n\n- plain item\n- [x] task item\n- [ ] todo item";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("cuts a list holding a table into its own block, table lines verbatim", () => {
    const text = "intro\n\n- item one\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\noutro";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text: "intro", gapBefore: false },
      { kind: "list", text: "- item one\n  | a | b |\n  |---|---|\n  | 1 | 2 |", gapBefore: true },
      { kind: "text", text: "outro", gapBefore: true },
    ]);
  });

  it("cuts an ordered list holding a table, keeping the list's own numbering", () => {
    const text = "10. tenth\n    | x | y |\n    |---|---|\n    | 3 | 4 |\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "list", text: "10. tenth\n    | x | y |\n    |---|---|\n    | 3 | 4 |", gapBefore: false },
      { kind: "text", text: "after", gapBefore: true },
    ]);
  });

  it("rewrites task-list checkboxes into ballot boxes for the structural renderer, checked and unchecked", () => {
    const text = "- [x] done item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- [ ] todo item\n- [X] also done";
    expect(splitMarkdownBlocks(text)).toEqual([
      {
        kind: "list",
        text: "- ☒ done item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- ☐ todo item\n- ☒ also done",
        gapBefore: false,
      },
    ]);
  });

  it("keeps a task list without a table in the text run, markers untouched", () => {
    const text = "notes\n\n- [x] finished\n- [ ] pending";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("keeps numbered prose a single paragraph: a list starting at 2 cannot interrupt it", () => {
    const text = "Step number follows on this line\n2. this is still paragraph text\n9. these are literal numbers";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("keeps an ordered list that starts a block in the text run, numbering untouched", () => {
    const text = "1. one\n2. two\n\npara";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("cuts a blockquote out with its `>` markers stripped, table lines intact", () => {
    const text = "before\n\n> quoted\n> | q | r |\n> |---|---|\n> | 5 | 6 |\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "text", text: "before", gapBefore: false },
      { kind: "quote", inner: "quoted\n| q | r |\n|---|---|\n| 5 | 6 |", gapBefore: true },
      { kind: "text", text: "after", gapBefore: true },
    ]);
  });

  it("strips only one quote level, so a nested quote recurses", () => {
    expect(splitMarkdownBlocks("> outer\n> > deep")).toEqual([
      { kind: "quote", inner: "outer\n> deep", gapBefore: false },
    ]);
  });

  it("ends a quote at a fenced block: prose after the fence is not lazily quoted", () => {
    const text = "> ```\n> fenced text\nOutside the quote";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "quote", inner: "```\nfenced text\n", gapBefore: false },
      { kind: "text", text: "Outside the quote", gapBefore: false },
    ]);
  });

  it("keeps a lazy paragraph line inside the quote", () => {
    const text = "> quoted\nlazy line\n\nplain";
    expect(splitMarkdownBlocks(text)).toEqual([
      { kind: "quote", inner: "quoted\nlazy line", gapBefore: false },
      { kind: "text", text: "plain", gapBefore: true },
    ]);
  });

  it("never mangles a fenced code block: markers, quotes and table rows inside stay in the text run verbatim", () => {
    const text = "para\n\n```\n- not a list\n> not a quote\n| not | a table |\n|---|---|\n```\n\n- real list";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("treats an unclosed fence (mid-stream) as running to the end", () => {
    const text = "text\n\n```\n| a | b |\n|---|---|\n- still code";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "text", text, gapBefore: false }]);
  });

  it("handles a 4-space fence under a `10.` item and an unclosed list fence via the parser, not heuristics", () => {
    const deep = "10. item\n    ```\n    code line\n    ```";
    expect(splitMarkdownBlocks(deep)).toEqual([{ kind: "text", text: deep, gapBefore: false }]);
    const deepWithTable = "10. item\n    ```\n    | not | a table |\n    |---|---|\n    ```\n    | x | y |\n    |---|---|\n    | 1 | 2 |";
    expect(splitMarkdownBlocks(deepWithTable)).toEqual([{ kind: "list", text: deepWithTable, gapBefore: false }]);
    const unclosed = "- item\n  ```\n  code to end";
    expect(splitMarkdownBlocks(unclosed)).toEqual([{ kind: "text", text: unclosed, gapBefore: false }]);
  });

  it("marks the gap before a block only when a blank line separates it, not for a single newline", () => {
    expect(splitMarkdownBlocks("intro\n- item\n  | a |\n  |---|")).toEqual([
      { kind: "text", text: "intro", gapBefore: false },
      { kind: "list", text: "- item\n  | a |\n  |---|", gapBefore: false },
    ]);
    expect(splitMarkdownBlocks("intro\n\n- item\n  | a |\n  |---|")).toEqual([
      { kind: "text", text: "intro", gapBefore: false },
      { kind: "list", text: "- item\n  | a |\n  |---|", gapBefore: true },
    ]);
  });

  it("finds a table nested in a blockquote inside a list item", () => {
    const text = "- item\n  > | a |\n  > |---|\n  > | 1 |";
    expect(splitMarkdownBlocks(text)).toEqual([{ kind: "list", text, gapBefore: false }]);
  });
});
