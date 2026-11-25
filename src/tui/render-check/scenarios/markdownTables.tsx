import { act } from "react";
import { MessageBody } from "../../features/timeline/timeline.js";
import { emptyThreadState, timeline } from "../../model/thread.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";

/**
 * MXN-375, pinned end to end: a GFM table nested in a list item or a
 * blockquote must render as a grid, not as raw pipes — while a fenced code
 * block full of pipes stays verbatim code, task-list checkboxes keep their
 * state (in both the ordinary and the table-holding list), numbered prose is
 * not reinterpreted as a list, prose after a fenced quote stays outside the
 * quote, and a blank line between blocks renders as exactly one blank row.
 */

const REPLY = [
  "INTRO TEXT",
  "",
  "- ulist item",
  "  | uh1 | uh2 |",
  "  |----|----|",
  "  | uc1 | uc2 |",
  "",
  "1. olist item",
  "   | oh1 | oh2 |",
  "   |----|----|",
  "   | oc1 | oc2 |",
  "",
  "> qnote",
  "> | qh1 | qh2 |",
  "> |----|----|",
  "> | qc1 | qc2 |",
  "",
  "| th1 | th2 |",
  "|-----|-----|",
  "| tc1 | tc2 |",
  "",
  "- [x] mixed done",
  "  | mh1 | mh2 |",
  "  |-----|-----|",
  "  | mc1 | mc2 |",
  "- [ ] mixed todo",
  "",
  "plain task list:",
  "",
  "- [x] plain done",
  "- [ ] plain todo",
  "",
  "loose and nested:",
  "",
  "- [x] loose done",
  "",
  "  | lh1 | lh2 |",
  "  |-----|-----|",
  "  | lc1 | lc2 |",
  "- [ ] loose todo",
  "- outer item",
  "  - [x] nested done",
  "  - [ ] nested todo",
  "  | nh1 | nh2 |",
  "  |-----|-----|",
  "  | nc1 | nc2 |",
  "",
  "Step number follows on this line",
  "2. this is still paragraph text",
  "9. these are literal numbers",
  "",
  "> ```",
  "> qcode line",
  "> ```",
  "After the quote",
  "",
  "```",
  "| fenced | pipes |",
  "|--------|--------|",
  "```",
].join("\n");

function reply(text: string, streaming: boolean) {
  const state = emptyThreadState();
  state.messages = [{ id: "reply", turnId: "turn", role: "assistant", text, streaming, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
  return timeline(state)[0]!;
}

async function render(entry: ReturnType<typeof reply>, width: number, height: number) {
  const setup = await testRender(<MessageBody entry={entry} homeDir={undefined} background="#000000" />, { width, height, exitOnCtrlC: false });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await setup.flush();
  });
  return setup;
}

/** A rendered grid row holding both cells, e.g. `│uh1   │uh2   │`. */
function gridRow(rows: string[], a: string, b: string, quoteBorder = false): boolean {
  const pattern = quoteBorder ? `│\\s*│\\s*${a}\\s*│\\s*${b}\\s*│` : `│\\s*${a}\\s*│\\s*${b}\\s*│`;
  return rows.some((row) => new RegExp(pattern).test(row));
}

