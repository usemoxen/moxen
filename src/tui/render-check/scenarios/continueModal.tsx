import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "../testrender.js";

import type { ClientApi } from "../../../server/api.js";
import { App, client } from "../fixtures.js";
import { applyLanguage } from "../../i18n/index.js";
import { fail } from "../helpers.js";

function effortDescriptor(id: string, choices: Array<{ id: string; label: string }>, isDefault: string) {
  return {
    id,
    label: "Effort",
    type: "select",
    currentValue: null,
    options: choices.map((choice) => ({ id: choice.id, label: choice.label, isDefault: choice.id === isDefault })),
  };
}

/** Two enabled providers with effort knobs, so the modal can cross providers. */
function catalog() {
  return {
    settings: {},
    providers: [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          {
            slug: "claude-opus-5",
            name: "Claude Opus 5",
            isCustom: false,
            isDefault: true,
            capabilities: { optionDescriptors: [effortDescriptor("effort", [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }], "medium")] },
          },
        ],
        skills: [],
      },
      {
        instanceId: "opencode",
        driver: "opencode",
        displayName: "OpenCode",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          {
            slug: "oc-model",
            name: "OC Model",
            isCustom: false,
            isDefault: true,
            capabilities: { optionDescriptors: [effortDescriptor("reasoningEffort", [{ id: "low", label: "Low" }, { id: "high", label: "High" }], "low")] },
          },
        ],
        skills: [],
      },
    ],
  };
}

async function waitFor(setup: TestRendererSetup, label: string, predicate: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
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

/** ModalShell fades in over ~150ms: capture after it, or the frame shows the view beneath bleeding through. */
async function settle(setup: TestRendererSetup): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  await setup.flush();
}
/** The first frame row holding every text: the palette row, a modal row, the buttons. */
function rowWith(setup: TestRendererSetup, ...texts: string[]): { x: number; y: number } {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => texts.every((text) => row.includes(text)));
  if (y === -1) fail(`continue modal: no row with ${JSON.stringify(texts)}\n${setup.captureCharFrame()}`);
  const x = rows[y]!.indexOf(texts[0]!);
  return { x, y };
}

async function openContinueFromPalette(setup: TestRendererSetup): Promise<void> {
  await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
  await setup.flush();
  for (const char of "continu") {
    await act(async () => setup.mockInput.pressKey(char));
    await setup.flush();
  }
  await waitFor(setup, "the palette did not narrow to the continue row", (frame) => frame.includes("Continue in a new thread"));
  const palette = setup.captureCharFrame().split("\n");
  const row = palette.findIndex((line) => line.includes("Continue in a new thread"));
  if (row === -1) fail(`the palette lacks the continue row:\n${setup.captureCharFrame()}`);
  await act(async () => setup.mockMouse.click(palette[row]!.indexOf("Continue in a new thread") + 2, row));
  await waitFor(setup, "the continue modal did not open", (frame) => frame.includes("enter continues"));
  await settle(setup);
}

/**
 * The single "Continue in a new thread" palette row opens one modal with the
 * provider, model and effort, preselected to the thread's own. Enter at once
 * continues exactly as the old row did (no `modelSelection`); changing the
 * provider, model and effort sends them along. Keyboard and mouse both work,
 * in a window well under the minimum size.
 */
