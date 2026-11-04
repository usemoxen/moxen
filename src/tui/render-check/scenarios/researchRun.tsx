import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { applyLanguage } from "../../i18n/index.js";
import { App } from "../fixtures.js";
import { fail } from "../helpers.js";
import { IDS, researchClient, type ResearchFixtureClient, type RunStage } from "../researchFixture.js";
import { testRender } from "../testrender.js";

/**
 * The research run view, driven the way a person drives it: rows found by
 * their words, glyphs clicked, keys pressed. A delegated run goes through its
 * phases (researching, waiting on the critic, finished), a user's own thread
 * leads a run, a role opens as a full thread and goes back, a narrow terminal
 * shows one column at a time, and the run size picker answers a proposal.
 */

const settle = async (setup: TestRendererSetup): Promise<void> => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  await setup.flush();
};

const press = async (setup: TestRendererSetup, name: string, options: { shift?: boolean } = {}): Promise<void> => {
  await act(async () => {
    if (name === "return") setup.mockInput.pressEnter();
    else if (name === "escape") setup.mockInput.pressEscape();
    else if (name === "tab") setup.mockInput.pressTab(options);
    else if (["left", "right", "up", "down"].includes(name)) setup.mockInput.pressArrow(name as "left");
    else setup.mockInput.pressKey(name, options);
  });
  await settle(setup);
};

/** Where `text` is on screen: the row it is on and the column it starts at. */
function find(setup: TestRendererSetup, text: string | RegExp, nth = 0): { x: number; y: number } {
  const hits: Array<{ x: number; y: number }> = [];
  setup.captureCharFrame().split("\n").forEach((line, y) => {
    const x = typeof text === "string" ? line.indexOf(text) : line.search(text);
    if (x !== -1) hits.push({ x, y });
  });
  const hit = hits[nth];
  if (!hit) fail(`"${String(text)}" is not on screen`);
  return hit;
}

const click = async (setup: TestRendererSetup, text: string | RegExp, nth = 0, dx = 1): Promise<void> => {
  const { x, y } = find(setup, text, nth);
  await act(async () => setup.mockMouse.click(x + dx, y));
  await settle(setup);
};

function frameOf(setup: TestRendererSetup, label: string): string {
  console.log(`--- ${label} ---`);
  const frame = setup.captureCharFrame();
  console.log(frame);
  return frame;
}

const expectIn = (frame: string, words: readonly string[], where: string): void => {
  for (const word of words) if (!frame.includes(word)) fail(`${where} lacks "${word}"`);
};
const expectNotIn = (frame: string, words: readonly string[], where: string): void => {
  for (const word of words) if (frame.includes(word)) fail(`${where} still shows "${word}"`);
};

/** The columns of the glyph row that carry a state glyph, left to right, within `Researchers … Critics`. */
function researcherGlyphs(setup: TestRendererSetup): Array<{ x: number; y: number; glyph: string }> {
  const { x: start, y } = find(setup, /Researchers\s+[✓◐◓◑◒○✗■]/u);
  const line = setup.captureCharFrame().split("\n")[y] ?? "";
  const end = line.indexOf("Critics");
  const glyphs: Array<{ x: number; y: number; glyph: string }> = [];
  for (let x = start + "Researchers".length; x < (end === -1 ? line.length : end); x += 1) {
    const glyph = line[x] ?? " ";
    if (/[✓◐◓◑◒○✗■]/u.test(glyph)) glyphs.push({ x, y, glyph });
  }
  return glyphs;
}

async function open(client: ResearchFixtureClient, size: { width: number; height: number }, language: "en" | "es-ES" = "en"): Promise<TestRendererSetup> {
  const setup = await testRender(<App client={client.client} onQuit={() => {}} launchView="thread" ui={{ language }} />, { ...size, exitOnCtrlC: false });
  await settle(setup);
  return setup;
}

