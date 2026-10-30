/**
 * How a `moxen-ui` block's data components fit into the cells they are given:
 * bars with eighth-block precision, the columns of a chart, a progress row.
 * Pure, so the sums are tested without a terminal; `features/timeline/
 * uidataview.tsx` draws what these decide. Text is measured in characters, as
 * the rest of the TUI's truncation is.
 */

/** One to seven eighths of a cell, filled from the left. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** The fewest cells a bar is given before a row drops its value, or stacks its label. */
export const MIN_BAR_COLUMNS = 6;

/** A fraction of `width` cells as a bar: whole cells and one partial, at least a sliver for any value above zero. */
export function barCells(fraction: number, width: number): string {
  if (!(fraction > 0) || width < 1) return "";
  const eighths = Math.max(1, Math.round(Math.min(1, fraction) * width * 8));
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
}

/** `text` cut to `width` characters, ending in an ellipsis when it was cut. */
export function fit(text: string, width: number): string {
  if (width < 1) return "";
  return text.length <= width ? text : width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

/** A number as a person writes it: whole numbers plain, others to two places with no trailing zeros. */
export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export interface ChartBar {
  label: string;
  value: number;
}

export interface ChartRow {
  label: string;
  bar: string;
  /** The bar's cell width in the row, for padding the rest. */
  barWidth: number;
  value: string;
}

export interface ChartLayout {
  labelWidth: number;
  valueWidth: number;
  barWidth: number;
  rows: ChartRow[];
}

/** The widest a label column grows, as a share of the width: the bars are the point. */
const LABEL_SHARE = 0.4;

/**
 * A chart's rows in `columns` cells. Labels get what the longest needs, up to
 * a share of the width; values get a right-aligned column; the bars take the
 * rest, scaled so `max` (default the largest value) fills one. When the bars
 * would be narrower than `MIN_BAR_COLUMNS` the values go first, then the labels shrink.
 */
export function chartLayout(bars: readonly ChartBar[], columns: number, unit = "", max?: number): ChartLayout {
  const scale = max ?? Math.max(0, ...bars.map((bar) => bar.value));
  const values = bars.map((bar) => `${formatValue(bar.value)}${unit}`);
  let labelWidth = Math.min(Math.max(...bars.map((bar) => bar.label.length)), Math.max(3, Math.floor(columns * LABEL_SHARE)));
  let valueWidth = Math.max(...values.map((value) => value.length));
  let barWidth = columns - labelWidth - valueWidth - 2;
  if (barWidth < MIN_BAR_COLUMNS) {
    valueWidth = 0;
    barWidth = columns - labelWidth - 1;
  }
  if (barWidth < MIN_BAR_COLUMNS) {
    labelWidth = Math.max(1, columns - MIN_BAR_COLUMNS - 1);
    barWidth = Math.max(1, columns - labelWidth - 1);
  }
  return {
    labelWidth,
    valueWidth,
    barWidth,
    rows: bars.map((bar, at) => ({
      label: fit(bar.label, labelWidth),
      bar: barCells(scale > 0 ? bar.value / scale : 0, barWidth),
      barWidth,
      value: valueWidth > 0 ? values[at]! : "",
    })),
  };
}

export interface ProgressLayout {
  /** The label on a line of its own above the bar, when the row is too narrow to share one; null otherwise. */
  stackedLabel: string | null;
  /** The label at the start of the row, empty when stacked. */
  label: string;
  labelWidth: number;
  bar: string;
  barWidth: number;
  /** What follows the bar: the percentage, then the reply's own words. */
  right: string;
}

/** A progress row in `columns` cells: `label  ████  42%  38 of 90`, the label above the bar when it would be cut beside it or the bar would be too short. */
export function progressLayout(label: string, value: number, text: string | undefined, columns: number): ProgressLayout {
  const percent = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
  const right = text === undefined || text.length === 0 ? percent : `${percent} ${text}`;
  const shown = fit(right, Math.max(percent.length, Math.floor(columns * 0.5)));
  const labelWidth = Math.min(label.length, Math.floor(columns * 0.35));
  const shared = columns - labelWidth - shown.length - 2;
  // A label that would be cut in its share goes above the bar whole, rather than being shortened beside it.
  if (label.length <= labelWidth && shared >= MIN_BAR_COLUMNS) {
    return { stackedLabel: null, label: fit(label, labelWidth), labelWidth, bar: barCells(value, shared), barWidth: shared, right: shown };
  }
  const alone = Math.max(1, columns - shown.length - 1);
  return { stackedLabel: fit(label, columns), label: "", labelWidth: 0, bar: barCells(value, alone), barWidth: alone, right: shown };
}
