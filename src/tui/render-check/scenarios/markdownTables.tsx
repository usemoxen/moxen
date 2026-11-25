import { act } from "react";
import { MessageBody } from "../../features/timeline/timeline.js";
import { emptyThreadState, timeline } from "../../model/thread.js";
import { MarkdownView } from "../../ui/markdown.js";
import { COLOR, markdownSyntaxStyle } from "../../theme.js";
import { testRender } from "../testrender.js";
import { fail } from "../helpers.js";

/**
 * MXN-375, pinned end to end: a GFM table nested in a list item or a
 * blockquote renders as a grid, not as raw pipes — while a fenced code block
 * full of pipes stays verbatim code, numbered prose is not reinterpreted as a
 * list, prose after a fenced quote stays outside the quote, and a blank line
 * between blocks renders as exactly one blank row. Any list or quote that
 * holds a task item (`- [x]`) anywhere is never split structurally: it renders
 * byte-identically to a plain `<markdown>` of the same text, markers intact.
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
  "- plist item",
  "  | ph1 | ph2 |",
  "  |-----|-----|",
  "  | pc1 | pc2 |",
  "",
  "plain task list:",
  "",
  "- [x] plain done",
  "- [ ] plain todo",
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

/** Sequences that hold a task item somewhere: never split, rendered as plain markdown. */
const TASK_SEQUENCES: Record<string, string> = {
  quotedTask: "- [x] outer done\n  > - [ ] quoted task\n- [ ] sibling task\n  | a | b |\n  |---|---|\n  | 1 | 2 |",
  fenceTask: "- [ ] real task\n  ```\n  - [x] fenced not a task\n  ```\n  | a | b |\n  |---|---|\n  | 1 | 2 |",
  literalTask: "- [x]literal\n-\t[x]\tyes\n- [ ] task\n  | a | b |\n  |---|---|\n  | 1 | 2 |",
  looseTask: "- [x] loose done\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- [ ] loose todo",
  nestedTask: "- outer\n  - [x] nested done\n  | a | b |\n  |---|---|\n  | 1 | 2 |",
  quoteTask: "> - [x] quoted task\n> - [ ] quoted todo\n> | a | b |\n> |---|---|\n> | 1 | 2 |",
};

function reply(text: string, streaming: boolean) {
  const state = emptyThreadState();
  state.messages = [{ id: "reply", turnId: "turn", role: "assistant", text, streaming, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
  return timeline(state)[0]!;
}

async function render(node: React.ReactNode, width: number, height: number) {
  const setup = await testRender(node, { width, height, exitOnCtrlC: false });
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

/** One blank row between the two anchors. */
function blankRowsBetween(rows: string[], from: string, to: string): number | null {
  const a = rows.findIndex((row) => row.includes(from));
  const b = rows.findIndex((row) => row.includes(to));
  if (a === -1 || b === -1 || b <= a) return null;
  return rows.slice(a + 1, b).filter((row) => row.trim() === "").length;
}

export async function runMarkdownTables(): Promise<void> {
  // Tables in task-free containers render as grids.
  const setup = await render(<MessageBody entry={reply(REPLY, false)} homeDir={undefined} background="#000000" />, 80, 72);
  try {
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    console.log("--- markdown tables in list items and blockquotes ---");
    console.log(frame);

    const tables: Array<[string, string, string, string, boolean]> = [
      ["uh1", "uh2", "uc1", "uc2", false],
      ["oh1", "oh2", "oc1", "oc2", false],
      ["qh1", "qh2", "qc1", "qc2", true],
      ["th1", "th2", "tc1", "tc2", false],
      ["ph1", "ph2", "pc1", "pc2", false],
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

    // An ordinary task list (no table) is never split and keeps its literal markers.
    if (!frame.includes("[x] plain done")) fail("ordinary task list lost its literal [x] marker");
    if (!frame.includes("[ ] plain todo")) fail("ordinary task list lost its literal [ ] marker");

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
  const streaming = await render(<MessageBody entry={reply("GAP INTRO\n\n- gap item\n  | gh1 | gh2 |\n  |----|----|\n  | gc1 | gc2 |", true)} homeDir={undefined} background="#000000" />, 60, 14);
  try {
    const rows = streaming.captureCharFrame().split("\n");
    console.log("--- streaming gap between paragraph and list ---");
    console.log(streaming.captureCharFrame());
    const blanks = blankRowsBetween(rows, "GAP INTRO", "gap item");
    if (blanks !== 1) fail(`expected one blank row between paragraph and list while streaming, got ${blanks}`);
    if (!gridRow(rows, "gh1", "gh2")) fail("table in a streaming list did not render");
  } finally {
    await act(async () => streaming.renderer.destroy());
  }

  // CRLF input keeps the blank row between split blocks.
  const crlf = await render(<MessageBody entry={reply("CRLF INTRO\r\n\r\n- crlf item\r\n  | ch1 | ch2 |\r\n  |----|----|\r\n  | cc1 | cc2 |", false)} homeDir={undefined} background="#000000" />, 60, 14);
  try {
    const rows = crlf.captureCharFrame().split("\n");
    console.log("--- CRLF paragraph and list gap ---");
    console.log(crlf.captureCharFrame());
    const blanks = blankRowsBetween(rows, "CRLF INTRO", "crlf item");
    if (blanks !== 1) fail(`expected one blank row between CRLF paragraph and list, got ${blanks}`);
    if (!gridRow(rows, "ch1", "ch2") || !gridRow(rows, "cc1", "cc2")) fail("table in a CRLF list did not render");
  } finally {
    await act(async () => crlf.renderer.destroy());
  }

  // Any container holding a task item renders byte-identically to a plain
  // `<markdown>` of the same text — no splitting, no marker changes.
  for (const [name, sequence] of Object.entries(TASK_SEQUENCES)) {
    const viaWrapper = await render(
      <MarkdownView content={sequence} fg={COLOR.text} syntaxStyle={markdownSyntaxStyle()} selectable />,
      60,
      20,
    );
    let wrapperFrame: string;
    try {
      wrapperFrame = viaWrapper.captureCharFrame();
    } finally {
      await act(async () => viaWrapper.renderer.destroy());
    }
    const viaPlain = await render(
      <markdown content={sequence} fg={COLOR.text} syntaxStyle={markdownSyntaxStyle()} selectable />,
      60,
      20,
    );
    let plainFrame: string;
    try {
      plainFrame = viaPlain.captureCharFrame();
    } finally {
      await act(async () => viaPlain.renderer.destroy());
    }
    console.log(`--- task sequence ${name}: wrapper vs plain <markdown> ---`);
    console.log(wrapperFrame);
    if (wrapperFrame !== plainFrame) fail(`task sequence "${name}" did not render byte-identically to plain markdown`);
    if (!wrapperFrame.includes("[x]") && !wrapperFrame.includes("[ ]")) fail(`task sequence "${name}" lost its markers`);
  }
}
