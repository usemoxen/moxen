/**
 * A contact sheet of the stats card: every theme, for all time, the last 30
 * days and the last 7, drawn from this machine's real usage, so the colours
 * can be judged by eye on real numbers.
 *
 *   bun scripts/stats-sheet.ts [--out dir] [--theme a,b]
 *
 * Writes `<out>/stats-themes.png` (the sheet, half size) and every card at full
 * size under `<out>/cards/<theme>-<range>.png`. `--out` defaults to
 * `shots/stats` (git-ignored); `--theme` limits the rows. Reads the store
 * `MOXEN_STORE_ROOT` names, else the usual one, and changes nothing in it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { drawStatsCard } from "../src/core/usage/card.js";
import { drawCentered, drawText } from "../src/core/usage/pixelfont.js";
import { Canvas, encodePng, rgb } from "../src/core/usage/png.js";
import type { StatsRange } from "../src/core/usage/stats.js";
import { readUsageStats } from "../src/core/usage/statsstore.js";
import { openThreadStore, resolveStoreRoot } from "../src/core/threads/store.js";
import { cardPalette } from "../src/tui/model/cardtheme.js";
import { applyTheme } from "../src/tui/theme.js";
import { THEME_NAMES } from "../src/tui/themes.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const out = option("out") ?? path.join("shots", "stats");
const wanted = option("theme")?.split(",").map((name) => name.trim());
const themes = THEME_NAMES.filter((name) => wanted === undefined || wanted.includes(name));
if (themes.length === 0) {
  console.error(`no theme matches --theme (known: ${THEME_NAMES.join(", ")})`);
  process.exit(2);
}

const RANGES: readonly StatsRange[] = ["all", "30d", "7d"];
const RANGE_TITLE: Record<StatsRange, string> = { all: "ALL TIME", "30d": "30 DAYS", "7d": "7 DAYS" };
// The sheet shows each card at half size, a pixel the average of a 2x2 block.
const CELL_W = 600;
const CELL_H = 350;
const GAP = 24;
const LABEL_W = 400;
const HEAD_H = 90;
const SHEET_TEXT = rgb("#f2f2f5");
const SHEET_DIM = rgb("#8a8a98");

const store = await openThreadStore(resolveStoreRoot());
const now = new Date();
const stats = new Map<StatsRange, Awaited<ReturnType<typeof readUsageStats>>>();
for (const range of RANGES) stats.set(range, await readUsageStats(store, range, now));
const all = stats.get("all")!;
console.log(`${all.sessions} sessions, ${all.totalTokens} tokens, ${all.activeDays} active days`);

const cardsDir = path.join(out, "cards");
mkdirSync(cardsDir, { recursive: true });
const sheet = new Canvas(LABEL_W + RANGES.length * (CELL_W + GAP) + GAP, HEAD_H + themes.length * (CELL_H + GAP) + GAP, rgb("#16161b"));
drawText(sheet, "MOXEN STATS CARDS", GAP, 24, 4, SHEET_TEXT);
drawText(sheet, `${all.sessions} SESSIONS`, GAP, 60, 2, SHEET_DIM);

themes.forEach((theme, row) => {
  // The card takes its colours from the theme the TUI has applied, as it does when copied from the app.
  applyTheme(theme);
  const palette = cardPalette();
  const top = HEAD_H + row * (CELL_H + GAP);
  drawText(sheet, theme, GAP, top + CELL_H / 2 - 7, 3, SHEET_TEXT);
  RANGES.forEach((range, column) => {
    const card = drawStatsCard(stats.get(range)!, all, now, palette);
    writeFileSync(path.join(cardsDir, `${theme}-${range}.png`), encodePng(card));
    const left = LABEL_W + GAP + column * (CELL_W + GAP);
    if (row === 0) drawCentered(sheet, RANGE_TITLE[range], left + CELL_W / 2, 56, 3, SHEET_DIM);
    for (let y = 0; y < CELL_H; y += 1) {
      for (let x = 0; x < CELL_W; x += 1) {
        const block = [card.pixel(x * 2, y * 2), card.pixel(x * 2 + 1, y * 2), card.pixel(x * 2, y * 2 + 1), card.pixel(x * 2 + 1, y * 2 + 1)];
        const mean = [0, 1, 2].map((channel) => Math.round(block.reduce((sum, color) => sum + color[channel]!, 0) / 4)) as [number, number, number];
        sheet.fillRect(left + x, top + y, 1, 1, mean);
      }
    }
  });
});

const file = path.join(out, "stats-themes.png");
writeFileSync(file, encodePng(sheet));
console.log(`wrote ${file} (${sheet.width}x${sheet.height}) and ${themes.length * RANGES.length} cards in ${cardsDir}`);
