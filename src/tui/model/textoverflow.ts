import stringWidth from "string-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A whole-grapheme prefix that fits terminal cells, including emoji and CJK. */
function prefix(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const cells = stringWidth(segment);
    if (used + cells > width) break;
    result += segment;
    used += cells;
  }
  return result;
}

export { stringWidth as textWidth };

/** Preserve short labels while reserving space for a description beside a long one. */
export function overflowColumns(label: string, detail: string | undefined, width: number): { label: number; detail: number } {
  const available = Math.max(0, Math.floor(width));
  if (!detail) return { label: available, detail: 0 };
  const reserved = Math.min(stringWidth(detail), Math.floor(available / 2));
  const left = Math.min(stringWidth(label), Math.max(0, available - reserved - 1));
  return { label: left, detail: Math.max(0, available - left - 1) };
}

export function clippedText(value: string, width: number): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return "";
  return stringWidth(value) <= cells ? value : `${prefix(value, cells - 1)}…`;
}

/**
 * Keep the start and the end of a path that is too wide, middle-truncated
 * with …. Copy actions still take the full text, so nothing is lost.
 */
export function middleTruncate(text: string, width: number): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells <= 1 || stringWidth(text) <= cells) return text;
  const tail = Math.floor((cells - 1) / 2);
  let start = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = stringWidth(segment);
    if (used + w > cells - 1 - tail) break;
    start += segment;
    used += w;
  }
  let end = "";
  let usedEnd = 0;
  const segments = [...graphemes.segment(text)].map(({ segment }) => segment);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const w = stringWidth(segments[index]!);
    if (usedEnd + w > tail) break;
    end = segments[index]! + end;
    usedEnd += w;
  }
  return `${start}…${end}`;
}

/** A continuous marquee, never splitting a surrogate pair or combining mark. */
export function marqueeWindow(text: string, width: number, tick: number): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return "";
  if (stringWidth(text) <= cells) return text;
  const loop = [...graphemes.segment(`${text}   •   `)].map(({ segment }) => segment);
  const offset = ((Math.floor(tick) % loop.length) + loop.length) % loop.length;
  return prefix([...loop.slice(offset), ...loop, ...loop.slice(0, offset)].join(""), cells);
}
