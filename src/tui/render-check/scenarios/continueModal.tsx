import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "../testrender.js";

import type { ClientApi } from "../../../server/api.js";
import { App, client } from "../fixtures.js";
import { USAGE_CONTINUE_GRACE_MS } from "../../../core/threads/views.js";
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

/** Like `catalog`, plus an effort-less model the modal can land on. */
function limitedCatalog() {
  const base = catalog();
  const claude = base.providers.find((provider) => provider.instanceId === "claudeAgent");
  if (claude !== undefined) {
    // No knobs at all: an empty descriptor list reads as no sliders.
    claude.models.push({ slug: "claude-plain", name: "Claude Plain", isCustom: false, isDefault: false, capabilities: { optionDescriptors: [] } });
  }
  return base;
}

/** A `usage.limit` hit on the open thread's latest turn, as the runner records one. */
function limitFrame(resetsAt: string): unknown {
  return {
    kind: "event",
    event: {
      type: "thread.activity-appended",
      payload: {
        activity: {
          id: "limit-continue",
          kind: "usage.limit",
          tone: "info",
          summary: "Usage limit reached",
          turnId: "turn-2",
          createdAt: new Date().toISOString(),
          payload: { provider: "claude", rateLimitType: "five_hour", label: "Session", resetsAt },
        },
      },
    },
  };
}

/**
 * The base thread subscription, replaying a standing usage limit after
 * every snapshot — resubscribes (a thread switch, a resync) keep the
 * banner, so later passes don't depend on a still-open subscription.
 */
function limitedThreads(resetsAt: string): ClientApi["subscribeThread"] {
  return ((threadId: string, options: object, onItem: (item: unknown) => void, onError?: (cause: unknown) => void) => {
    const stop = client.subscribeThread(
      threadId,
      options as never,
      (item) => {
        (onItem as (frame: unknown) => void)(item);
        if ((item as { kind?: unknown }).kind === "synchronized") (onItem as (frame: unknown) => void)(limitFrame(resetsAt));
      },
      onError as never,
    );
    return stop;
  }) as unknown as ClientApi["subscribeThread"];
}

async function openContinueFromBanner(setup: TestRendererSetup): Promise<void> {
  await waitFor(setup, "the usage banner did not offer a new thread", (frame) => frame.includes("In a new thread"));
  const bannered = setup.captureCharFrame().split("\n");
  const action = bannered.findIndex((line) => line.includes("In a new thread"));
  if (action === -1) fail(`the usage banner lacks a new-thread action:\n${setup.captureCharFrame()}`);
  await act(async () => setup.mockMouse.click(bannered[action]!.indexOf("In a new thread") + 2, action));
  await waitFor(setup, "the continue modal did not open from the banner", (frame) => frame.includes("enter continues"));
  await settle(setup);
}

/**
 * A limited thread's banner opens the same modal: with the reset ahead it
 * waits, and switching provider flips the footer to starting at once. A
 * model with no effort knobs offers no sliders. Enter sends the hold along
 * with the model when both apply.
 */
