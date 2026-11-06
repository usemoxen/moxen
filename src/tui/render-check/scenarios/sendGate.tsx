import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ClientApi } from "../../../server/api.js";
import { App, client as baseClient } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

const frame = (setup: TestRendererSetup) => setup.captureCharFrame();

async function until(setup: TestRendererSetup, check: (screen: string) => boolean, message: string) {
  for (let attempt = 0; !check(frame(setup)); attempt += 1) {
    if (attempt === 200) fail(`send gate: ${message}\n${frame(setup)}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
}
const visible = (setup: TestRendererSetup, text: string) => until(setup, (screen) => screen.includes(text), `did not show ${text}`);

async function press(setup: TestRendererSetup, name: string, options: { shift?: boolean } = {}) {
  await act(async () => {
    if (name === "enter") setup.mockInput.pressEnter();
    else if (name === "escape") setup.mockInput.pressEscape();
    else if (name === "tab") setup.mockInput.pressTab(options);
    else setup.mockInput.pressKey(name);
  });
  await setup.flush();
}

async function typeText(setup: TestRendererSetup, text: string) {
  await act(async () => setup.mockInput.typeText(text));
  await setup.flush();
}

/** Click `text` on the first row that holds it. */
async function click(setup: TestRendererSetup, text: string) {
  const rows = frame(setup).split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  if (y < 0) fail(`send gate: nothing to click for ${text}\n${frame(setup)}`);
  await act(async () => { await setup.mockMouse.click(rows[y]!.indexOf(text) + 1, y); await setup.mockMouse.moveTo(0, 0); });
  await setup.flush();
}

type Command = Parameters<ClientApi["dispatch"]>[0];
type ModeSet = Extract<Command, { type: "thread.interaction-mode.set" }>;
type TurnStart = Extract<Command, { type: "thread.turn.start" }>;

interface Gate {
  readonly command: Command;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

interface GateFixture {
  readonly client: ClientApi;
  readonly modeSets: Gate[];
  readonly turnStarts: Gate[];
}

const STARTED = { accepted: true, turnId: "turn-1", messageId: "m-1", delivery: "started", status: "running" };

/** A mock server that holds mode switches and turns until the scenario releases them. */
function gateFixture(): GateFixture {
  const modeSets: Gate[] = [];
  const turnStarts: Gate[] = [];
  const client: ClientApi = {
    ...baseClient,
    dispatch: (async (command: Record<string, unknown>) => {
      const typed = command as Command;
      if (typed.type === "thread.interaction-mode.set") {
        return new Promise<unknown>((resolve, reject) => { modeSets.push({ command: typed, resolve: resolve as (value: unknown) => void, reject }); });
      }
      if (typed.type === "thread.turn.start") {
        return new Promise<unknown>((resolve, reject) => { turnStarts.push({ command: typed, resolve: resolve as (value: unknown) => void, reject }); });
      }
      return await (baseClient.dispatch as (command: Record<string, unknown>) => Promise<never>)(command);
    }) as unknown as ClientApi["dispatch"],
  };
  return { client, modeSets, turnStarts };
}

/** The composer, focused, on the open thread. */
async function focusComposer(setup: TestRendererSetup) {
  await press(setup, "i");
}

function turnTexts(fixture: GateFixture): string[] {
  return fixture.turnStarts.map((entry) => (entry.command as TurnStart).message.text);
}

/** Every Enter below is single-flight: only turn.starts the screen sent. */
function starts(fixture: GateFixture): TurnStart[] {
  return fixture.turnStarts.map((entry) => entry.command as TurnStart);
}

/** A send gated on a mode switch runs once the switch lands, in the composer's mode. */
export async function runSendGate(): Promise<void> {
  // ── Double Enter while the switch is in flight sends once ──────────────────
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await typeText(setup, "hello");
      await press(setup, "enter");
      await press(setup, "enter");
      if (fixture.turnStarts.length !== 0) fail("the second Enter sent while the first was still gated");
      await act(async () => fixture.modeSets[0]!.resolve(true));
      await setup.flush();
      if (turnTexts(fixture).length !== 1 || turnTexts(fixture)[0] !== "hello") {
        fail(`double Enter sent ${JSON.stringify(turnTexts(fixture))}, not one "hello"`);
      }
      console.log("--- send gate: double Enter sends once ---");
      console.log(frame(setup));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // ── A dropped send restores the text, disarms the one-off, and says why ───
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await typeText(setup, "/research hello");
      await press(setup, "enter");
      await act(async () => fixture.modeSets[0]!.reject(new Error("mode switch refused by test")));
      await setup.flush();
      if (fixture.turnStarts.length !== 0) fail("a dropped send still dispatched its turn");
      await visible(setup, "hello");
      await visible(setup, "mode switch refused by test");
      // The dropped `/research` is disarmed: the retry sends in Build.
      await press(setup, "enter");
      await until(setup, () => fixture.turnStarts.length === 1, "the retry never sent");
      const retry = starts(fixture)[0]!;
      if (retry.message.text !== "hello" || retry.interactionMode !== undefined) {
        fail(`the retry sent ${JSON.stringify(retry.message.text)} with mode ${String(retry.interactionMode)}, not plain "hello"`);
      }
      console.log("--- send gate: a dropped send restores its text ---");
      console.log(frame(setup));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // ── Two switches, one send: the latest attempt decides ─────────────────────
  // Enter lands between the two Shift+Tabs, so the send is already waiting on
  // the first switch when the second arrives: it must wait for the second.
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await typeText(setup, "hello");
      await press(setup, "enter");
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await act(async () => fixture.modeSets[0]!.resolve(true));
      await setup.flush();
      if (fixture.turnStarts.length !== 0) fail("the send ran while the second switch was still in flight");
      await act(async () => fixture.modeSets[1]!.resolve(true));
      await setup.flush();
      if (turnTexts(fixture).length !== 1) fail(`the chained send dispatched ${turnTexts(fixture).length} turns, not one`);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // ── A failed first switch does not wipe the second switch's optimism ───────
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await act(async () => fixture.modeSets[0]!.reject(new Error("first switch refused by test")));
      await setup.flush();
      await visible(setup, "Orchestrate");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // ── Typing while gated is kept, and the send carries what Enter saw ────────
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await typeText(setup, "hello");
      await press(setup, "enter");
      await typeText(setup, " world");
      await act(async () => fixture.modeSets[0]!.resolve(true));
      await setup.flush();
      if (turnTexts(fixture).length !== 1 || turnTexts(fixture)[0] !== "hello") {
        fail(`the gated send carried ${JSON.stringify(turnTexts(fixture))}, not what Enter saw`);
      }
      await visible(setup, "world");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // ── Opening another thread leaves the old switch behind ────────────────────
  {
    const fixture = gateFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="thread" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await focusComposer(setup);
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await click(setup, "VibeCheck");
      await press(setup, "i");
      await typeText(setup, "other hello");
      await press(setup, "enter");
      await until(setup, () => fixture.turnStarts.length === 1, "the send on the new thread waited for the old thread's switch");
      if ((starts(fixture)[0]!.threadId as string) === "t-now") fail("the send went to the thread that was left");
      await act(async () => fixture.modeSets[0]!.resolve(true));
      await setup.flush();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }
}
