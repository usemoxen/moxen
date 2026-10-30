import { describe, expect, it } from "vitest";

import { MIN_CELL_COLUMNS, gridCellWidth, gridColumnsThatFit, splitColumns } from "../uilayout.js";

describe("splitColumns", () => {
  it.each([
    [80, [1, 1], 1, [40, 39]],
    [80, [2, 1], 1, [53, 26]],
    [60, [1, 1, 1], 2, [19, 19, 18]],
  ])("shares %i cells by %j with a gap of %i so the widths and the gaps fill the room", (total, weights, gap, expected) => {
    const widths = splitColumns(total, weights, gap);
    expect(widths).toEqual(expected);
    expect(widths!.reduce((all, width) => all + width, 0) + gap * (weights.length - 1)).toBe(total);
  });

  it("gives the leftover cells to the heaviest child first, then the earlier one", () => {
    expect(splitColumns(35, [1, 3], 0, 1)).toEqual([8, 27]);
    expect(splitColumns(31, [1, 1], 0, 1)).toEqual([16, 15]);
  });

  it("returns null when a child would get fewer cells than the minimum, so the container stacks", () => {
    expect(splitColumns(MIN_CELL_COLUMNS * 2 + 1, [1, 1], 1)).not.toBeNull();
    expect(splitColumns(MIN_CELL_COLUMNS * 2, [1, 1], 1)).toBeNull();
    // A light child's share can be the one that falls short.
    expect(splitColumns(60, [1, 6], 1)).toBeNull();
  });
});

describe("grid", () => {
  it("uses fewer columns than asked when the cells would be too narrow", () => {
    expect(gridColumnsThatFit(80, 4, 1)).toBe(4);
    expect(gridColumnsThatFit(50, 4, 1)).toBe(3);
    expect(gridColumnsThatFit(20, 4, 1)).toBe(1);
  });

  it("makes a spanning cell as wide as the columns and gaps it covers, and a row of cells never wider than the room", () => {
    expect(gridCellWidth(80, 3, 1, 1)).toBe(26);
    expect(gridCellWidth(80, 3, 1, 2)).toBe(53);
    expect(gridCellWidth(80, 3, 1, 3)).toBe(80);
    // Three equal cells and their gaps (the 26-wide columns leave one cell over).
    expect(gridCellWidth(79, 3, 1, 1) * 3 + 2).toBeLessThanOrEqual(79);
    // A span past the columns means all of them.
    expect(gridCellWidth(80, 2, 1, 5)).toBe(gridCellWidth(80, 2, 1, 2));
  });
});
