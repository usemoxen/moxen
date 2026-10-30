import { describe, expect, it } from "vitest";

import { CARD, DEFAULT_CARD_PALETTE, heatCellRect, isCardPalette, rangeLabel, renderStatsCard, type CardPalette } from "../card.js";
import { drawText, textWidth } from "../pixelfont.js";
import { Canvas, rgb } from "../png.js";
import { type StatsThreadInput, computeUsageStats } from "../stats.js";
import { decodePng } from "./pngdecode.js";

// A Thursday.
const NOW = new Date(2026, 9, 29, 12, 0, 0);
const daysAgo = (days: number) => new Date(2026, 9, 29 - days, 10).toISOString();

function input(days: readonly number[]): StatsThreadInput[] {
  const selection = { instanceId: "opencode", model: "x" };
  return [
    {
      thread: { id: "a", modelSelection: selection },
      turns: days.map((back, index) => ({
        id: `t${index}`, threadId: "a", status: "completed" as const, delivery: "started" as const, messageId: "m", runtimeMode: "full-access" as const,
        interactionMode: "default" as const, modelSelection: selection, parentTurnId: null, error: null,
        usage: { input: 1_000, cacheRead: 0, cacheCreate: 0, output: 500, thinking: 0 },
        createdAt: daysAgo(back), updatedAt: daysAgo(back), completedAt: daysAgo(back),
      })),
      messages: [],
    },
  ];
}

const cardOf = (range: "all" | "7d", days: readonly number[]) => {
  const data = input(days);
  return decodePng(renderStatsCard(computeUsageStats(data, range, NOW), computeUsageStats(data, "all", NOW), NOW));
};

describe("stats card", () => {
  it("is a valid PNG of the card's size", () => {
    const card = cardOf("all", [0, 1, 2]);
    expect([card.width, card.height]).toEqual([CARD.width, CARD.height]);
    expect(card.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("is drawn the same every time for the same numbers", () => {
    const data = input([0, 1, 5]);
    const draw = () => renderStatsCard(computeUsageStats(data, "all", NOW), computeUsageStats(data, "all", NOW), NOW);
    expect([...draw()]).toEqual([...draw()]);
  });

  it("paints today's square in the busiest colour and leaves a day nothing happened as a faint dot", () => {
    const card = cardOf("all", [0, 2]);
    // Today (Thursday, the last week's fourth row) is the busiest day; two days earlier is just as busy.
    const today = heatCellRect(CARD.weeks - 1, 3);
    expect(card.pixel(Math.round(today.x + 2), Math.round(today.y + 2))).toEqual([0x8a, 0xd8, 0xff]);
    // Wednesday had nothing: a dot in the middle of its cell, not a square.
    const quiet = heatCellRect(CARD.weeks - 1, 2);
    expect(card.pixel(Math.round(quiet.x + 1), Math.round(quiet.y + 1))).toEqual([0x0e, 0x0e, 0x12]);
    expect(card.pixel(Math.round(quiet.x + quiet.size / 2), Math.round(quiet.y + quiet.size / 2))).toEqual([0x24, 0x24, 0x2c]);
  });

  it("keeps a day before the range as a grey square when the card is for a shorter range", () => {
    const card = cardOf("7d", [0, 20]);
    // Twenty days back is a Friday... find its cell by counting back from today's.
    const week = CARD.weeks - 1 - Math.floor((20 - 3) / 7) - 1;
    const twenty = heatCellRect(week, (3 - 20 + 7 * 3) % 7);
    expect(card.pixel(Math.round(twenty.x + 2), Math.round(twenty.y + 2))).toEqual([0x4a, 0x4a, 0x55]);
    const today = heatCellRect(CARD.weeks - 1, 3);
    expect(card.pixel(Math.round(today.x + 2), Math.round(today.y + 2))).toEqual([0x8a, 0xd8, 0xff]);
  });

  it("is drawn in the palette it is given: its background, text and busiest-day colour", () => {
    const light: CardPalette = { background: "#fafafa", text: "#111111", dim: "#888888", empty: "#dddddd", muted: "#bbbbbb", levels: ["#c6dbef", "#9ecae1", "#4292c6", "#08519c"] };
    const data = input([0, 2]);
    const stats = computeUsageStats(data, "all", NOW);
    const card = decodePng(renderStatsCard(stats, stats, NOW, light));
    expect(card.pixel(1, 1)).toEqual([0xfa, 0xfa, 0xfa]);
    const today = heatCellRect(CARD.weeks - 1, 3);
    expect(card.pixel(Math.round(today.x + 2), Math.round(today.y + 2))).toEqual([0x08, 0x51, 0x9c]);
    // Without one it is the default dark card.
    expect(decodePng(renderStatsCard(stats, stats, NOW)).pixel(1, 1)).toEqual([0x0e, 0x0e, 0x12]);
  });

  it("knows a palette when it sees one: seven #rrggbb colours, four of them levels", () => {
    expect(isCardPalette(DEFAULT_CARD_PALETTE)).toBe(true);
    expect(isCardPalette({ ...DEFAULT_CARD_PALETTE, text: "red" })).toBe(false);
    expect(isCardPalette({ ...DEFAULT_CARD_PALETTE, levels: ["#000000"] })).toBe(false);
    expect(isCardPalette({ ...DEFAULT_CARD_PALETTE, muted: undefined })).toBe(false);
    expect(isCardPalette("#000000")).toBe(false);
  });

  it("words the range it covers", () => {
    expect(rangeLabel("7d", null, NOW)).toBe("LAST 7 DAYS");
    expect(rangeLabel("30d", null, NOW)).toBe("LAST 30 DAYS");
    expect(rangeLabel("all", null, NOW)).toBe("ALL TIME");
    expect(rangeLabel("all", "2026-01-14", NOW)).toBe("JAN - OCT 2026");
    expect(rangeLabel("all", "2026-10-02", NOW)).toBe("OCT 2026");
  });
});

describe("pixel font", () => {
  it("measures text with a column of gap between characters, and draws a missing character as a box", () => {
    expect(textWidth("", 3)).toBe(0);
    expect(textWidth("AB", 2)).toBe((2 * 6 - 1) * 2);
    const canvas = new Canvas(30, 10, rgb("#000000"));
    drawText(canvas, "é", 0, 0, 1, rgb("#ffffff"));
    // The box's corners and its hollow middle.
    expect(canvas.pixel(0, 0)).toEqual([255, 255, 255]);
    expect(canvas.pixel(4, 6)).toEqual([255, 255, 255]);
    expect(canvas.pixel(2, 3)).toEqual([0, 0, 0]);
  });
});
