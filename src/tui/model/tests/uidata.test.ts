import { describe, expect, it } from "vitest";

import { barCells, chartLayout, fit, formatValue, progressLayout } from "../uidata.js";

describe("barCells", () => {
  it.each([
    [0, 8, ""],
    [1, 8, "████████"],
    [0.5, 8, "████"],
    [0.5625, 8, "████▌"],
    [0.0625, 8, "▌"],
    [2, 4, "████"],
  ])("draws %f of %i cells as %j", (fraction, width, expected) => {
    expect(barCells(fraction, width)).toBe(expected);
  });

  it("shows a sliver for any value above zero, so a small bar is not mistaken for none", () => {
    expect(barCells(0.0001, 20)).toBe("▏");
    expect(barCells(-1, 20)).toBe("");
  });
});

describe("fit and formatValue", () => {
  it("cuts a long text to the width with an ellipsis, and leaves a short one", () => {
    expect(fit("quarterly revenue", 10)).toBe("quarterly…");
    expect(fit("short", 10)).toBe("short");
    expect(fit("x", 0)).toBe("");
    expect(fit("long", 1)).toBe("…");
  });

  it("writes whole numbers plain and others to two places", () => {
    expect([3, 0, 1200, 0.5, 2.345, 10.1].map(formatValue)).toEqual(["3", "0", "1200", "0.5", "2.35", "10.1"]);
  });
});

describe("chartLayout", () => {
  const bars = [
    { label: "input", value: 120 },
    { label: "output", value: 30 },
    { label: "cache reads", value: 0 },
  ];

  it("scales every bar to the largest, aligns values on the right and gives the bars what is left", () => {
    const layout = chartLayout(bars, 40, "k");
    expect(layout.labelWidth).toBe(11);
    expect(layout.valueWidth).toBe(4);
    expect(layout.barWidth).toBe(40 - 11 - 4 - 2);
    expect(layout.rows.map((row) => row.bar.length)).toEqual([23, 6, 0]);
    expect(layout.rows[0]!.value).toBe("120k");
  });

  it("scales to a given max, so bars past it fill the row and no more", () => {
    const layout = chartLayout([{ label: "a", value: 50 }, { label: "b", value: 500 }], 30, "", 100);
    expect(layout.rows[0]!.bar.length).toBeCloseTo(layout.barWidth / 2, 0);
    expect(layout.rows[1]!.bar).toBe("█".repeat(layout.barWidth));
  });

  it("keeps the label column to a share of a narrow pane and cuts the labels in it", () => {
    const layout = chartLayout([{ label: "a very long label indeed", value: 3 }], 30);
    expect(layout.labelWidth).toBe(12);
    expect(layout.rows[0]!.label).toBe("a very long…");
  });

  it("drops the values before the bars get too short, then shrinks the labels", () => {
    const narrow = chartLayout([{ label: "tests", value: 12345 }], 16);
    expect(narrow.valueWidth).toBe(0);
    expect(narrow.rows[0]!.value).toBe("");
    const tiny = chartLayout([{ label: "tests passed in total", value: 1 }], 12);
    expect(tiny.barWidth).toBeGreaterThanOrEqual(5);
    expect(tiny.labelWidth + tiny.barWidth + 1).toBeLessThanOrEqual(12);
  });

  it("draws nothing for bars when every value is zero", () => {
    expect(chartLayout([{ label: "a", value: 0 }], 30).rows[0]!.bar).toBe("");
  });
});

describe("progressLayout", () => {
  it("puts the label, the bar, the percentage and the reply's words in one row", () => {
    const layout = progressLayout("Tests", 0.42, "38 of 90", 60);
    expect(layout.stackedLabel).toBeNull();
    expect(layout.label).toBe("Tests");
    expect(layout.right).toBe("42% 38 of 90");
    expect(layout.barWidth).toBe(60 - 5 - 12 - 2);
    expect(layout.bar.length).toBe(Math.ceil(layout.barWidth * 0.42));
  });

  it("puts the label above the bar when the row is too narrow to share", () => {
    const layout = progressLayout("Integration tests", 1, undefined, 20);
    expect(layout.stackedLabel).toBe("Integration tests");
    expect(layout.right).toBe("100%");
    expect(layout.barWidth).toBe(20 - 4 - 1);
    expect(layout.bar).toBe("█".repeat(15));
    // A label that fits its share stays beside the bar, even in a narrow row.
    expect(progressLayout("Tests", 1, undefined, 20).stackedLabel).toBeNull();
  });

  it("clamps what is out of range", () => {
    expect(progressLayout("x", 0, undefined, 40).right).toBe("0%");
    expect(progressLayout("x", 0, undefined, 40).bar).toBe("");
  });
});