export async function runMarkdownTables(): Promise<void> {
  const setup = await render(reply(REPLY, false), 80, 84);
  try {
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    console.log("--- markdown tables in list items and blockquotes ---");
    console.log(frame);

    // Every table renders as a grid with its own unique cells: unordered and
    // ordered list items, the blockquote (behind its quote border), top level,
    // and the checkbox list that also holds a table.
    const tables: Array<[string, string, string, string, boolean]> = [
      ["uh1", "uh2", "uc1", "uc2", false],
      ["oh1", "oh2", "oc1", "oc2", false],
      ["qh1", "qh2", "qc1", "qc2", true],
      ["th1", "th2", "tc1", "tc2", false],
      ["mh1", "mh2", "mc1", "mc2", false],
      ["lh1", "lh2", "lc1", "lc2", false],
      ["nh1", "nh2", "nc1", "nc2", false],
    ];
    for (const [h1, h2, c1, c2, quoted] of tables) {
      if (!gridRow(rows, h1, h2, quoted)) fail(`table header ${h1}/${h2} did not render as a grid row`);
      if (!gridRow(rows, c1, c2, quoted)) fail(`table cells ${c1}/${c2} did not render as a grid row`);
    }

    // The only ASCII pipes left in the frame are the fenced code block's own.
    const rawPipeRows = rows.filter((row) => row.includes("|") && !row.includes("fenced") && !row.includes("--------"));
    if (rawPipeRows.length > 0) fail(`raw pipes rendered outside the fence: ${JSON.stringify(rawPipeRows[0])}`);
    if (!frame.includes("| fenced | pipes |")) fail("fenced code block lost its pipes");
    if (!frame.includes("|--------|--------|")) fail("fenced delimiter-looking row was mangled into a table");

    // Task lists keep their checkbox state: the table-holding list renders
    // ballot boxes (its `[x]`/`[ ]` markers are rewritten for the structural
    // renderer), the ordinary list keeps its literal markers.
    const mixedDone = rows.find((row) => row.includes("mixed done"));
    const mixedTodo = rows.find((row) => row.includes("mixed todo"));
    if (mixedDone === undefined || !mixedDone.includes("☒")) fail("checked task item lost its checkbox in a table-holding list");
    if (mixedTodo === undefined || !mixedTodo.includes("☐")) fail("unchecked task item lost its checkbox in a table-holding list");
    if (frame.includes("[x] mixed") || frame.includes("[ ] mixed")) fail("table-holding task list kept raw checkbox markers");
    if (!frame.includes("[x] plain done")) fail("ordinary task list lost its literal [x] marker");
    if (!frame.includes("[ ] plain todo")) fail("ordinary task list lost its literal [ ] marker");
    // Loose (blank line before the table) and nested task items in table-holding
    // lists keep their checkbox state too, at their original indentation.
    for (const [needle, glyph] of [["loose done", "☒"], ["loose todo", "☐"], ["nested done", "☒"], ["nested todo", "☐"]] as const) {
      const row = rows.find((line) => line.includes(needle));
      if (row === undefined || !row.includes(glyph)) fail(`task item "${needle}" lost its ${glyph} checkbox`);
    }

    // Numbered prose stays prose: a list starting at 2 cannot interrupt a paragraph.
    if (!frame.includes("9. these are literal numbers")) fail("numbered prose was renumbered");
    if (frame.includes("3. these are literal numbers")) fail("numbered prose was reinterpreted as a list");

    // Prose after a fenced quote stays outside the quote border.
    const afterQuote = rows.find((row) => row.includes("After the quote"));
    if (afterQuote === undefined) fail("prose after the fenced quote disappeared");
    else if (afterQuote.includes("│")) fail("prose after a fenced quote rendered inside the quote border");
    const qcode = rows.find((row) => row.includes("qcode line"));
    if (qcode === undefined || !qcode.includes("│")) fail("fenced code inside the quote lost the quote border");
  } finally {
    await act(async () => setup.renderer.destroy());
  }

  // While streaming, a blank line between a paragraph and a list is exactly
  // one blank row — the separator comes from the source or the wrapper
  // margin, not both.
  const streaming = await render(reply("GAP INTRO\n\n- gap item\n  | gh1 | gh2 |\n  |----|----|\n  | gc1 | gc2 |", true), 60, 14);
  try {
    const rows = streaming.captureCharFrame().split("\n");
    console.log("--- streaming gap between paragraph and list ---");
    console.log(streaming.captureCharFrame());
    const intro = rows.findIndex((row) => row.includes("GAP INTRO"));
    const item = rows.findIndex((row) => row.includes("gap item"));
    if (intro === -1 || item === -1) fail("streaming paragraph/list not visible");
    else {
      const blanks = rows.slice(intro + 1, item).filter((row) => row.trim() === "").length;
      if (blanks !== 1) fail(`expected one blank row between paragraph and list while streaming, got ${blanks}`);
      if (!gridRow(rows, "gh1", "gh2")) fail("table in a streaming list did not render");
    }
  } finally {
    await act(async () => streaming.renderer.destroy());
  }

  // CRLF input keeps the blank row between split blocks: line endings are
  // normalized once before lexing, so token offsets still find the gap.
  const crlf = await render(reply("CRLF INTRO\r\n\r\n- crlf item\r\n  | ch1 | ch2 |\r\n  |----|----|\r\n  | cc1 | cc2 |", false), 60, 14);
  try {
    const rows = crlf.captureCharFrame().split("\n");
    console.log("--- CRLF paragraph and list gap ---");
    console.log(crlf.captureCharFrame());
    const intro = rows.findIndex((row) => row.includes("CRLF INTRO"));
    const item = rows.findIndex((row) => row.includes("crlf item"));
    if (intro === -1 || item === -1) fail("CRLF paragraph/list not visible");
    else {
      const blanks = rows.slice(intro + 1, item).filter((row) => row.trim() === "").length;
      if (blanks !== 1) fail(`expected one blank row between CRLF paragraph and list, got ${blanks}`);
      if (!gridRow(rows, "ch1", "ch2") || !gridRow(rows, "cc1", "cc2")) fail("table in a CRLF list did not render");
    }
  } finally {
    await act(async () => crlf.renderer.destroy());
  }
}
