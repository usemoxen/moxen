/** A run of prose, and whether it was between backticks. */
export interface ProseSegment {
  readonly text: string;
  readonly code: boolean;
}

/**
 * Prose with `inline code`, as runs: what is between a pair of backticks is
 * code (shown without them, in its own colour), everything else is plain. A
 * backtick with no partner stays a backtick rather than swallowing the rest.
 * The settings page's descriptions are written this way, and a plain text node
 * would print the backticks themselves.
 */
export function splitInlineCode(text: string): ProseSegment[] {
  const segments: ProseSegment[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf("`");
    const close = open < 0 ? -1 : rest.indexOf("`", open + 1);
    if (open < 0 || close < 0) {
      segments.push({ text: rest, code: false });
      break;
    }
    if (open > 0) segments.push({ text: rest.slice(0, open), code: false });
    if (close > open + 1) segments.push({ text: rest.slice(open + 1, close), code: true });
    rest = rest.slice(close + 1);
  }
  return segments;
}