export async function runContinueModalLimited(): Promise<void> {
  type Dispatch = Parameters<ClientApi["dispatch"]>[0];
  const commands: Dispatch[] = [];
  const resetsAt = new Date(Date.now() + 72.5 * 60_000).toISOString();
  const isolated: ClientApi = {
    ...client,
    dispatch: ((command: Dispatch) => {
      commands.push(command);
      if (command.type === "thread.continue") {
        // Stay on the open thread: the mock server mints no threads, and
        // the standing limit must survive for the later passes.
        return Promise.resolve({ threadId: "t-now", title: "continued", scheduledFor: null, accepted: true });
      }
      return client.dispatch(command);
    }) as unknown as ClientApi["dispatch"],
    getConfig: (() => Promise.resolve(limitedCatalog())) as unknown as ClientApi["getConfig"],
    subscribeThread: limitedThreads(resetsAt),
  };
  const setup = await testRender(<App client={isolated} onQuit={() => {}} launchView="thread" />, {
    width: 120,
    height: 30,
    exitOnCtrlC: false,
  });
  try {
    await waitFor(setup, "the thread view did not settle", (frame) => frame.includes("Claude Opus 5"));
    await openContinueFromBanner(setup);
    const held = setup.captureCharFrame();
    console.log("--- continue modal (waiting for the reset) ---");
    console.log(held);
    if (!held.includes("Waits for the reset")) fail("the limited modal does not say it waits for the reset");
    // Enter at once on the same provider: the hold rides along, like
    // today's continue — no modelSelection, scheduled for after the reset.
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const heldContinue = commands.find((command) => command.type === "thread.continue");
    if (
      heldContinue?.type !== "thread.continue" || "modelSelection" in heldContinue ||
      heldContinue.scheduledFor !== new Date(Date.parse(resetsAt) + USAGE_CONTINUE_GRACE_MS).toISOString()
    ) {
      fail(`the held continue sent ${JSON.stringify(heldContinue)}`);
    }
    await waitFor(setup, "the continue modal did not close", (frame) => !frame.includes("enter continues"));
    // The limit still stands on the same thread: switching provider flips
    // the footer to starting at once instead of waiting on the old reset.
    await openContinueFromBanner(setup);
    const providerRow = rowWith(setup, "Provider");
    const providerLine = setup.captureCharFrame().split("\n")[providerRow.y]!;
    await act(async () => setup.mockMouse.click(providerLine.indexOf("Claude", providerRow.x), providerRow.y));
    await setup.flush();
    const flipped = setup.captureCharFrame();
    console.log("--- continue modal (flipped to starts right away) ---");
    console.log(flipped);
    if (!flipped.includes("Starts right away") || flipped.includes("Waits for the reset")) {
      fail("switching provider did not flip the wait hint");
    }
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const prompt = commands.filter((command) => command.type === "thread.continue").at(-1);
    if (
      prompt?.type !== "thread.continue" || "scheduledFor" in prompt ||
      JSON.stringify(prompt.modelSelection) !== JSON.stringify({ instanceId: "opencode", model: "oc-model", options: [{ id: "reasoningEffort", value: "low" }] })
    ) {
      fail(`the cross-provider continue sent ${JSON.stringify(prompt)}`);
    }
    // The palette row says what the modal will do while the limit stands.
    await act(async () => setup.mockInput.pressKey("p", { ctrl: true }));
    await setup.flush();
    for (const char of "continu") {
      await act(async () => setup.mockInput.pressKey(char));
      await setup.flush();
    }
    await waitFor(setup, "the palette did not narrow", (frame) => frame.includes("Continue in a new thread") && frame.includes("after the reset"));
    const narrowed = setup.captureCharFrame().split("\n");
    const row = narrowed.findIndex((line) => line.includes("Continue in a new thread"));
    await act(async () => setup.mockMouse.click(narrowed[row]!.indexOf("Continue in a new thread") + 2, row));
    await waitFor(setup, "the continue modal did not open from the palette", (frame) => frame.includes("enter continues"));
    await settle(setup);
    // The plain model has no effort knobs: no sliders, and the handoff
    // carries no options — held for the reset on this provider.
    const model = rowWith(setup, "Model");
    await act(async () => setup.mockMouse.click(model.x, model.y));
    await setup.flush();
    const plain = setup.captureCharFrame();
    console.log("--- continue modal (model without effort) ---");
    console.log(plain);
    if (plain.includes("Effort") || plain.includes("Faster")) fail("the plain model still offers an effort slider");
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const plainContinue = commands.filter((command) => command.type === "thread.continue").at(-1);
    if (
      plainContinue?.type !== "thread.continue" ||
      JSON.stringify(plainContinue.modelSelection) !== JSON.stringify({ instanceId: "claudeAgent", model: "claude-plain" }) ||
      plainContinue.scheduledFor === undefined
    ) {
      fail(`the plain-model continue sent ${JSON.stringify(plainContinue)}`);
    }
  } finally {
    setup.renderer.destroy();
  }
}

/**
 * A rejected continue keeps the modal open: the draft stays intact for
 * retry instead of dropping the user into the model picker.
 */
export async function runContinueModalRetry(): Promise<void> {
  type Dispatch = Parameters<ClientApi["dispatch"]>[0];
  const commands: Dispatch[] = [];
  let attempts = 0;
  const isolated: ClientApi = {
    ...client,
    dispatch: ((command: Dispatch) => {
      commands.push(command);
      if (command.type === "thread.continue") {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("the server refused the handoff"));
        return Promise.resolve({ threadId: "t-now", title: "continued", scheduledFor: null, accepted: true });
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
    await openContinueFromPalette(setup);
    // Dirty the draft first: the retry must keep this choice, not a blank one.
    const high = rowWith(setup, "Low", "Medium", "High");
    await act(async () => setup.mockMouse.click(setup.captureCharFrame().split("\n")[high.y]!.indexOf("High"), high.y));
    await setup.flush();
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    if (commands.length !== 1) fail(`the rejected continue dispatched ${commands.length} commands`);
    // Still the modal, not the model picker: the wait hint reads, and the
    // High stop the draft picked is still the one in force.
    const stayed = setup.captureCharFrame();
    console.log("--- continue modal (rejected, kept open) ---");
    console.log(stayed);
    if (!stayed.includes("enter continues")) fail("the rejected continue did not keep the modal open");
    if (!stayed.includes("Deeper reasoning for harder tasks")) fail("the rejected continue lost the drafted effort");
    // Retry: the kept draft goes out unchanged and the modal closes.
    await act(async () => setup.mockInput.pressEnter());
    await setup.flush();
    const retried = commands.filter((command) => command.type === "thread.continue").at(-1);
    if (
      retried?.type !== "thread.continue" ||
      JSON.stringify(retried.modelSelection) !== JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-5", options: [{ id: "effort", value: "high" }] })
    ) {
      fail(`the retry sent ${JSON.stringify(retried)}`);
    }
    await waitFor(setup, "the continue modal did not close after retry", (frame) => !frame.includes("enter continues"));
  } finally {
    setup.renderer.destroy();
  }
}
