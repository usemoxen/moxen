import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { fail, foldTarget } from "../helpers.js";

/** The timeline diff row, the Worked fold, and the diff-turn picker. */
export async function runDiffPanel(setup: TestRendererSetup): Promise<void> {
  const frame = () => setup.captureCharFrame();
  // Modal opens and timeline jumps settle on their own time, not a fixed
  // delay a loaded renderer overruns.
  const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 5000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    do {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await setup.flush();
      });
      if (predicate()) return frame();
    } while (Date.now() < deadline);
    fail(`${label}:\n${frame()}`);
  };
  // The timeline's own "diff …" row opens the diff panel — found by its
  // label, since its row shifts with the layout. A fixed cell here missed
  // under load and the cascade below opened message actions over the next
  // scenario instead.
  const diffRows = frame().split("\n");
  const diffRow = diffRows.findIndex((line) => /[▸▾] diff /.test(line));
  if (diffRow === -1) fail("timeline shows no diff row to expand");
  await act(async () => setup.mockMouse.click(diffRows[diffRow]!.indexOf("diff ") + 2, diffRow));
  const panelFrame = await waitFor("timeline diff row did not open the diff panel", () => /turns? ▾/.test(frame()));
  console.log("--- turn diff expanded (clicked timeline row) ---");
  console.log(panelFrame);

  // The "Worked for" fold in the chat column, located fresh every time —
  // flat tool rows reflow the pane, so fixed rows would miss.
  {
    const target = await foldTarget(setup, act);
    await act(async () => setup.mockMouse.click(target.x, target.y));
    await setup.flush();
  }
  // Scroll up so the expanded cards (not just the tail) are visible.
  await act(async () => setup.mockInput.pressKey("HOME"));
  await setup.flush();
  console.log("--- work expanded (top) ---");
  console.log(setup.captureCharFrame());
  // A replied turn folds its tools into per-message summary segments inside
  // the expanded Worked fold — no per-tool stacks anywhere. Sweep the whole
  // transcript top to bottom: expand any collapsed fold on sight, and pass
  // iff the aggregate summary shows up somewhere with no per-tool stack ever
  // appearing. Position-free by design — sticky-scroll jumps make fixed
  // coordinates meaningless here. Ends with turn-1 expanded, which is what
  // later steps assume.
  await act(async () => setup.mockInput.pressKey("HOME"));
  await setup.flush();
  let sawSummary = false;
  let sawStack = false;
  for (let sweep = 0; sweep < 60; sweep += 1) {
    const frame = setup.captureCharFrame();
    // The mid-turn nudge splits turn-1's work in two, each summarized.
    if (/Ran \d+ commands?/u.test(frame)) sawSummary = true;
    if (frame.includes("read ×") || frame.includes("Update ×")) sawStack = true;
    if (sawSummary) break;
    const rows = frame.split("\n");
    const shutFold = rows.findIndex((line) => line.includes("▸ Worked for"));
    if (shutFold !== -1) {
      const line = rows[shutFold] ?? "";
      const glyph = line.indexOf("▸");
      await act(async () => setup.mockMouse.click(glyph === -1 ? 50 : glyph, shutFold));
      await setup.flush();
      continue;
    }
    await act(async () => setup.mockMouse.scroll(70, 5, "down"));
    await setup.flush();
  }
  console.log("--- work summarized (inside fold) ---");
  console.log(setup.captureCharFrame());
  if (sawStack) fail("tool calls still stack per tool");
  if (!sawSummary) fail("closed turn does not summarize its tools");
  // Wheel down to review the remaining cards.
  for (let wheel = 0; wheel < 18; wheel += 1) {
    await act(async () => setup.mockMouse.scroll(80, 12, "down"));
  }
  await setup.flush();
  console.log("--- work expanded (scrolled) ---");
  console.log(setup.captureCharFrame());

  // Second file header inside the diff panel: found by its path and counts —
  // a transcript row can share the path, never the counts row — so no fixed
  // cell whose miss would cascade below.
  const fileRows = setup.captureCharFrame().split("\n");
  const fileRow = fileRows.findIndex((line) => /[▸▾]\s+\S*timeline\.tsx.*\+\d+\s+-\d+/.test(line));
  if (fileRow === -1) fail("diff panel shows no timeline.tsx file header");
  await act(async () => setup.mockMouse.click(fileRows[fileRow]!.indexOf("timeline.tsx"), fileRow));
  await setup.flush();
  console.log("--- second file folded (clicked header) ---");
  console.log(setup.captureCharFrame());

  // The diff panel's own header row opens the turn picker: found by its
  // turns meta, never a fixed cell (which landed on reply headers and opened
  // message actions instead when the layout shifted).
  const headerRows = setup.captureCharFrame().split("\n");
  const headerRow = headerRows.findIndex((line) => /turns? ▾/.test(line));
  if (headerRow === -1) fail("diff panel shows no turn header");
  await act(async () => setup.mockMouse.click(headerRows[headerRow]!.indexOf("▾"), headerRow));
  console.log("--- diff-turn picker (open) ---");
  console.log(setup.captureCharFrame());

  // … which closes back to the diff on backdrop click (the esc key calls the
  // same `onClose`; the mock's `pressEscape` is sync-void while clicks are the
  // proven in-harness path — the corner is outside the centered panel).
  await act(async () => setup.mockMouse.click(138, 0));
  await setup.flush();
  console.log("--- diff-turn picker (backdrop closed) ---");
  console.log(setup.captureCharFrame());

  // … and jumps the timeline to the picked turn when its row is picked (Turn
  // 5 here — a different turn than the open Turn 7, so the panel switches too
  // and the jump must land on the settled post-open layout, at the top).
  // Re-resolve the header: the backdrop click above may have scrolled it.
  const headerRows2 = setup.captureCharFrame().split("\n");
  const headerRow2 = headerRows2.findIndex((line) => /turns? ▾/.test(line));
  if (headerRow2 === -1) fail("diff panel shows no turn header");
  await act(async () => setup.mockMouse.click(headerRows2[headerRow2]!.indexOf("▾"), headerRow2));
  // The header click must have opened the picker before touching its rows:
  // a fixed cell can land on a reply header when the layout shifts, and
  // "Turn 5" also names a transcript row whose click opens message actions
  // over the next scenario instead — so only click it below the picker's
  // own title row, and fail with the real cause when the picker never opens.
  const pickerFrame = await waitFor("diff-turn picker did not open", () => frame().includes("Select diff turn"));
  const pickerRows = pickerFrame.split("\n");
  const titleRow = pickerRows.findIndex((line) => line.includes("Select diff turn"));
  const turnRow = pickerRows.findIndex((line, index) => index > titleRow && line.includes("Turn 5"));
  if (turnRow === -1) fail("diff-turn picker offered no Turn 5");
  await act(async () => setup.mockMouse.click(pickerRows[turnRow]!.indexOf("Turn 5") + 1, turnRow));
  // The pick jumps the timeline once it settles: wait for the picked turn's
  // header rather than a fixed delay a loaded renderer overruns.
  const jumpedFrame = await waitFor("diff-turn pick did not jump the timeline", () => frame().includes("Diff turn 5"));
  console.log("--- diff-turn picked (timeline jumped) ---");
  console.log(jumpedFrame);
}
