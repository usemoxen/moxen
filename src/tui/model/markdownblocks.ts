/**
 * Splits markdown into the blocks the TUI draws one renderable at a time:
 * runs of ordinary markdown, lists that hold a table, and blockquotes.
 * OpenTUI's `<markdown>` only structures a table at the top level of what it
 * is given — inside a list item or a blockquote the parser still sees the
 * table, but the renderable draws the container's raw text, so the table's
 * pipes show literally (MXN-375). Cutting those containers out into their own
 * `<markdown>` elements — lists in `internalBlockMode="top-level"`, where
 * OpenTUI renders list children (tables included) structurally, and
 * blockquotes as a bordered box around a recursive render of their inner
 * markdown — makes those tables render everywhere.
 *
 * Block boundaries come from the same markdown parser OpenTUI renders with
 * (`marked`, pinned to the version `@opentui/core` bundles), never from
 * hand-rolled line heuristics: an ordered list starting at `2.` cannot
 * interrupt a paragraph, a fenced block inside a quote is not lazily
 * continued by the prose after it, and unclosed fences while streaming all
 * fall out of the parser's own tokens. Code fences stay verbatim inside
 * whatever block holds them, so fenced pipes are never mangled.
 *
 * Pure, so the splitting is tested without a terminal.
 */

import { lexer, type Token, type Tokens } from "marked";

export type MarkdownBlock =
  | { kind: "text"; text: string; gapBefore: boolean }
  | { kind: "list"; text: string; gapBefore: boolean }
  | { kind: "quote"; inner: string; gapBefore: boolean };

/** The source ends in a blank line right before the offset the regex is tested at. */
const BLANK_BEFORE = /\n[ \t]*\n[ \t]*$/;
/** How far back to look for that blank line — gaps are never thousands of cells wide. */
const GAP_LOOKBACK = 4096;
const QUOTE_MARK = /^ {0,3}>[ \t]?/;

/** Whether a token tree holds a GFM table anywhere — list items, nested lists, quotes included. */
function containsTable(token: unknown): boolean {
  return contains(token, (node) => node.type === "table");
}

/**
 * Whether a token tree holds a GFM task item (`- [x]`) anywhere — nested
 * lists and quotes included. A container holding one is never split
 * structurally: OpenTUI's list renderer drops the checkbox tokens, so the
 * item's `[x]`/`[ ]` would vanish, and no rewriting of the markers is done —
 * the whole container renders exactly as ordinary markdown does.
 */
function containsTask(token: unknown): boolean {
  return contains(token, (node) => node.task === true);
}

/** Walks a token tree (tokens/items arrays, nested to any depth) for a predicate on each node. */
function contains(token: unknown, predicate: (node: { type?: string; task?: boolean }) => boolean): boolean {
  if (Array.isArray(token)) return token.some((child) => contains(child, predicate));
  if (token === null || typeof token !== "object") return false;
  const node = token as { type?: string; task?: boolean; tokens?: unknown; items?: unknown };
  if (predicate(node)) return true;
  if (Array.isArray(node.tokens) && node.tokens.some((child) => contains(child, predicate))) return true;
  if (Array.isArray(node.items) && node.items.some((child) => contains(child, predicate))) return true;
  return false;
}

/** The blockquote's inner markdown: its own raw with one `>` marker level stripped per line. */
function quoteInner(raw: string): string {
  return raw
    .split("\n")
    .map((line) => (QUOTE_MARK.test(line) ? line.replace(QUOTE_MARK, "") : line))
    .join("\n");
}

/** `Tokens.Generic` keeps `type` a plain string, so narrowing needs this guard. */
const isList = (token: Token): token is Tokens.List => token.type === "list";

/**
 * The markdown cut into blocks. `gapBefore` records whether a blank line
 * separated the block from the one before it, so the renderer can keep that
 * blank row now that blocks are separate elements. Text blocks carry no
 * trailing blank lines — the separator comes from the source whitespace or
 * the following block's margin, never both. Lists without a table stay in
 * the text run, rendered as ordinary markdown exactly as before — and so does
 * any list or blockquote that holds a task item, whose `[x]` markers the
 * structural renderer would drop.
 *
 * Line endings are normalized to `\n` once, up front: marked normalizes them
 * before lexing, so its token raws (and the offsets measured against them)
 * only line up with the normalized text, never with raw `\r\n` input.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const source = text.replace(/\r\n|\r/g, "\n");
  const blocks: MarkdownBlock[] = [];
  let run: string[] = [];
  let runGap = false;
  let offset = 0;

  const flushRun = (): void => {
    if (run.length === 0) return;
    blocks.push({ kind: "text", text: run.join("").replace(/\n+$/, ""), gapBefore: runGap });
    run = [];
  };

  for (const token of lexer(source, { gfm: true })) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === "space") {
      // Blank lines inside a text run stay in it; between blocks they only mark the gap.
      if (run.length > 0) run.push(token.raw);
      continue;
    }
    // The run not yet flushed counts as a block too, for the gap test.
    const gapBefore = (blocks.length > 0 || run.length > 0) && BLANK_BEFORE.test(source.slice(Math.max(0, start - GAP_LOOKBACK), start));
    // A container holding a task item anywhere is never split: the structural
    // list renderer drops checkbox tokens, and no marker rewriting is done, so
    // it stays in the text run and renders exactly as ordinary markdown does.
    if (token.type === "blockquote" && !containsTask(token)) {
      flushRun();
      blocks.push({ kind: "quote", inner: quoteInner(token.raw), gapBefore });
      continue;
    }
    if (isList(token) && containsTable(token) && !containsTask(token)) {
      flushRun();
      blocks.push({ kind: "list", text: token.raw, gapBefore });
      continue;
    }
    if (run.length === 0) runGap = gapBefore;
    run.push(token.raw);
  }
  flushRun();
  return blocks;
}
