import { act } from "react";
import { MessageBody } from "../../features/timeline/timeline.js";
import { emptyThreadState, timeline } from "../../model/thread.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";

/**
 * MXN-375: a GFM table nested in a list item or a blockquote must render as a
 * table, not as raw pipes — while a fenced code block full of pipes stays
 * verbatim code and is never turned into a table.
 */
export async function runMarkdownTables(): Promise<void> {
  const text = [
    "## Tables",
    "",
    "- unordered item",
    "  | a | b |",
    "  |---|---|",
    "  | 1 | 2 |",
    "",
    "1. ordered item",
    "   | x | y |",
    "   |---|---|",
    "   | 3 | 4 |",
    "",
    "> quoted note",
    "> | q | r |",
    "> |---|---|",
    "> | 5 | 6 |",
    "",
    "| top | level |",
    "|-----|-------|",
    "| 5   | 6     |",
    "",
    "```",
    "| fenced | pipes |",
    "|--------|--------|",
    "```",
  ].join("\n");

  const state = emptyThreadState();
  state.messages = [{ id: "reply", turnId: "turn", role: "assistant", text, streaming: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
  const setup = await testRender(<MessageBody entry={timeline(state)[0]!} homeDir={undefined} background="#000000" />, { width: 80, height: 34, exitOnCtrlC: false });
  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await setup.flush();
  });
  try {
    await settle();
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    console.log("--- markdown tables in list items and blockquotes ---");
    console.log(frame);
    // No raw delimiter or header rows anywhere: every table, wherever it sits, rendered.
    if (rows.some((line) => line.includes("|---|---|"))) fail("a table rendered as raw pipes (delimiter row visible)");
    if (rows.some((line) => /\| (?:a|x|q|top) \|/.test(line))) fail("a table rendered as raw pipes (header row visible)");
    // Each nested table's cells appear on a pipe-free (rendered) row.
    for (const [first, second] of [["a", "b"], ["x", "y"], ["q", "r"], ["top", "level"]] as const) {
      if (!rows.some((line) => line.includes(first) && line.includes(second) && !line.includes("|"))) {
        fail(`table with cells ${first}/${second} did not render as a table`);
      }
    }
    // The list and quote containers still show.
    if (!frame.includes("unordered item") || !frame.includes("ordered item")) fail("list items lost their text");
    if (!frame.includes("quoted note")) fail("blockquote lost its text");
    // The fenced block keeps its pipes verbatim — never turned into a table.
    if (!frame.includes("| fenced | pipes |")) fail("fenced code block lost its pipes");
    if (!frame.includes("|--------|--------|")) fail("fenced delimiter-looking row was mangled");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
}
