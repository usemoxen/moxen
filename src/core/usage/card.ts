/**
 * The stats card: one PNG to share, drawn from a `usage.stats` result the way
 * OpenCode's `stats` card is — the token total large in the middle, the
 * activity heatmap under it, and three counts along the bottom. Pixel type
 * and flat colour, so it needs no fonts and no libraries (`png.ts`).
 */
import { drawCentered, drawRight, drawText, GLYPH_HEIGHT, textWidth } from "./pixelfont.js";
import { formatCount, heatmap, type HeatCell } from "./present.js";
import { Canvas, encodePng, rgb, type Rgb } from "./png.js";
import type { StatsRange, UsageStats } from "./stats.js";

export const CARD = {
  width: 1200,
  height: 700,
  padding: 56,
  weeks: 52,
  cell: 14,
  gap: 6,
  heatTop: 356,
  labelColumn: 28,
} as const;

/** The colours a card is drawn in, as `#rrggbb`: the TUI passes its current theme's, so the card matches the screen it came from. */
export interface CardPalette {
  readonly background: string;
  readonly text: string;
  readonly dim: string;
  /** The dot of a day with nothing in it. */
  readonly empty: string;
  /** A day with activity before the range: still there, but grey. */
  readonly muted: string;
  /** Levels 1 to 4, faint to busiest. */
  readonly levels: readonly [string, string, string, string];
}

export const DEFAULT_CARD_PALETTE: CardPalette = {
  background: "#0e0e12",
  text: "#f2f2f5",
  dim: "#6c6c7a",
  empty: "#24242c",
  muted: "#4a4a55",
  levels: ["#2a4a66", "#3b78a8", "#56b0e6", "#8ad8ff"],
};

const HEX = /^#[0-9a-fA-F]{6}$/u;

/** Whether `value` is a palette: every colour a `#rrggbb` and four levels. */
export function isCardPalette(value: unknown): value is CardPalette {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const colour = (entry: unknown): boolean => typeof entry === "string" && HEX.test(entry);
  return (
    ["background", "text", "dim", "empty", "muted"].every((key) => colour(record[key])) &&
    Array.isArray(record.levels) &&
    record.levels.length === 4 &&
    record.levels.every(colour)
  );
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The heading's right-hand side: the span the numbers cover. */
export function rangeLabel(range: StatsRange, firstDay: string | null, now: Date): string {
  if (range === "7d") return "LAST 7 DAYS";
  if (range === "30d") return "LAST 30 DAYS";
  if (firstDay === null) return "ALL TIME";
  const month = (day: string): string => MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  const first = `${month(firstDay)} ${firstDay.slice(0, 4)}`;
  const last = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  return first === last ? last : `${month(firstDay)} - ${last}`;
}

/** Where a heatmap cell's square sits on the card, for the draw and for a test to look at. */
export function heatCellRect(week: number, weekday: number): { x: number; y: number; size: number } {
  const total = CARD.labelColumn + CARD.weeks * (CARD.cell + CARD.gap) - CARD.gap;
  const left = (CARD.width - total) / 2 + CARD.labelColumn;
  return { x: left + week * (CARD.cell + CARD.gap), y: CARD.heatTop + weekday * (CARD.cell + CARD.gap), size: CARD.cell };
}

function drawHeatCell(canvas: Canvas, cell: HeatCell | null, week: number, weekday: number, colors: Colors): void {
  if (cell === null) return;
  const { x, y, size } = heatCellRect(week, weekday);
  if (cell.muted) canvas.fillRect(x, y, size, size, colors.muted);
  else if (cell.level === 0) canvas.fillRect(x + size / 2 - 2, y + size / 2 - 2, 4, 4, colors.empty);
  else canvas.fillRect(x, y, size, size, colors.levels[cell.level - 1]!);
}

/**
 * `stats` is the range the card is for, `all` every active day (so the heatmap
 * keeps days before the range on the card, in grey, as the stats screen does).
 */
interface Colors {
  readonly background: Rgb;
  readonly text: Rgb;
  readonly dim: Rgb;
  readonly empty: Rgb;
  readonly muted: Rgb;
  readonly levels: readonly Rgb[];
}

export function drawStatsCard(stats: UsageStats, all: UsageStats, now: Date, palette: CardPalette = DEFAULT_CARD_PALETTE): Canvas {
  const colors: Colors = {
    background: rgb(palette.background),
    text: rgb(palette.text),
    dim: rgb(palette.dim),
    empty: rgb(palette.empty),
    muted: rgb(palette.muted),
    levels: palette.levels.map((level) => rgb(level)),
  };
  const canvas = new Canvas(CARD.width, CARD.height, colors.background);
  const right = CARD.width - CARD.padding;
  const middle = CARD.width / 2;

  drawText(canvas, "MOXEN / STATS", CARD.padding, 48, 4, colors.text);
  drawRight(canvas, rangeLabel(stats.range, all.daily[0]?.day ?? null, now), right, 48, 4, colors.dim);

  drawCentered(canvas, formatCount(stats.totalTokens), middle, 130, 18, colors.text);
  drawCentered(canvas, "TOKENS", middle, 130 + GLYPH_HEIGHT * 18 + 24, 4, colors.dim);

  const map = heatmap(all.daily, now, CARD.weeks, stats.range);
  const gridLeft = heatCellRect(0, 0).x;
  const labelRows = ["M", "", "W", "", "F", "", "S"];
  labelRows.forEach((label, weekday) => {
    if (label !== "") drawText(canvas, label, gridLeft - CARD.labelColumn, heatCellRect(0, weekday).y, 2, colors.dim);
  });
  map.monthStarts.forEach(({ week, month }, index) => {
    const x = heatCellRect(week, 0).x;
    const next = map.monthStarts[index + 1];
    // A name with no room before the next month's would run into it.
    if (next === undefined || heatCellRect(next.week, 0).x - x >= textWidth("MMM", 2) + 8) drawText(canvas, MONTHS[month]!, x, CARD.heatTop - 28, 2, colors.dim);
  });
  map.rows.forEach((row, weekday) => row.forEach((cell, week) => drawHeatCell(canvas, cell, week, weekday, colors)));

  const days = `${stats.bestStreak} ${stats.bestStreak === 1 ? "DAY" : "DAYS"}`;
  const columns: ReadonlyArray<readonly [string, string, number]> = [
    [days, "BEST STREAK", CARD.width * 0.2],
    [String(stats.activeDays), stats.activeDays === 1 ? "ACTIVE DAY" : "ACTIVE DAYS", middle],
    [String(stats.sessions), stats.sessions === 1 ? "SESSION" : "SESSIONS", CARD.width * 0.8],
  ];
  for (const [value, label, centerX] of columns) {
    drawCentered(canvas, value, centerX, 556, 6, colors.text);
    drawCentered(canvas, label, centerX, 556 + GLYPH_HEIGHT * 6 + 14, 3, colors.dim);
  }
  return canvas;
}

/** The card as PNG bytes. */
export function renderStatsCard(stats: UsageStats, all: UsageStats, now: Date, palette: CardPalette = DEFAULT_CARD_PALETTE): Uint8Array {
  return encodePng(drawStatsCard(stats, all, now, palette));
}
