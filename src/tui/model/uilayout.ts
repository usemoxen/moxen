/**
 * How a `moxen-ui` block shares a row of terminal cells among its children.
 * Pure, so the sums are tested without a terminal; `features/timeline/
 * uiblockview.tsx` draws what these decide.
 */

/** The fewest cells an image or text is given before its container stacks instead of squeezing it. */
export const MIN_CELL_COLUMNS = 14;

/**
 * `total` cells shared out by weight, `gap` cells between neighbours, the
 * remainder going to the heaviest children first so the widths sum to the
 * room exactly. Null when some child would get fewer than `min` cells: the
 * caller stacks them instead.
 */
export function splitColumns(total: number, weights: readonly number[], gap: number, min = MIN_CELL_COLUMNS): number[] | null {
  const count = weights.length;
  if (count === 0) return [];
  const room = Math.floor(total) - gap * (count - 1);
  if (room < min * count) return null;
  const sum = weights.reduce((all, weight) => all + weight, 0);
  const widths = weights.map((weight) => Math.floor((room * weight) / sum));
  let left = room - widths.reduce((all, width) => all + width, 0);
  const order = weights.map((weight, index) => ({ weight, index })).sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (let at = 0; left > 0; at = (at + 1) % count, left--) widths[order[at]!.index]! += 1;
  return widths.every((width) => width >= min) ? widths : null;
}

/** The most columns, up to `columns`, whose cells (`gap` apart) are each at least `min` wide in `total` cells; never fewer than one. */
export function gridColumnsThatFit(total: number, columns: number, gap: number, min = MIN_CELL_COLUMNS): number {
  for (let count = columns; count > 1; count--) if (Math.floor((total - gap * (count - 1)) / count) >= min) return count;
  return 1;
}

/** The width of a grid cell covering `span` of `columns` equal columns in `total` cells (the leftover cells stay empty so every row fits). */
export function gridCellWidth(total: number, columns: number, gap: number, span: number): number {
  const column = Math.max(1, Math.floor((total - gap * (columns - 1)) / columns));
  const covered = Math.min(span, columns);
  return column * covered + gap * (covered - 1);
}
