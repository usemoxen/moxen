import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { fail } from "../helpers.js";

const pause = (ms: number): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

/**
 * The stats screen, from the sidebar footer's `▤ stats` between Settings and
 * Panels: it opens on the overview (counts and the heatmap), tab moves to the
 * models (the chart, a row per model, a row per provider), and esc closes it.
 * Leaves nothing open, so the scenarios after it see the app as before.
 */
export async function runStatsModal(setup: TestRendererSetup): Promise<void> {
  const idle = setup.captureCharFrame();
  const rows = idle.split("\n");
  const buttonRow = rows.findIndex((row) => row.includes("▤ stats"));
  if (buttonRow === -1) fail("sidebar has no stats button");
  if (!(rows[buttonRow]!.indexOf("⚙ settings") < rows[buttonRow]!.indexOf("▤ stats") && rows[buttonRow]!.indexOf("▤ stats") < rows[buttonRow]!.indexOf("◫ panels"))) {
    fail("the stats button is not between settings and panels");
  }
  await act(async () => setup.mockMouse.click(rows[buttonRow]!.indexOf("▤ stats") + 1, buttonRow));
  await pause(500);
  await setup.flush();
  console.log("--- stats (opened from the sidebar) ---");
  const overview = setup.captureCharFrame();
  console.log(overview);
  for (const text of ["Overview", "Models", "Sessions", "Total tokens", "Best streak", "2 days", "$1.25+", "14:00", "claude-opus-5", "s copy card"]) {
    if (!overview.includes(text)) fail(`stats overview does not show "${text}"`);
  }

  await act(async () => setup.mockInput.pressTab());
  await pause(150);
  await setup.flush();
  console.log("--- stats (models) ---");
  const models = setup.captureCharFrame();
  console.log(models);
  for (const text of ["By provider", "opencode/free-model", "unpriced", "2 sessions"]) {
    if (!models.includes(text)) fail(`stats models tab does not show "${text}"`);
  }

  await act(async () => setup.mockInput.pressEscape());
  await pause(300);
  await setup.flush();
  if (setup.captureCharFrame().includes("By provider")) fail("esc did not close the stats screen");
}
