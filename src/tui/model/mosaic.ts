/**
 * An image drawn out of text cells: each cell is a "▀" whose foreground is
 * the pixel above and whose background is the pixel below, so a cell shows
 * two pixels. It is what an image is drawn as while a modal is open: the
 * modal's dimming layer turns a real `<image>` black, but it dims text like
 * any other.
 */

export interface MosaicRun {
  text: string;
  fg: string;
  bg: string;
}

const hex = (data: Uint8Array, at: number): string =>
  `#${[data[at]!, data[at + 1]!, data[at + 2]!].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/**
 * `rows` lines of runs for an RGBA image `width`×(2·`rows`) pixels, rows
 * `stride` bytes apart. Cells beside each other with the same colours are one run.
 */
export function mosaicRows(data: Uint8Array, width: number, rows: number, stride: number = width * 4): MosaicRun[][] {
  const out: MosaicRun[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const runs: MosaicRun[] = [];
    for (let column = 0; column < width; column += 1) {
      const top = row * 2 * stride + column * 4;
      const bottom = (row * 2 + 1) * stride + column * 4;
      const fg = hex(data, top);
      const bg = hex(data, bottom);
      const last = runs.at(-1);
      if (last !== undefined && last.fg === fg && last.bg === bg) last.text += "▀";
      else runs.push({ text: "▀", fg, bg });
    }
    out.push(runs);
  }
  return out;
}