export async function runResearchRun(): Promise<void> {
  const fixture = researchClient("researching");
  const setup = await open(fixture, { width: 150, height: 44 });
  try {
    // -- the sidebar: one entry for the run ------------------------------------------------
    const sidebar = setup.captureCharFrame();
    expectIn(sidebar, ["Retry strategies", "Webhook signature options"], "the sidebar");
    expectNotIn(sidebar, ["researcher: Read", "researcher: How", "critic:"], "the sidebar");
    if (!/◈ Retry strategies/u.test(sidebar)) fail("the run's lead has no research mark in the sidebar");

    // -- in progress ----------------------------------------------------------------------
    await click(setup, "Retry strategies");
    const researching = frameOf(setup, "research run: in progress");
    expectIn(researching, ["Research run · Retry strategies", "Researching", "4m 1", "Researchers", "Critics", "Finalizer", "Researcher 3", "Reading the retry code"], "the run in progress");
    expectNotIn(researching, ["Context", "Agents"], "the run in progress (no side panel)");
    const glyphs = researcherGlyphs(setup).map((entry) => (entry.glyph === "◓" || entry.glyph === "◑" || entry.glyph === "◒" ? "◐" : entry.glyph));
    if (glyphs.join("") !== "✓✓◐◐○") fail(`the roster shows ${glyphs.join(" ")}, not ✓ ✓ ◐ ◐ ○`);
    // Nothing started in the critic and finalizer columns: slivers, with their waiting words.
    expectIn(researching, ["Waiting for", "verdict.", "waiting"], "the quiet columns");

    // -- keys: arrows walk the roster, tab the columns ----------------------------------------
    await press(setup, "right");
    expectIn(frameOf(setup, "research run: next agent"), ["Researcher 4"], "the next agent");
    await press(setup, "left");
    await press(setup, "left");
    expectIn(setup.captureCharFrame(), ["Researcher 2"], "two agents back");
    await press(setup, "tab");
    await press(setup, "right");
    await press(setup, "right");
    // From the second researcher, tab moved to the critics' column and right walked the roster from there.
    // (The critics have not started, so the column says so.)
    expectIn(setup.captureCharFrame(), ["Critics"], "the critics' column");

    // -- clicks: a glyph shows that agent in its column ------------------------------------------
    const first = researcherGlyphs(setup)[0]!;
    await act(async () => setup.mockMouse.click(first.x, first.y));
    await settle(setup);
    expectIn(setup.captureCharFrame(), ["Researcher 1"], "a click on the first researcher's glyph");
    expectIn(setup.captureCharFrame(), ["Report 1 headline"], "the first researcher's report");

    // -- going deeper: enter opens the agent in full, with a way back ----------------------------
    await press(setup, "tab", { shift: true });
    await press(setup, "tab");
    await press(setup, "return");
    const full = frameOf(setup, "research run: a researcher in full");
    expectIn(full, ["← back to the run", "Researcher 1", "part of the research run"], "a researcher opened in full");
    expectNotIn(full, ["Research run · Retry strategies"], "a researcher opened in full");
    if (!/◈ Retry strategies/u.test(full)) fail("the lead's row is not the open one while a role is read in full");
    await click(setup, "← back to the run");
    expectIn(setup.captureCharFrame(), ["Research run · Retry strategies", "Researcher 1"], "the run after the way back");
    await press(setup, "return");
    await press(setup, "escape");
    expectIn(setup.captureCharFrame(), ["Research run · Retry strategies"], "the run after escape");
    // The lead's own thread, from the footer link.
    await click(setup, "lead thread ↗");
    expectIn(setup.captureCharFrame(), ["Lead thread", "← back to the run"], "the lead thread in full");
    await press(setup, "escape");

    // -- waiting on the critic -----------------------------------------------------------------
    await act(async () => fixture.setStage("reviewing"));
    await settle(setup);
    const reviewing = frameOf(setup, "research run: waiting on the critic");
    expectIn(reviewing, ["Reviewing", "Critic 3 · Alternatives", "verdict."], "the run waiting on the critic");
    expectNotIn(reviewing, ["Researcher 5"], "the run waiting on the critic");

    // -- finished ---------------------------------------------------------------------------
    await act(async () => fixture.setStage("finished"));
    await settle(setup);
    const finished = frameOf(setup, "research run: finished");
    expectIn(finished, ["Finished", "Finalizer", "Use exponential backoff"], "the finished run");
    const elapsed = /Finished · (\d+)m (\d+)s/u.exec(finished);
    if (!elapsed) fail("the finished run shows no elapsed time");

    // -- a user's own thread that leads a run ---------------------------------------------------
    await click(setup, "Webhook signature options");
    const own = frameOf(setup, "research run: a thread the user runs directly");
    expectIn(own, ["Research run · Webhook signature options", "Researching", "How do they treat replayed deliveries?"], "the user's own run");
    expectNotIn(own, ["researcher: Which"], "the user's own run (roles have no sidebar rows)");
  } finally {
    setup.renderer.destroy();
  }

  // -- a narrow terminal: one column at a time under a switcher ---------------------------------
  const narrowFixture = researchClient("reviewing");
  const narrow = await open(narrowFixture, { width: 96, height: 40 });
  try {
    await click(narrow, "Retry strategies");
    const one = frameOf(narrow, "research run: narrow terminal");
    expectIn(one, ["Researchers", "Critics", "Finalizer", "Critic"], "the narrow run");
    if (one.split("\n").some((line) => line.length > 96)) fail("the narrow run is wider than the terminal");
    await click(narrow, /^.*Researchers /u, 1, 3);
    await click(narrow, "Finalizer", 1);
    const switched = frameOf(narrow, "research run: narrow, finalizer column");
    expectIn(switched, ["Waiting for a critic verdict."], "the switched column");
    expectNotIn(switched, ["Critic 2 · Risks"], "the finalizer column alone");
  } finally {
    narrow.renderer.destroy();
  }

  await runPicker();
  await runResearchSpanish();
}

