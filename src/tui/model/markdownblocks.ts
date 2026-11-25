/**
 * Splits markdown into the blocks the TUI draws one renderable at a time:
 * runs of ordinary markdown, lists, and blockquotes. OpenTUI's `<markdown>`
 * only structures a table that sits at the top level of what it is given —
 * inside a list item or a blockquote the parser still sees the table, but the
 * renderable draws the container's raw text, so the table's pipes show
 * literally (MXN-375). Cutting lists and blockquotes out into their own
 * `<markdown>` elements — lists in `internalBlockMode="top-level"`, where
 * OpenTUI renders list children (tables included) structurally, and
 * blockquotes as a bordered box around a recursive render of their inner
 * markdown — makes those tables render everywhere.
 *
 * Pure, so the splitting is tested without a terminal. Code fences are
 * consumed verbatim: a fence's contents are never inspected, so pipes,
 * markers or `>` inside a fenced block can never be mistaken for structure.
 */

export type MarkdownBlock =
  | { kind: "text"; text: string; gapBefore: boolean }
  | { kind: "list"; text: string; gapBefore: boolean }
  | { kind: "quote"; inner: string; gapBefore: boolean };

/** A fenced code block opens with up to three spaces then 3+ backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A thematic break — checked before the list marker, since `- - -` is one. */
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
/** A GFM table delimiter row: `|---|---|`, `---|---`, `:---:|---:` and friends. */
const DELIMITER_ROW = /^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (line: string): boolean => line.trim().length === 0;

/** The line opens a code fence whose body runs to `end` (the whole text when unclosed, as while streaming). */
function fenceEnd(lines: string[], start: number): number {
  const open = FENCE_OPEN.exec(lines[start]!)!;
  const char = open[1]![0]!;
  const length = open[1]!.length;
  const close = new RegExp(`^ {0,3}${char === "`" ? "`" : "~"}{${length},}[ \\t]*$`);
  for (let i = start + 1; i < lines.length; i++) if (close.test(lines[i]!)) return i + 1;
  return lines.length;
}

/** A line that starts a top-level block of its own — such a line never continues a list item or quote lazily. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (FENCE_OPEN.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (HR.test(line)) return true;
  if (QUOTE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  return isTableStart(lines, i);
}

/** A table header row (contains a pipe, at most three spaces in) followed by a delimiter row. */
function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (!/^ {0,3}/.test(line) || !line.includes("|")) return false;
  const next = lines[i + 1];
  return next !== undefined && next.includes("|") && next.includes("-") && DELIMITER_ROW.test(next);
}

function isListStart(line: string): boolean {
  return LIST_ITEM.test(line) && !HR.test(line);
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^ {0,3}>[ \t]?/, "");
}

/**
 * The markdown cut into blocks. `gapBefore` records whether a blank line
 * separated the block from the one before it, so the renderer can keep that
 * blank row now that blocks are separate elements. Line endings are
 * normalized to `\n` (a lone `\r` is dropped) — rendering sees the same text.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const blocks: MarkdownBlock[] = [];
  let textLines: string[] = [];
  let textStart = 0;

  // A block starting at `start` had a blank line before it when the line
  // above is blank, or when its own first line is one (blank lines absorbed
  // after a container end up leading the next text run).
  const gapBefore = (start: number, firstLine: string): boolean =>
    blocks.length > 0 && (start > 0 && isBlank(lines[start - 1]!) || isBlank(firstLine));

  const flushText = (): void => {
    if (textLines.length === 0) return;
    const text = textLines.join("\n");
    // A run of only blank lines carries no block of its own; it just marks the gap.
    if (text.trim().length > 0) blocks.push({ kind: "text", text, gapBefore: gapBefore(textStart, textLines[0]!) });
    textLines = [];
  };

  /** Consumes a blockquote from `start`; returns the index of the first line after it. */
  const consumeQuote = (start: number): number => {
    const inner: string[] = [];
    let i = start;
    let prevNonBlank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (QUOTE.test(line)) {
        const stripped = stripQuoteMarker(line);
        inner.push(stripped);
        prevNonBlank = stripped.trim().length > 0;
        i += 1;
        continue;
      }
      // A truly blank line ends the quote; a line without `>` only continues
      // it lazily, right after a non-blank quote line.
      if (isBlank(line) || !prevNonBlank || startsBlock(lines, i)) break;
      inner.push(line);
      prevNonBlank = true;
      i += 1;
    }
    blocks.push({ kind: "quote", inner: inner.join("\n"), gapBefore: gapBefore(start, lines[start]!) });
    return i;
  };

  /** Consumes a list from `start`; returns the first line after the list's last content line (absorbed blank lines are re-scanned as text). */
  const consumeList = (start: number): number => {
    let i = start;
    let lastContent = start;
    let prevNonBlank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        // Tentative: the list may continue past the blank (a loose list), or the blank belongs to the text after it.
        prevNonBlank = false;
        i += 1;
        continue;
      }
      if (line.startsWith(" ") || line.startsWith("\t")) {
        // Indented lines belong to the item — including a fence inside it, whose body is taken verbatim.
        if (FENCE_OPEN.test(line)) i = fenceEnd(lines, i);
        else i += 1;
        lastContent = i;
        prevNonBlank = true;
        continue;
      }
      if (isListStart(line)) {
        lastContent = i + 1;
        prevNonBlank = true;
        i += 1;
        continue;
      }
      // A non-indented line right after item content continues the item lazily.
      if (prevNonBlank && !startsBlock(lines, i)) {
        lastContent = i + 1;
        prevNonBlank = true;
        i += 1;
        continue;
      }
      break;
    }
    blocks.push({ kind: "list", text: lines.slice(start, lastContent).join("\n"), gapBefore: gapBefore(start, lines[start]!) });
    return lastContent;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_OPEN.test(line)) {
      if (textLines.length === 0) textStart = i;
      const end = fenceEnd(lines, i);
      textLines.push(...lines.slice(i, end));
      i = end;
      continue;
    }
    if (QUOTE.test(line)) {
      flushText();
      i = consumeQuote(i);
      continue;
    }
    if (isListStart(line)) {
      flushText();
      i = consumeList(i);
      continue;
    }
    if (textLines.length === 0) textStart = i;
    textLines.push(line);
    i += 1;
  }
  flushText();
  return blocks;
}
