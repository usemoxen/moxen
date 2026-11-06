import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "../testrender.js";

import type { ClientApi } from "../../../server/api.js";
import { App, client } from "../fixtures.js";
import { SIDEBAR_WIDTH } from "../../app/constants.js";
import { fail } from "../helpers.js";

/** Footer model segment in the thread view: the "Claude Opus 5" label that
    opens the model picker (the timeline reply header carries the same name
    plus a timestamp, so the composer's is the occurrence sharing a row with the
    mode). */
function threadFooterModelTarget(setup: TestRendererSetup): { x: number; y: number } {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((line) => line.includes("Build · Claude Opus 5"));
  if (y === -1) fail("composer footer model segment not visible");
  const x = rows[y]?.indexOf("Claude Opus 5") ?? -1;
  if (x === -1) fail("composer footer model label not visible");
  return { x: x + 2, y };
}

/**
 * Wait until the frame says what the click should have done, instead of
 * sleeping a fixed delay: a loaded renderer answers later, and a fixed wait
 * flakes on a slow platform while hiding a real regression on a fast one.
 */
async function waitForFrame(setup: TestRendererSetup, label: string, predicate: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.flush();
    });
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
  } while (Date.now() < deadline);
  fail(`${label}:\n${setup.captureCharFrame()}`);
}

/**
 * I2: the picker is live server data, never a hardcoded list — a disabled
 * instance still reports its models over `getConfig` (Grok below), and the
 * user's hidden-model preferences ride in `settings`. Both must stay out of
 * the offered rows. I1: the same picker must open while drafting with no
 * source thread (zero-thread workspace), storing the pick locally instead of
 * erroring with "no open thread to set the model for".
 */
export async function runModelPicker(setup: TestRendererSetup): Promise<void> {
  // Thread view: the open thread locks the picker to its own provider, so
  // only that provider's visible models are offered. The footer row is found
  // by its label afresh: the row above it shifts with the layout.
  await act(async () => {
    const target = threadFooterModelTarget(setup);
    await setup.mockMouse.click(target.x, target.y);
  });
  const threadFrame = await waitForFrame(setup, "model footer click did not open the picker", (frame) => frame.includes("Select model"));
  console.log("--- model picker (thread view) ---");
  console.log(threadFrame);
  if (!threadFrame.includes("Claude Opus 5")) fail("model picker missing the current model");
  if (threadFrame.includes("Claude Old")) fail("model picker offered a hidden model");
  if (threadFrame.includes("Grok")) fail("model picker offered another provider in the locked thread view");
  await act(async () => setup.mockInput.pressEscape());
  await waitForFrame(setup, "model picker did not close on esc", (frame) => !frame.includes("Select model"));

  // Zero-thread workspace: fresh install with projects but no threads lands
  // in the creating view — the model picker must open there too (I1), and a
  // disabled provider's models must stay hidden even with no provider lock
  // (I2, the friend's Grok rows).
  const emptyClient: ClientApi = {
    ...client,
    subscribeShell(_options, onItem) {
      onItem({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 1,
          projects: [{ id: "p-cli", title: "moxen", workspaceRoot: "C:\\repo", defaultModelSelection: null }],
          threads: [],
        },
      });
      onItem({ kind: "synchronized" });
      return () => {};
    },
    subscribeThread() {
      return () => {};
    },
  };
  const empty = await testRender(
    <App client={emptyClient} onQuit={() => {}} />,
    { width: 140, height: 26, exitOnCtrlC: false },
  );
  try {
    const creatingFrame = await waitForFrame(empty, "empty workspace did not land in the creating view", (frame) => frame.includes("What should we build in"));
    console.log("--- empty workspace (creating view) ---");
    console.log(creatingFrame);
    if (creatingFrame.includes("no open thread to set the model for")) {
      fail("empty workspace shows the model error without any interaction");
    }
    const rows = creatingFrame.split("\n");
    // The desktop layout's selectors row: mode, then the model (none yet, so "-").
    const footer = rows.findIndex((line) => line.includes("Build · -"));
    if (footer === -1) fail("empty creating-view composer footer not visible");
    const x = (rows[footer]?.indexOf("Build · -") ?? -1) + "Build · ".length;
    if ((rows[footer]?.indexOf("Build · -") ?? -1) === -1) fail("empty creating-view composer footer label not visible");
    await act(async () => {
      await empty.mockMouse.click(x, footer);
    });
    const emptyFrame = await waitForFrame(empty, "model picker did not open with zero threads", (frame) => frame.includes("Select model"));
    console.log("--- model picker (empty workspace) ---");
    console.log(emptyFrame);
    if (emptyFrame.includes("no open thread to set the model for")) {
      fail("model picker errored with zero threads");
    }
    if (!emptyFrame.includes("Claude Opus 5")) fail("empty-workspace picker missing the enabled model");
    if (emptyFrame.includes("Grok")) fail("empty-workspace picker offered a disabled provider");
    if (emptyFrame.includes("Claude Old")) fail("empty-workspace picker offered a hidden model");
    // No model yet: the creating view keeps the monitoring lattice. Picking
    // Opus eases its scene in — half-block raster, no lattice dots left.
    if (creatingFrame.includes("▀")) fail("the creating view painted a model scene with no model picked");
    const pickerRows = emptyFrame.split("\n");
    const opusRow = pickerRows.findIndex((line) => line.includes("Claude Opus 5"));
    if (opusRow === -1) fail("model picker offered no Opus row to pick");
    const opusX = pickerRows[opusRow]?.indexOf("Claude Opus 5") ?? -1;
    if (opusX === -1) fail("model picker Opus row has no clickable label");
    await act(async () => {
      await empty.mockMouse.click(opusX, opusRow);
    });
    // The scene blooms in over 1.4 s; read when it has painted, whenever that is.
    // The sidebar keeps its lattice by design; only the creating pane changes,
    // so the wait itself watches the pane, not the whole frame.
    const sceneFrame = await waitForFrame(empty, "picking Opus in the creating view did not take", (frame) => {
      if (!frame.includes("Claude Opus 5") || !frame.includes("▀")) return false;
      const pane = frame.split("\n").map((line) => line.slice(SIDEBAR_WIDTH)).join("\n");
      return !pane.includes("·       ·       ·");
    }, 8000);
    console.log("--- creating view with Opus picked (scene) ---");
    console.log(sceneFrame);
    // The sidebar keeps its lattice by design; only the creating pane changes.
    const creatingPane = sceneFrame
      .split("\n")
      .map((line) => line.slice(SIDEBAR_WIDTH))
      .join("\n");
    if (creatingPane.includes("·       ·       ·")) fail("the monitoring lattice stayed under the Opus scene");
    // The palette acts on a thread; the creating view has none yet.
    await act(async () => empty.mockInput.pressKey("p", { ctrl: true }));
    await empty.flush();
    if (empty.captureCharFrame().includes("Export thread to markdown")) fail("the command palette opened in the new-thread view");
  } finally {
    empty.renderer.destroy();
  }
}