async function runPicker(): Promise<void> {
  const fixture = researchClient("researching");
  const setup = await open(fixture, { width: 150, height: 44 });
  try {
    await click(setup, "Compare webhook libraries");
    if (!fixture.optedIn.has(IDS.draft)) fail("a thread in Research mode did not opt in to run sizes");
    await act(async () => fixture.propose());
    await settle(setup);
    await settle(setup);
    const picker = frameOf(setup, "research picker: a run size to choose");
    expectIn(picker, ["Full research run", "Researchers", "Critics", "Finalizer", "Start", "One researcher instead", "10 threads", "Claude Opus 5"], "the picker");
    expectIn(picker, ["●●●●●○○○"], "the researchers' dots");
    // Down to the critics, right: 1 and 3 only, never 2.
    await press(setup, "down");
    await press(setup, "left");
    expectIn(setup.captureCharFrame(), ["One critic does Evidence, Risks"], "one critic");
    await press(setup, "right");
    const three = frameOf(setup, "research picker: three critics");
    expectIn(three, ["One each: Evidence, Risks"], "three critics");
    expectNotIn(three, ["Two critics", "One critic does"], "three critics");
    await press(setup, "up");
    await press(setup, "left");
    await press(setup, "left");
    // A click on a dot sets the researchers.
    const dots = find(setup, "●●●○○○○○");
    await act(async () => setup.mockMouse.click(dots.x + 5, dots.y));
    await settle(setup);
    expectIn(setup.captureCharFrame(), ["●●●●●●○○"], "a click on the sixth dot");
    await click(setup, "Start");
    const answer = fixture.dispatched.find((command) => command.type === "research.proposal.answer");
    if (!answer || answer.choice !== "start") fail("Start did not answer the proposal");
    const size = (answer.plan as { size: { researchers: number; critics: number } }).size;
    if (size.researchers !== 6 || size.critics !== 3) fail(`Start answered ${JSON.stringify(size)}, not 6 researchers and 3 critics`);
    expectNotIn(setup.captureCharFrame(), ["Full research run"], "the screen after Start");

    // Escape is one researcher instead.
    await act(async () => fixture.propose());
    await settle(setup);
    await settle(setup);
    expectIn(setup.captureCharFrame(), ["Full research run"], "a second proposal");
    await press(setup, "escape");
    const single = fixture.dispatched.filter((command) => command.type === "research.proposal.answer").at(-1);
    if (!single || single.choice !== "single") fail("Escape did not choose one researcher");
  } finally {
    setup.renderer.destroy();
  }
}

async function runResearchSpanish(): Promise<void> {
  const fixture = researchClient("reviewing");
  const setup = await open(fixture, { width: 150, height: 44 }, "es-ES");
  try {
    await click(setup, "Retry strategies");
    const run = frameOf(setup, "español: investigación en marcha");
    expectIn(run, ["Investigación · Retry strategies", "Revisando", "Investigadores", "Críticos", "Redactor final", "veredicto"], "la investigación");
    await click(setup, "Compare webhook libraries");
    await act(async () => fixture.propose());
    await settle(setup);
    await settle(setup);
    const picker = frameOf(setup, "español: tamaño de la investigación");
    expectIn(picker, ["Investigación completa", "Empezar", "Un solo investigador", "hilos, contando el principal"], "el selector");
    await press(setup, "escape");
  } finally {
    setup.renderer.destroy();
    applyLanguage("en");
  }
}

export type { RunStage };
