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
  if (token === null || typeof token !== "object") return false;
  const node = token as { type?: string; tokens?: unknown; items?: unknown };
  if (node.type === "table") return true;
  if (Array.isArray(node.tokens) && node.tokens.some(containsTable)) return true;
  if (Array.isArray(node.items) && node.items.some(containsTable)) return true;
  return false;
}

/** The blockquote's inner markdown: its own raw with one `>` marker level stripped per line. */
function quoteInner(raw: string): string {
  return raw
    .split("\n")
    .map((line) => (QUOTE_MARK.test(line) ? line.replace(QUOTE_MARK, "") : line))
    .join("\n");
}

/**
 * A list that renders structurally loses marked's checkbox tokens (OpenTUI's
 * list renderer skips them), so task-list state is rewritten into the item
 * text as a ballot box the text token keeps: `- [x] done` becomes `- ☒ done`.
 */
function listText(list: Tokens.List): string {
  return list.items.map(itemText).join("");
}

/** `Tokens.Generic` keeps `type` a plain string, so narrowing needs this guard. */
const isList = (token: Token): token is Tokens.List => token.type === "list";

function itemText(item: Tokens.ListItem): string {
  let raw = item.raw;
  for (const child of item.tokens) {
    if (child.type === "checkbox") raw = raw.replace(child.raw, `${item.checked ? "☒" : "☐"} `);
    else if (isList(child)) raw = raw.replace(child.raw, listText(child));
  }
  return raw;
}

/**
 * The markdown cut into blocks. `gapBefore` records whether a blank line
 * separated the block from the one before it, so the renderer can keep that
 * blank row now that blocks are separate elements. Text blocks carry no
 * trailing blank lines — the separator comes from the source whitespace or
 * the following block's margin, never both. Lists without a table stay in
 * the text run, rendered as ordinary markdown exactly as before.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let run: string[] = [];
  let runGap = false;
  let offset = 0;

  const flushRun = (): void => {
    if (run.length === 0) return;
    blocks.push({ kind: "text", text: run.join("").replace(/\n+$/, ""), gapBefore: runGap });
    run = [];
  };

  for (const token of lexer(text, { gfm: true })) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === "space") {
      // Blank lines inside a text run stay in it; between blocks they only mark the gap.
      if (run.length > 0) run.push(token.raw);
      continue;
    }
    // The run not yet flushed counts as a block too, for the gap test.
    const gapBefore = (blocks.length > 0 || run.length > 0) && BLANK_BEFORE.test(text.slice(Math.max(0, start - GAP_LOOKBACK), start));
    if (token.type === "blockquote") {
      flushRun();
      blocks.push({ kind: "quote", inner: quoteInner(token.raw), gapBefore });
      continue;
    }
    if (isList(token) && containsTable(token)) {
      flushRun();
      blocks.push({ kind: "list", text: listText(token), gapBefore });
      continue;
    }
    if (run.length === 0) runGap = gapBefore;
    run.push(token.raw);
  }
  flushRun();
  return blocks;
}
