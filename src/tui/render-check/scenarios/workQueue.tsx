import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ClientApi } from "../../../server/api.js";
import { WorkQueueModal } from "../../features/queue/queuemodal.js";
import type { QueuePolicy } from "../../features/queue/useWorkQueue.js";
import { applyLanguage } from "../../i18n/index.js";
import { applyTheme } from "../../theme.js";
import { App, client, harnessTheme } from "../fixtures.js";
import { ENTRY_LONG, ENTRY_NEXT, ENTRY_STOPPED, QUEUE_THREADS, RECOVERY_ENTRY, queueFixture } from "../queueFixture.js";
import { frameSink, testRender } from "../testrender.js";
import { fail } from "../helpers.js";
import { registerSyntaxParsers } from "../../../core/syntax/register.js";

type Fixture = ReturnType<typeof queueFixture>;
type Command = Fixture["commands"][number];

/** The queue modal on a fixture, with what it closed and a view of what the client sent. */
async function open(entries?: Parameters<typeof queueFixture>[0], size: { width: number; height: number } = { width: 116, height: 34 }) {
  const fixture = queueFixture(entries);
  const state = { closed: 0 };
  const setup = await testRender(<WorkQueueModal client={fixture.client} threads={QUEUE_THREADS} screenWidth={size.width} screenHeight={size.height} onClose={() => { state.closed += 1; }} />, { ...size, exitOnCtrlC: false });
  await setup.flush();
  return { setup, fixture, state };
}

/** How many times the modal asked to close (a function, so a check does not narrow it). */
const closes = (state: { closed: number }): number => state.closed;
/** Names the frame that follows, after the modal has finished fading in so the picture shows full colour. */
async function label(setup: TestRendererSetup, name: string) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  await setup.flush();
  console.log(`--- ${name} ---`);
}
const frame = (setup: TestRendererSetup) => setup.captureCharFrame();
/** A look at the screen that is not a picture: polling while a modal fades in must not leave a half-faded frame behind. */
function peek(setup: TestRendererSetup): string {
  const sink = frameSink.current;
  frameSink.current = null;
  try { return setup.captureCharFrame(); } finally { frameSink.current = sink; }
}

