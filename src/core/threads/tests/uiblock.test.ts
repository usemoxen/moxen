import { describe, expect, it } from "vitest";

import { UI_BLOCK_LIMITS, parseUiBlock, splitUiBlocks } from "../uiblock.js";

const image = (src = "/tmp/a.png", extra: Record<string, unknown> = {}) => ({ type: "image", src, ...extra });
const block = (root: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, root, ...extra });
const fenced = (json: string, fence = "```") => `${fence}moxen-ui\n${json}\n${fence}`;

describe("parseUiBlock", () => {
  it("reads a row of two images with weights, captions and defaults filled in", () => {
    expect(
      parseUiBlock(block({ type: "row", children: [image("/a.png", { caption: "Before", weight: 2 }), image("/b.png", { alt: "after" })] })),
    ).toEqual({
      v: 1,
      root: {
        type: "row",
        gap: 1,
        children: [
          { type: "image", src: "/a.png", alt: "", caption: "Before", ops: [], weight: 2 },
          { type: "image", src: "/b.png", alt: "after", ops: [] },
        ],
      },
    });
  });

  it("nests a grid in a column and keeps a span", () => {
    const parsed = parseUiBlock(
      block({ type: "column", children: [{ type: "text", text: "Four shots" }, { type: "grid", columns: 2, children: [image("/a.png", { span: 2 }), image("/b.png")] }] }),
    );
    expect(parsed?.root).toMatchObject({ type: "column", children: [{ type: "text" }, { type: "grid", columns: 2, children: [{ span: 2 }, {}] }] });
  });

  it("reads image operations in order, with shapes defaulting to red", () => {
    const ops = [
      { op: "crop", x: 0.25, y: 0, w: 0.5, h: 0.5 },
      { op: "pad", aspect: 1.5 },
      { op: "annotate", shapes: [{ shape: "box", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { shape: "arrow", x1: 0, y1: 0, x2: 0.5, y2: 0.5, color: "yellow" }, { shape: "highlight", x: 0.5, y: 0.5, w: 0.5, h: 0.5, color: "green" }] },
    ];
    const parsed = parseUiBlock(block(image("/a.png", { ops })));
    expect(parsed?.root).toMatchObject({ type: "image", ops });
    expect((parsed!.root as { ops: { shapes?: { color: string }[] }[] }).ops[2]!.shapes!.map((one) => one.color)).toEqual(["red", "yellow", "green"]);
  });

  it("reads a blend of two images, counting both against the image cap", () => {
    const parsed = parseUiBlock(block({ type: "blend", mode: "difference", a: image("/a.png"), b: image("/b.png", { ops: [{ op: "pad", aspect: 1 }] }), caption: "What changed" }));
    expect(parsed?.root).toMatchObject({ type: "blend", mode: "difference", opacity: 0.5, caption: "What changed", a: { src: "/a.png" }, b: { src: "/b.png" } });
    const blends = Array.from({ length: UI_BLOCK_LIMITS.images / 2 + 1 }, () => ({ type: "blend", mode: "overlay", a: image("/a.png"), b: image("/b.png") }));
    expect(parseUiBlock(block({ type: "column", children: blends }))).toBeNull();
  });

  it("reads each data component, leaving out what it was not given", () => {
    const parsed = parseUiBlock(
      block({
        type: "column",
        children: [
          { type: "chart", kind: "bar", title: "Tokens", unit: "k", bars: [{ label: "input", value: 120, color: "blue" }, { label: "output", value: 30 }] },
          { type: "progress", label: "Tests", value: 0.42, text: "38 of 90" },
          { type: "keyvalue", rows: [{ key: "branch", value: "main" }] },
          { type: "status", title: "CI", rows: [{ label: "build", state: "done" }, { label: "deploy", state: "held", note: "waiting on approval" }] },
        ],
      }),
    );
    expect(parsed?.root).toEqual({
      type: "column",
      gap: 1,
      children: [
        { type: "chart", kind: "bar", title: "Tokens", unit: "k", bars: [{ label: "input", value: 120, color: "blue" }, { label: "output", value: 30 }] },
        { type: "progress", label: "Tests", value: 0.42, text: "38 of 90" },
        { type: "keyvalue", rows: [{ key: "branch", value: "main" }] },
        { type: "status", title: "CI", rows: [{ label: "build", state: "done" }, { label: "deploy", state: "held", note: "waiting on approval" }] },
      ],
    });
  });

  it("allows a bar past the chart's max, and a max alone sets the scale", () => {
    expect(parseUiBlock(block({ type: "chart", kind: "bar", max: 10, bars: [{ label: "a", value: 12 }] }))?.root).toMatchObject({ max: 10 });
  });

  it("refuses more bars or rows than the caps, and a label over its cap", () => {
    const bars = (count: number) => Array.from({ length: count }, (_, at) => ({ label: `b${at}`, value: at }));
    expect(parseUiBlock(block({ type: "chart", kind: "bar", bars: bars(UI_BLOCK_LIMITS.bars) }))).not.toBeNull();
    expect(parseUiBlock(block({ type: "chart", kind: "bar", bars: bars(UI_BLOCK_LIMITS.bars + 1) }))).toBeNull();
    const rows = Array.from({ length: UI_BLOCK_LIMITS.rows + 1 }, (_, at) => ({ key: `k${at}`, value: "v" }));
    expect(parseUiBlock(block({ type: "keyvalue", rows }))).toBeNull();
    expect(parseUiBlock(block({ type: "keyvalue", rows: rows.slice(0, UI_BLOCK_LIMITS.rows) }))).not.toBeNull();
    expect(parseUiBlock(block({ type: "progress", label: "x".repeat(UI_BLOCK_LIMITS.label + 1), value: 0.5 }))).toBeNull();
  });

  it("ignores fields it does not know, so a later version can add one", () => {
    expect(parseUiBlock(block(image("/a.png", { future: true }), { note: "x" }))?.root).toMatchObject({ type: "image", src: "/a.png" });
  });

  it.each([
    ["not JSON", "{ nope"],
    ["a newer version", block(image(), { v: 2 })],
    ["no version", JSON.stringify({ root: image() })],
    ["an unknown node type", block({ type: "carousel", children: [image()] })],
    ["a container with no children", block({ type: "row", children: [] })],
    ["a grid child wider than the grid", block({ type: "grid", columns: 2, children: [image("/a.png", { span: 3 })] })],
    ["a weight of zero", block({ type: "row", children: [image("/a.png", { weight: 0 })] })],
    ["an image from a URL", block(image("https://example.com/a.png"))],
    ["an image from a data URL", block(image("data:image/png;base64,AAAA"))],
    ["an image with no path", block(image("  "))],
    ["an operation with no name", block(image("/a.png", { ops: [{ x: 1 }] }))],
    ["an operation it does not know", block(image("/a.png", { ops: [{ op: "sharpen" }] }))],
    ["a crop past the image's edge", block(image("/a.png", { ops: [{ op: "crop", x: 0.6, y: 0, w: 0.5, h: 1 }] }))],
    ["a crop with no area", block(image("/a.png", { ops: [{ op: "crop", x: 0, y: 0, w: 0, h: 1 }] }))],
    ["a crop in pixels", block(image("/a.png", { ops: [{ op: "crop", x: 10, y: 0, w: 50, h: 20 }] }))],
    ["a pad to an extreme shape", block(image("/a.png", { ops: [{ op: "pad", aspect: 40 }] }))],
    ["an annotation with no shapes", block(image("/a.png", { ops: [{ op: "annotate", shapes: [] }] }))],
    ["an annotation colour it does not know", block(image("/a.png", { ops: [{ op: "annotate", shapes: [{ shape: "box", x: 0, y: 0, w: 0.5, h: 0.5, color: "#ff0000" }] }] }))],
    ["a chart of a kind it does not know", block({ type: "chart", kind: "pie", bars: [{ label: "a", value: 1 }] })],
    ["a chart with no bars", block({ type: "chart", kind: "bar", bars: [] })],
    ["a bar with a negative value", block({ type: "chart", kind: "bar", bars: [{ label: "a", value: -1 }] })],
    ["a bar with a value that is not a number", block({ type: "chart", kind: "bar", bars: [{ label: "a", value: "3" }] })],
    ["a bar with no label", block({ type: "chart", kind: "bar", bars: [{ value: 3 }] })],
    ["a chart whose max is zero", block({ type: "chart", kind: "bar", max: 0, bars: [{ label: "a", value: 1 }] })],
    ["a progress past 1", block({ type: "progress", label: "tests", value: 1.5 })],
    ["a progress with no label", block({ type: "progress", value: 0.5 })],
    ["a key-value list with no rows", block({ type: "keyvalue", rows: [] })],
    ["a key-value row with no key", block({ type: "keyvalue", rows: [{ value: "x" }] })],
    ["a status row in a state it does not know", block({ type: "status", rows: [{ label: "build", state: "green" }] })],
    ["a status row with no label", block({ type: "status", rows: [{ state: "done" }] })],
    ["a blend of something that is not an image", block({ type: "blend", mode: "overlay", a: image("/a.png"), b: { type: "text", text: "x" } })],
    ["a blend with a mode it does not know", block({ type: "blend", mode: "multiply", a: image("/a.png"), b: image("/b.png") })],
  ])("is not a block for %s", (_name, json) => {
    expect(parseUiBlock(json)).toBeNull();
  });

  describe("caps", () => {
    const row = (children: unknown[]) => ({ type: "row", children });
    const nested = (depth: number): unknown => (depth <= 1 ? image() : row([nested(depth - 1)]));

    it("allows the deepest nesting and refuses one level more", () => {
      expect(parseUiBlock(block(nested(UI_BLOCK_LIMITS.depth)))).not.toBeNull();
      expect(parseUiBlock(block(nested(UI_BLOCK_LIMITS.depth + 1)))).toBeNull();
    });

    it("refuses more images than the cap, and more nodes than the cap", () => {
      const images = (count: number) => Array.from({ length: count }, (_, at) => image(`/${at}.png`));
      const many = (count: number) => block({ type: "column", children: [row(images(count)), row(images(count))] });
      expect(parseUiBlock(block(row(images(UI_BLOCK_LIMITS.images))))).not.toBeNull();
      expect(parseUiBlock(block(row(images(UI_BLOCK_LIMITS.images + 1))))).toBeNull();
      // Two rows of eight images pass the node cap but not the image cap; a tall tree of texts is the node cap.
      expect(parseUiBlock(many(UI_BLOCK_LIMITS.images))).toBeNull();
      const texts = Array.from({ length: UI_BLOCK_LIMITS.nodes }, () => ({ type: "text", text: "x" }));
      const chunks = [0, 1, 2, 3].map((at) => row(texts.slice(at * 10, at * 10 + 10)));
      expect(parseUiBlock(block({ type: "column", children: chunks }))).toBeNull();
    });

    it("refuses more children than one container may hold", () => {
      const texts = Array.from({ length: UI_BLOCK_LIMITS.children + 1 }, () => ({ type: "text", text: "x" }));
      expect(parseUiBlock(block(row(texts)))).toBeNull();
    });

    it("refuses a block over the size cap, and a text over the text cap", () => {
      expect(parseUiBlock(block(image("/a.png", { caption: "x".repeat(UI_BLOCK_LIMITS.bytes) })))).toBeNull();
      expect(parseUiBlock(block({ type: "text", text: "x".repeat(UI_BLOCK_LIMITS.text + 1) }))).toBeNull();
    });
  });
});

describe("splitUiBlocks", () => {
  const pair = block({ type: "row", children: [image("/a.png"), image("/b.png")] });

  it("returns text with no block as one markdown segment, untouched", () => {
    expect(splitUiBlocks("Just prose.\n\n```ts\nconst a = 1;\n```")).toEqual([{ kind: "markdown", text: "Just prose.\n\n```ts\nconst a = 1;\n```" }]);
  });

  it("cuts a block out of the text around it, keeping every other line", () => {
    const segments = splitUiBlocks(`Before.\n\n${fenced(pair)}\n\nAfter.`);
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "ui", "markdown"]);
    expect(segments[0]).toEqual({ kind: "markdown", text: "Before.\n" });
    expect(segments[2]).toEqual({ kind: "markdown", text: "\nAfter." });
  });

  it("reads two blocks in one reply, and a longer fence or a ~~~ fence", () => {
    const segments = splitUiBlocks(`${fenced(pair, "````")}\nbetween\n${fenced(pair, "~~~")}`);
    expect(segments.map((segment) => segment.kind)).toEqual(["ui", "markdown", "ui"]);
  });

  it("leaves a block that is not valid as the code it is, closing fence included", () => {
    const bad = fenced("{ nope");
    const text = `Look:\n${bad}\nStill here.`;
    expect(splitUiBlocks(text)).toEqual([{ kind: "markdown", text }]);
  });

  it("leaves a block that is still streaming as code, and keeps the text after it out of a block", () => {
    const open = `Look:\n\`\`\`moxen-ui\n{"v":1,"root":`;
    expect(splitUiBlocks(open)).toEqual([{ kind: "markdown", text: open }]);
  });

  it("does not take a moxen-ui fence shown inside another code fence for a block", () => {
    const example = `\`\`\`\`markdown\n${fenced(pair)}\n\`\`\`\`\nDone.`;
    expect(splitUiBlocks(example)).toEqual([{ kind: "markdown", text: example }]);
  });

  it("does not take a moxen-ui block whose fence closes with a shorter one for closed", () => {
    const text = `\`\`\`\`moxen-ui\n${pair}\n\`\`\`\nmore`;
    expect(splitUiBlocks(text)).toEqual([{ kind: "markdown", text }]);
  });
});