export async function runContinueModal(): Promise<void> {
  type Dispatch = Parameters<ClientApi["dispatch"]>[0];
  const commands: Dispatch[] = [];
  const isolated: ClientApi = {
    ...client,
    dispatch: ((command: Dispatch) => {
      commands.push(command);
      if (command.type === "thread.continue") {
        // Land on an existing shell row: the mock server mints no threads,
        // and the modal reads the open thread's own selection.
        return Promise.resolve({ threadId: "t-xash", title: "continued", scheduledFor: null, accepted: true });
      }
      return client.dispatch(command);
    }) as unknown as ClientApi["dispatch"],
    getConfig: (() => Promise.resolve(catalog())) as unknown as ClientApi["getConfig"],
  };
  const setup = await testRender(<App client={isolated} onQuit={() => {}} launchView="thread" />, {
    width: 120,
    height: 30,
    exitOnCtrlC: false,
  });
  try {
    await waitFor(setup, "the thread view did not settle", (frame) => frame.includes("Claude Opus 5"));
    // One continue row, not two: the model-first row is gone.
    await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
    await setup.flush();
    for (const char of "continu") {
      await act(async () => setup.mockInput.pressKey(char));
      await setup.flush();
    }
    const palette = await waitFor(setup, "the continue row did not narrow", (frame) => frame.includes("Continue in a new thread"));
    console.log("--- continue palette ---");
    console.log(palette);
    if (palette.includes("another model")) fail("the palette still offers a continue-on-another-model row");
    const narrowed = palette.split("\n");
    const row = narrowed.findIndex((line) => line.includes("Continue in a new thread"));
    await act(async () => setup.mockMouse.click(narrowed[row]!.indexOf("Continue in a new thread") + 2, row));
    const modal = await waitFor(setup, "the continue modal did not open", (frame) => frame.includes("enter continues"));
    await settle(setup);
    console.log("--- continue modal (preselected) ---");
    console.log(setup.captureCharFrame());
    const settled = setup.captureCharFrame();
    for (const expected of ["Claude", "Claude Opus 5", "Effort", "Medium", "Balanced speed and depth", "Starts right away"]) {
      if (!settled.includes(expected)) fail(`the continue modal is missing "${expected}"`);
    }
    // Enter at once: the untouched draft dispatches exactly like today's
    // continue — no modelSelection, so the server resolves like a follow-up.
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const untouched = commands.find((command) => command.type === "thread.continue");
    if (untouched?.type !== "thread.continue" || "modelSelection" in untouched) {
      fail(`enter at once did not continue unchanged: ${JSON.stringify(untouched)}`);
    }
    await waitFor(setup, "the continue modal did not close on enter", (frame) => !frame.includes("enter continues"));

    // Keyboard across providers: focus follows the mouse, which rests where
    // the palette click landed, so click the provider row first — that
    // focuses it and cycles to OpenCode. Down to the model row, right (one
    // model: stays), down to the effort slider, right to high, enter. The
    // other provider's effort knob replaces this one's.
    await openContinueFromPalette(setup);
    const providerRow = rowWith(setup, "Provider");
    const providerLine = setup.captureCharFrame().split("\n")[providerRow.y]!;
    await act(async () => setup.mockMouse.click(providerLine.indexOf("Claude", providerRow.x), providerRow.y));
    await setup.flush();
    for (const key of ["down", "right", "down", "right"] as const) {
      await act(async () => setup.mockInput.pressArrow(key));
      await setup.flush();
    }
    const switched = setup.captureCharFrame();
    console.log("--- continue modal (other provider, high effort) ---");
    console.log(switched);
    if (!switched.includes("OpenCode") || !switched.includes("OC Model") || !switched.includes("High")) {
      fail("the keyboard pass did not reach OpenCode / OC Model / High");
    }
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const keyboarded = commands.filter((command) => command.type === "thread.continue").at(-1);
    if (keyboarded?.type !== "thread.continue" || JSON.stringify(keyboarded.modelSelection) !== JSON.stringify({ instanceId: "opencode", model: "oc-model", options: [{ id: "reasoningEffort", value: "high" }] })) {
      fail(`the keyboard pass sent ${JSON.stringify(keyboarded)}`);
    }

    // Mouse: a click on the model row (one model: stays), a click on the
    // High stop sets the effort, the Continue button sends it.
    await openContinueFromPalette(setup);
    const model = rowWith(setup, "Model");
    await act(async () => setup.mockMouse.click(model.x, model.y));
    await setup.flush();
    // The stops row carries every level; the model row's "Low–High" range
    // does not, so this cannot land on the model row above the slider.
    const high = rowWith(setup, "Low", "Medium", "High");
    await act(async () => setup.mockMouse.click(setup.captureCharFrame().split("\n")[high.y]!.indexOf("High"), high.y));
    await setup.flush();
    const clicked = setup.captureCharFrame();
    console.log("--- continue modal (mouse pass) ---");
    console.log(clicked);
    const start = rowWith(setup, "Continue", "Cancel");
    await act(async () => setup.mockMouse.click(start.x, start.y));
    await setup.flush();
    const moused = commands.filter((command) => command.type === "thread.continue").at(-1);
    if (moused?.type !== "thread.continue" || JSON.stringify(moused.modelSelection) !== JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5", options: [{ id: "effort", value: "high" }] })) {
      fail(`the mouse pass sent ${JSON.stringify(moused)}`);
    }
    // Esc closes without sending.
    await openContinueFromPalette(setup);
    const before = commands.length;
    await act(async () => setup.mockInput.pressEscape());
    await setup.flush();
    await waitFor(setup, "the continue modal did not close on esc", (frame) => !frame.includes("enter continues"));
    if (commands.length !== before) fail("esc from the continue modal dispatched");
  } finally {
    setup.renderer.destroy();
  }
}

/** The continue modal in Spanish: its rows and buttons say their words. */
export async function runContinueModalSpanish(): Promise<void> {
  const isolated: ClientApi = {
    ...client,
    getConfig: (() => Promise.resolve(catalog())) as unknown as ClientApi["getConfig"],
  };
  const setup = await testRender(<App client={isolated} onQuit={() => {}} launchView="thread" ui={{ language: "es-ES" }} />, {
    width: 120,
    height: 30,
    exitOnCtrlC: false,
  });
  try {
    await waitFor(setup, "the Spanish thread view did not settle", (frame) => frame.includes("Claude Opus 5"));
    await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
    await setup.flush();
    for (const char of "continuar") {
      await act(async () => setup.mockInput.pressKey(char));
      await setup.flush();
    }
    const palette = setup.captureCharFrame().split("\n");
    const row = palette.findIndex((line) => line.includes("Continuar en un hilo nuevo"));
    if (row === -1) fail(`the Spanish palette lacks the continue row:\n${setup.captureCharFrame()}`);
    await act(async () => setup.mockMouse.click(palette[row]!.indexOf("Continuar en un hilo nuevo") + 2, row));
    const modal = await waitFor(setup, "the Spanish continue modal did not open", (frame) => frame.includes("intro continúa"));
    await settle(setup);
    console.log("--- continue modal (español) ---");
    console.log(setup.captureCharFrame());
    const settled = setup.captureCharFrame();
    for (const expected of ["Continuar en un hilo nuevo", "Proveedor", "Modelo", "Continuar", "Cancelar"]) {
      if (!settled.includes(expected)) fail(`the Spanish continue modal is missing "${expected}"`);
    }
  } finally {
    setup.renderer.destroy();
    applyLanguage("en");
  }
}