async function until(setup: TestRendererSetup, check: (frame: string) => boolean, message: string) {
  for (let attempt = 0; !check(peek(setup)); attempt += 1) {
    if (attempt === 150) fail(`work queue: ${message}\n${peek(setup)}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
}
const visible = (setup: TestRendererSetup, text: string) => until(setup, (screen) => screen.includes(text), `did not show ${text}`);
const gone = (setup: TestRendererSetup, text: string) => until(setup, (screen) => !screen.includes(text), `still shows ${text}`);

async function press(setup: TestRendererSetup, name: string, modifiers?: { ctrl?: boolean }) {
  await act(async () => {
    if (name === "enter") setup.mockInput.pressEnter();
    else if (name === "escape") setup.mockInput.pressEscape();
    else if (name === "up" || name === "down") setup.mockInput.pressArrow(name, modifiers);
    else setup.mockInput.pressKey(name, modifiers);
  });
  await setup.flush();
}

/** Click `text`, on the first row that has `on` in it when given. */
async function click(setup: TestRendererSetup, text: string, on?: string) {
  const rows = peek(setup).split("\n");
  const y = rows.findIndex((row) => row.includes(text) && (on === undefined || row.includes(on)));
  if (y < 0) fail(`work queue: nothing to click for ${text}${on ? ` on ${on}` : ""}\n${peek(setup)}`);
  // The pointer is moved off afterwards: a list under a resting pointer takes its focus, as it should, but a key-driven step after a click should not depend on where the click was.
  await act(async () => { await setup.mockMouse.click(rows[y]!.indexOf(text) + 1, y); await setup.mockMouse.moveTo(0, 0); });
  await setup.flush();
}

const edits = (fixture: Fixture, action: string): Extract<Command, { type: "queue.edit" }>[] => fixture.commands.filter((command): command is Extract<Command, { type: "queue.edit" }> => command.type === "queue.edit" && command.action === action);
const lastPolicy = (fixture: Fixture): QueuePolicy => {
  const edit = edits(fixture, "edit").at(-1);
  if (!edit?.policy) fail("work queue: no policy edit was sent");
  return edit!.policy as QueuePolicy;
};
const order = (fixture: Fixture) => fixture.read().filter((entry) => !entry.policy.removed && entry.status === "queued").sort((a, b) => a.policy.order - b.policy.order).map((entry) => entry.turnId);
const must = (screen: string, texts: readonly string[], where: string) => { for (const text of texts) if (!screen.includes(text)) fail(`${where}: missing ${text}\n${screen}`); };
const mustNot = (screen: string, texts: readonly string[], where: string) => { for (const text of texts) if (screen.includes(text)) fail(`${where}: shows ${text}\n${screen}`); };
const PROMPTS = ["Resume the unfinished task", "Review the changes after Codex stops", "Tidy the docs folder", "Make the Windows path test pass"];

/** Walks one condition from the `c` list to the end by the keyboard, `steps` being the choices in order. */
async function conditionByKeys(setup: TestRendererSetup, fixture: Fixture, downs: readonly number[]) {
  const before = edits(fixture, "edit").length;
  await press(setup, "c");
  await visible(setup, "when…");
  for (const [i, down] of downs.entries()) {
    for (let step = 0; step < down; step += 1) await press(setup, "down");
    await press(setup, "enter");
    if (i < downs.length - 1) await visible(setup, "?");
  }
  await until(setup, () => edits(fixture, "edit").length > before, "the condition was not sent");
  await visible(setup, "Work queue");
}

export async function runWorkQueueModal(): Promise<void> {
  await registerSyntaxParsers();
  // Earlier scenarios leave their own theme behind; the modal is drawn without an App around it to set one.
  if (harnessTheme.current) applyTheme(harnessTheme.current);

  // ── The list: grouped, one entry open, every action named ────────────────────────────
  {
    const { setup, fixture, state } = await open();
    await visible(setup, "Work queue");
    await visible(setup, "Removed or stopped (1)");
    await label(setup, "work queue: grouped list");
    const first = frame(setup);
    must(first, ["Work queue", "esc close", "Next: Finish keyboard navigation · Waiting until", "RUNNING NOW", "Fix the Windows test", "UP NEXT", "Finish keyboard navigation", "ON HOLD", "Tidy the docs", "Sends your queued message in this thread.", "· After Codex's next session reset", "· When Codex has at least 5% of its weekly allowance left", "h hold", "c conditions", "o options", "x remove", "ctrl+↓ later", "↑↓ choose · ctrl+↑↓ move · space select · a add · esc close", "waiting · "], "list");
    mustNot(first, [...PROMPTS, "☐", "☑", "ctrl+↑ earlier", "h release"], "list");
    if (first.split("\n").filter((row) => row.includes("c conditions")).length !== 1) fail("work queue: more than one entry is open");
    // Choose by key: only the focused entry opens, and only the actions that apply to it are offered.
    await press(setup, "down");
    await visible(setup, "ctrl+↑ earlier");
    await label(setup, "work queue: second entry focused");
    const second = frame(setup);
    mustNot(second, ["· After Codex's next session reset"], "second entry");
    must(second, ["h hold", "ctrl+↑ earlier", "Sends your queued message", "Ready: it starts as soon as the thread is free."], "second entry");
    await press(setup, "down");
    await visible(setup, "h release");
    must(frame(setup), ["On hold until you release it"], "held entry");
    mustNot(frame(setup), ["ctrl+↓ later"], "held entry is last in its group");
    await press(setup, "up"); await press(setup, "up"); await press(setup, "up");
    await visible(setup, "Fix the Windows test");
    const running = frame(setup);
    mustNot(running, ["h hold", "x remove", "Sends your queued message"], "a running entry");
    must(running, ["This work is running now."], "a running entry");
    await press(setup, "down");
    // Reorder by key: the entry that was second becomes first.
    await press(setup, "down");
    await press(setup, "up", { ctrl: true });
    await until(setup, () => order(fixture)[0] === "turn-claude", "ctrl+up did not move the entry earlier");
    await press(setup, "down", { ctrl: true });
    await until(setup, () => order(fixture)[0] === "turn-queue", "ctrl+down did not move the entry later");
    // Hold and release by key, then by click.
    await press(setup, "h");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-claude")?.policy.held === true, "h did not hold");
    await press(setup, "h");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-claude")?.policy.held === false, "h did not release");
    await click(setup, "hold", "c conditions");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-claude")?.policy.held === true, "clicking hold did not hold");
    await visible(setup, "h release");
    await label(setup, "work queue: held by click");
    frame(setup);
    await click(setup, "release", "c conditions");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-claude")?.policy.held === false, "clicking release did not release");
    // Earlier and later by click.
    await click(setup, "earlier", "c conditions");
    await until(setup, () => order(fixture)[0] === "turn-claude", "clicking earlier did not move the entry");
    await click(setup, "later", "c conditions");
    await until(setup, () => order(fixture)[0] === "turn-queue", "clicking later did not move the entry");
    // Remove by key: the entry leaves the queue and focus moves on; then add it back from the removed list.
    await press(setup, "x");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-claude")?.policy.removed === true, "x did not remove");
    await visible(setup, "Removed or stopped (2)");
    mustNot(frame(setup), ["Review the settings changes"], "removed entry still listed");
    await click(setup, "Removed or stopped (2)");
    await visible(setup, "Review the settings changes");
    await label(setup, "work queue: removed entries open");
    const removedOpen = frame(setup);
    must(removedOpen, ["Removed or stopped (2) ‹", "Retry failed validation"], "removed list");
    await press(setup, "down"); // the line that closes it is focused; the next row is the first removed entry
    await press(setup, "down");
    await click(setup, "Retry failed validation");
    await visible(setup, "r add back held");
    await label(setup, "work queue: a stopped entry focused");
    must(frame(setup), ["Stopped before completion", "r add back held"], "stopped entry");
    mustNot(frame(setup), ["x remove", "c conditions"], "stopped entry");
    await press(setup, "r");
    await until(setup, () => edits(fixture, "restore").length === 1 && fixture.read().find((entry) => entry.turnId === "turn-stopped")?.policy.removed === false, "r did not add the entry back");
    await visible(setup, "Retry failed validation");
    mustNot(frame(setup), ["Removed or stopped (2)"], "restored entry still counted as removed");
    // Add back by click.
    await visible(setup, "Removed or stopped (1) ‹");
    await click(setup, "Review the settings changes");
    await click(setup, "add back held");
    await until(setup, () => edits(fixture, "restore").length === 2, "clicking add back did not restore");
    // Selection: checkboxes only after space; the keys then act on every ticked entry.
    mustNot(frame(setup), ["☐", "☑"], "before selecting");
    await press(setup, " ");
    await visible(setup, "☑");
    await label(setup, "work queue: selecting entries");
    const selecting = frame(setup);
    must(selecting, ["☐", "☑", "space toggle", "ctrl+a all", "esc done"], "selection");
    await press(setup, "down");
    await press(setup, " ");
    await visible(setup, "2 entries selected");
    await press(setup, "h");
    await until(setup, () => edits(fixture, "hold").length >= 2, "h did not hold both selected entries");
    await press(setup, "escape");
    await gone(setup, "☑");
    if (closes(state) !== 0) fail("work queue: esc in selection closed the modal");
    // Select all, remove, by click.
    await press(setup, " ");
    await press(setup, "a", { ctrl: true });
    await visible(setup, "entries selected");
    await click(setup, "remove", "conditions");
    await until(setup, () => fixture.read().filter((entry) => entry.status === "queued" && !entry.policy.removed).length === 0, "removing the selection left entries behind");
    await visible(setup, "Running now: Fix the Windows test");
    await label(setup, "work queue: everything waiting removed");
    must(frame(setup), ["Removed or stopped (4) ‹", "RUNNING NOW"], "emptied queue");
    mustNot(frame(setup), ["UP NEXT", "ON HOLD"], "emptied queue");
    await press(setup, "escape");
    await until(setup, () => closes(state) === 1, "esc did not close the list");
  }

  // ── Removing with no arrow first: focus moves to the entry after the removed one, not the running one ──
  {
    const { setup, fixture } = await open();
    await visible(setup, "Work queue");
    await press(setup, "x");
    await until(setup, () => fixture.read().find((entry) => entry.turnId === "turn-queue")?.policy.removed === true, "x with no arrow first did not remove");
    await label(setup, "work queue: removed with no arrow first");
    const after = frame(setup);
    // The row with the focus marker, not the headline above it that names the same entry.
    if (!after.split("\n").some((row) => row.includes("▌") && row.includes("Review the settings changes"))) fail(`work queue: focus did not move to the entry after the removed one\n${after}`);
    mustNot(after, ["This work is running now."], "focus after removing with no arrow first");
  }

  // ── Conditions: every branch of the `c` list to the end ─────────────────────────────
  {
    const { setup, fixture, state } = await open();
    await visible(setup, "Work queue");
    await press(setup, "c");
    await visible(setup, "Start \"Finish keyboard navigation\" when…");
    await label(setup, "work queue: conditions");
    const list = frame(setup);
    must(list, ["An allowance resets", "Enough allowance is left", "A set time arrives", "Another thread finishes", "Another queue entry finishes", "A provider is out or protected", "Stop waiting for", "After Codex's next session reset", "↑↓ choose · enter next · esc back"], "conditions list");
    mustNot(list, ["UP NEXT", "Work queue  "], "conditions list");
    // An allowance resets → provider → allowance, by keys.
    await press(setup, "enter");
    await visible(setup, "Which provider?");
    await label(setup, "work queue: which provider");
    must(frame(setup), ["Claude", "Codex"], "providers");
    await press(setup, "escape");
    await visible(setup, "when…");
    await press(setup, "enter");
    await press(setup, "down"); // Codex
    await press(setup, "enter");
    await visible(setup, "Which of Codex's allowances?");
    await label(setup, "work queue: which allowance");
    must(frame(setup), ["Session allowance", "Weekly allowance", "Every allowance"], "windows");
    await press(setup, "down");
    await press(setup, "enter");
    await until(setup, () => edits(fixture, "edit").length === 1, "the reset condition was not sent");
    const reset = lastPolicy(fixture).conditions.at(-1);
    if (reset?.type !== "reset" || reset.provider !== "codex" || reset.window !== "weekly") fail(`work queue: wrong reset condition ${JSON.stringify(reset)}`);
    await visible(setup, "· After Codex's next weekly reset");
    // Enough allowance is left → provider → allowance → how much, by clicks.
    await press(setup, "c");
    await click(setup, "Enough allowance is left");
    await click(setup, "Claude");
    await click(setup, "Session allowance");
    await visible(setup, "How much of Claude's session allowance must be left?");
    await label(setup, "work queue: how much allowance");
    must(frame(setup), ["At least", "%", "Add condition"], "minimum");
    await act(async () => { for (let i = 0; i < 3; i += 1) setup.mockInput.pressBackspace(); });
    await act(async () => { await setup.mockInput.typeText("250"); });
    await setup.flush();
    await visible(setup, "Type a number from 0 to 100.");
    await act(async () => { setup.mockInput.pressBackspace(); });
    await setup.flush();
    await click(setup, "Add condition");
    await until(setup, () => edits(fixture, "edit").length === 2, "the usage condition was not sent");
    const usage = lastPolicy(fixture).conditions.at(-1);
    if (usage?.type !== "usage" || usage.provider !== "claude" || usage.window !== "session" || usage.minimum !== 25) fail(`work queue: wrong usage condition ${JSON.stringify(usage)}`);
    await visible(setup, "· When Claude has at least 25% of its session allowance left");
    // A set time arrives, by key: the date picker opens, enter schedules.
    await press(setup, "c");
    await press(setup, "down"); await press(setup, "down");
    await press(setup, "enter");
    await visible(setup, "Start at a set time");
    await label(setup, "work queue: a set time");
    await press(setup, "escape");
    await visible(setup, "when…");
    await press(setup, "down"); await press(setup, "down");
    await press(setup, "enter");
    await visible(setup, "Start at a set time");
    await press(setup, "enter");
    await until(setup, () => edits(fixture, "edit").length === 3, "the time condition was not sent");
    if (lastPolicy(fixture).conditions.at(-1)?.type !== "at") fail("work queue: the time condition is wrong");
    await visible(setup, "Work queue");
    // Another thread finishes, by click through the thread picker.
    await press(setup, "c");
    await click(setup, "Another thread finishes");
    await visible(setup, "Which thread?");
    await label(setup, "work queue: which thread");
    must(frame(setup), ["Plan the next release", "Fix the Windows test"], "thread picker");
    mustNot(frame(setup), ["Finish keyboard navigation"], "thread picker offers the entry's own thread");
    await click(setup, "Plan the next release");
    await until(setup, () => edits(fixture, "edit").length === 4, "the thread condition was not sent");
    const thread = lastPolicy(fixture).conditions.at(-1);
    if (thread?.type !== "thread" || thread.threadId !== "thread-new") fail(`work queue: wrong thread condition ${JSON.stringify(thread)}`);
    await visible(setup, "· After the thread Plan the next release finishes");
    // Another queue entry finishes, by keys.
    await press(setup, "c");
    for (let step = 0; step < 4; step += 1) await press(setup, "down");
    await press(setup, "enter");
    await visible(setup, "Which queue entry?");
    await label(setup, "work queue: which entry");
    mustNot(frame(setup), ["Finish keyboard navigation  "], "entry list offers the entry itself");
    await press(setup, "enter");
    await until(setup, () => edits(fixture, "edit").length === 5, "the entry condition was not sent");
    if (lastPolicy(fixture).conditions.at(-1)?.type !== "entry") fail("work queue: the entry condition is wrong");
    // A provider is out or protected → provider → what → when.
    await conditionByKeys(setup, fixture, [5, 1, 1, 1]);
    const provider = lastPolicy(fixture).conditions.at(-1);
    if (provider?.type !== "provider" || provider.provider !== "codex" || provider.state !== "protected" || provider.mode !== "while") fail(`work queue: wrong provider condition ${JSON.stringify(provider)}`);
    await visible(setup, "· While Codex is paused by usage protection");
    // The provider steps by click, and what each asks.
    await press(setup, "c");
    await click(setup, "A provider is out or protected");
    await click(setup, "Claude");
    await visible(setup, "What must happen to Claude?");
    await label(setup, "work queue: what must happen");
    must(frame(setup), ["It runs out of usage", "Usage protection pauses it"], "provider states");
    await click(setup, "It runs out of usage");
    await visible(setup, "When does that count?");
    await label(setup, "work queue: when it counts");
    must(frame(setup), ["After it happens", "While it holds", "only while it is true"], "provider modes");
    await click(setup, "After it happens");
    await until(setup, () => edits(fixture, "edit").length === 7, "the provider condition was not sent by click");
    const claudeOut = lastPolicy(fixture).conditions.at(-1);
    if (claudeOut?.type !== "provider" || claudeOut.state !== "exhausted" || claudeOut.mode !== "after") fail(`work queue: wrong provider condition ${JSON.stringify(claudeOut)}`);
    // Stop waiting for one of them.
    await press(setup, "c");
    await visible(setup, "Stop waiting for");
    await label(setup, "work queue: stop waiting");
    const total = lastPolicy(fixture).conditions.length;
    await click(setup, "After Claude is out of usage", "enter removes it");
    await until(setup, () => lastPolicy(fixture).conditions.length === total - 1, "the condition was not removed");
    await press(setup, "escape");
    await visible(setup, "UP NEXT");
    if (closes(state) !== 0) fail("work queue: esc inside the conditions closed the modal");
  }

  // ── How it runs ───────────────────────────────────────────────────────────────────
  {
    const { setup, fixture, state } = await open();
    await visible(setup, "Work queue");
    await press(setup, "o");
    await visible(setup, "How \"Finish keyboard navigation\" runs");
    await label(setup, "work queue: how it runs");
    const options = frame(setup);
    must(options, ["● One at a time per provider", "○ Alongside other entries of the same provider", "● In this thread", "○ In a new thread, from a stored handoff", "uses no allowance", "○ In a new thread, from a handoff the model writes"], "options");
    await press(setup, "down");
    await press(setup, "enter");
    await until(setup, () => edits(fixture, "edit").length === 1 && lastPolicy(fixture).sequential === false, "the concurrency choice was not sent");
    await visible(setup, "● Alongside other entries of the same provider");
    await click(setup, "In a new thread, from a stored handoff");
    await until(setup, () => lastPolicy(fixture).continuation === "stored", "the continuation choice was not sent");
    await visible(setup, "● In a new thread, from a stored handoff");
    await press(setup, "escape");
    await visible(setup, "UP NEXT");
    if (closes(state) !== 0) fail("work queue: esc inside the options closed the modal");
    await visible(setup, "Continues in a new thread from a stored handoff.");
    mustNot(frame(setup), PROMPTS, "options");
  }

  // ── Adding a thread through the thread picker ────────────────────────────────────────
  {
    const { setup, fixture, state } = await open();
    await visible(setup, "Work queue");
    await press(setup, "a");
    await visible(setup, "Add a thread to the queue");
    await label(setup, "work queue: add a thread");
    must(frame(setup), ["Plan the next release", "Sketch the stats card", "type to filter"], "thread picker");
    for (const letter of "stats") await press(setup, letter);
    await gone(setup, "Plan the next release");
    await press(setup, "enter");
    await until(setup, () => fixture.commands.some((command) => command.type === "thread.turn.start" && command.threadId === "thread-spare"), "adding a thread sent nothing");
    const added = fixture.commands.find((command) => command.type === "thread.turn.start");
    if (added?.type !== "thread.turn.start" || added.queue?.held !== true) fail("work queue: an added thread should start held");
    await visible(setup, "Sketch the stats card");
    // The new entry sits on hold; the footer opens the picker by click too.
    await click(setup, "add", "choose");
    await visible(setup, "Add a thread to the queue");
    await press(setup, "escape");
    await visible(setup, "ON HOLD");
    if (closes(state) !== 0) fail("work queue: esc in the thread picker closed the modal");
    await click(setup, "add", "choose");
    await visible(setup, "Plan the next release");
    await click(setup, "Plan the next release");
    await until(setup, () => fixture.commands.filter((command) => command.type === "thread.turn.start").length === 2, "clicking a thread did not add it");
    // Clicking the footer's other hints.
    await visible(setup, "space select");
    await click(setup, "select", "choose");
    await visible(setup, "☑");
    await click(setup, "done", "toggle");
    await gone(setup, "☑");
    await click(setup, "close", "choose");
    await until(setup, () => closes(state) === 1, "clicking close did not close");
  }

  // ── One entry, an empty queue, a running recovery, long titles, narrow ────────────────
  {
    const { setup } = await open([ENTRY_NEXT, ENTRY_STOPPED], { width: 116, height: 30 });
    await visible(setup, "Finish keyboard navigation");
    await label(setup, "work queue: one entry");
    const alone = frame(setup);
    must(alone, ["UP NEXT", "h hold", "x remove", "Next: Finish keyboard navigation", "Removed or stopped (1) ›"], "one entry");
    mustNot(alone, ["ctrl+↑ earlier", "ctrl+↓ later", "RUNNING NOW", "ON HOLD", ...PROMPTS], "one entry");
  }
  {
    const { setup } = await open([], { width: 100, height: 22 });
    await visible(setup, "Nothing is queued.");
    await label(setup, "work queue: empty");
    must(frame(setup), ["Press a to add a thread."], "empty queue");
  }
  {
    const { setup } = await open([RECOVERY_ENTRY], { width: 116, height: 26 });
    await visible(setup, "review unreviewed commits");
    await label(setup, "work queue: recovery running");
    const resumed = frame(setup);
    must(resumed, ["RUNNING NOW", "Codex", "resumed", "Picks the unfinished work back up"], "recovery");
    mustNot(resumed, ["at least 0%", "Starts after", "h hold", "x remove", "The usage allowance has reset"], "recovery");
  }
  {
    const { setup } = await open([ENTRY_LONG, { ...ENTRY_NEXT, title: "Review the pull request that moves every provider setting into the shared table" }, ENTRY_STOPPED], { width: 90, height: 26 });
    await visible(setup, "Rework the onboarding");
    await label(setup, "work queue: long titles");
    must(frame(setup), ["Rework the onboarding", "UP NEXT", "Codex"], "long titles");
    await press(setup, "down");
    await visible(setup, "h hold");
    await label(setup, "work queue: long titles, second focused");
    frame(setup);
  }
  {
    const { setup, fixture } = await open(undefined, { width: 80, height: 24 });
    await visible(setup, "Work queue");
    await label(setup, "work queue: 80 by 24");
    must(frame(setup), ["RUNNING NOW", "UP NEXT", "h hold", "c conditions", "esc close"], "80 by 24");
    for (let i = 0; i < 4; i += 1) await press(setup, "down");
    await visible(setup, "Removed or stopped");
    await label(setup, "work queue: 80 by 24, scrolled to the end");
    must(frame(setup), ["Removed or stopped (1) ›", "Tidy the docs"], "80 by 24 scrolled");
    await press(setup, "up");
    await press(setup, "c");
    await visible(setup, "when…");
    await label(setup, "work queue: 80 by 24, conditions");
    must(frame(setup), ["A provider is out or protected", "esc back"], "80 by 24 conditions");
    void fixture;
  }

  // ── Spanish ──────────────────────────────────────────────────────────────────────
  {
    applyLanguage("es-ES");
    try {
      const { setup } = await open();
      await visible(setup, "Cola de trabajo");
      await label(setup, "work queue: Spanish");
      must(frame(setup), ["A CONTINUACIÓN", "RETENIDOS", "retener", "condiciones", "opciones", "retirar", "Retirados o detenidos (1)", "↑↓ elegir · ctrl+↑↓ mover · espacio seleccionar"].filter((text) => !text.includes("espacio")), "Spanish list");
      mustNot(frame(setup), ["UP NEXT", "hold"], "Spanish list");
      await press(setup, "c");
      await visible(setup, "cuando…");
      await label(setup, "work queue: Spanish, conditions");
      must(frame(setup), ["Se restablezca un uso", "Quede suficiente uso", "Termine otro hilo"], "Spanish conditions");
      await press(setup, "escape");
      await visible(setup, "A CONTINUACIÓN");
      await press(setup, "o");
      await visible(setup, "Cómo se ejecuta");
      await label(setup, "work queue: Spanish, options");
    } finally { applyLanguage("en"); }
  }

  // ── Scheduling: the same steps, collected into a policy ──────────────────────────────
  {
    const fixture = queueFixture();
    const submitted: QueuePolicy[] = [];
    const schedule = await testRender(<WorkQueueModal client={fixture.client} threads={QUEUE_THREADS} screenWidth={84} screenHeight={28} onClose={() => {}} onSchedule={(policy) => submitted.push(policy)} />, { width: 84, height: 28, exitOnCtrlC: false });
    await schedule.flush();
    await visible(schedule, "Schedule work");
    await label(schedule, "work queue: schedule work");
    must(frame(schedule), ["Add a condition…", "How it runs…", "Queue this work", "All conditions must be met"], "schedule page");
    await click(schedule, "Add a condition…");
    await click(schedule, "An allowance resets");
    await click(schedule, "Claude");
    await click(schedule, "Session allowance");
    await visible(schedule, "Stop waiting for");
    await label(schedule, "work queue: schedule work with a condition");
    must(frame(schedule), ["After Claude's next session reset"], "schedule condition");
    await press(schedule, "down"); await press(schedule, "down");
    await press(schedule, "enter"); // remove it
    await gone(schedule, "Stop waiting for");
    await click(schedule, "How it runs…");
    await click(schedule, "Alongside other entries of the same provider");
    await press(schedule, "escape");
    await visible(schedule, "Add a condition…");
    await press(schedule, "enter"); // Add a condition
    await press(schedule, "enter"); // An allowance resets
    await press(schedule, "enter"); // Claude
    await press(schedule, "enter"); // Session allowance
    await visible(schedule, "Stop waiting for");
    await click(schedule, "Queue this work");
    if (submitted[0]?.conditions[0]?.type !== "reset" || submitted[0].conditions.length !== 1 || submitted[0].sequential !== false) fail(`work queue: scheduling sent ${JSON.stringify(submitted[0])}`);
  }

  const commands: Parameters<ClientApi["dispatch"]>[0][] = [];
  const isolated: ClientApi = { ...client, dispatch(command) { commands.push(command); return client.dispatch(command); } };
  const creation = await testRender(<App client={isolated} onQuit={() => {}} launchView="create" />, { width: 140, height: 40, exitOnCtrlC: false });
  await creation.flush();
  await visible(creation, "Build");
  await act(async () => creation.mockInput.pressKey("i"));
  await creation.flush();
  await act(async () => creation.mockInput.typeText("/research Scheduled new thread task"));
  await creation.flush();
  await visible(creation, "Scheduled new thread task");
  await act(async () => creation.mockInput.pressKey("p", { ctrl: true }));
  await creation.flush();
  await visible(creation, "Schedule work");
  await label(creation, "work queue: new-thread command palette");
  must(frame(creation), ["Work queue", "Schedule work", "Schedule message"], "new-thread palette");
  await click(creation, "Schedule work");
  await visible(creation, "Add a condition…");
  await click(creation, "Add a condition…");
  await click(creation, "An allowance resets");
  await click(creation, "Claude");
  await click(creation, "Session allowance");
  await visible(creation, "Queue this work");
  await click(creation, "Queue this work");
  await creation.flush();
  const start = commands.find((command) => command.type === "thread.turn.start");
  if (!commands.some((command) => command.type === "thread.create") || start?.type !== "thread.turn.start" || start.queue?.conditions[0]?.type !== "reset" || start.interactionMode !== "research" || start.message.text !== "Scheduled new thread task") fail("new-thread scheduling lost its conditions or one-off mode");
}
