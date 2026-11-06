import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import type { ClientApi, ResearchProposal, ShellFrame } from "../../../server/api.js";
import { App, client as baseClient } from "../fixtures.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** A look at the screen that is not a picture. */
const frame = (setup: TestRendererSetup) => setup.captureCharFrame();

async function until(setup: TestRendererSetup, check: (screen: string) => boolean, message: string) {
  for (let attempt = 0; !check(frame(setup)); attempt += 1) {
    if (attempt === 200) fail(`new thread research: ${message}\n${frame(setup)}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await setup.flush();
  }
}
const visible = (setup: TestRendererSetup, text: string) => until(setup, (screen) => screen.includes(text), `did not show ${text}`);
const gone = (setup: TestRendererSetup, text: string) => until(setup, (screen) => !screen.includes(text), `still shows ${text}`);

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
  if (y < 0) fail(`new thread research: nothing to click for ${text}\n${frame(setup)}`);
  await act(async () => { await setup.mockMouse.click(rows[y]!.indexOf(text) + 1, y); await setup.mockMouse.moveTo(0, 0); });
  await setup.flush();
}

type Command = Parameters<ClientApi["dispatch"]>[0];
type OrderedEvent =
  | { readonly kind: "dispatch"; readonly command: Command }
  | { readonly kind: "subscribe"; readonly ids: readonly string[] };

interface DraftFixture {
  readonly client: ClientApi;
  readonly events: OrderedEvent[];
  readonly turnStarts: Extract<Command, { type: "thread.turn.start" }>[];
  readonly answers: Extract<Command, { type: "research.proposal.answer" }>[];
  /** Resolve the held first turn as started. */
  resolveTurnStart(value: unknown): void;
  /** The mock server raises the run-size question for the created thread. */
  propose(): void;
}

/**
 * A mock server for the new-thread draft: records every dispatch and every
 * research opt-in in order, projects the created thread into the shell, holds
 * the first turn until the proposal is answered (like the real server), and
 * serves the pending proposal to polling clients that opted in.
 */
function draftFixture(options: { parkTurnStart?: boolean; rejectTurnStart?: unknown } = {}): DraftFixture {
  const events: OrderedEvent[] = [];
  const turnStarts: Extract<Command, { type: "thread.turn.start" }>[] = [];
  const answers: Extract<Command, { type: "research.proposal.answer" }>[] = [];
  const listeners = new Set<(item: ShellFrame) => void>();
  const optedIn = new Set<string>();
  let threads: Array<Record<string, unknown>> = [
    { id: "t-old", projectId: "p1", title: "Old thread", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" }, session: { status: "idle", lastError: null } },
  ];
  let pending: ResearchProposal | null = null;
  let createdId: string | null = null;
  let resolveTurnStart: (value: unknown) => void = () => {};
  let turnStartHeld: Promise<unknown> | null = null;

  const snapshot = (): ShellFrame => ({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      projects: [{ id: "p1", title: "moxen", workspaceRoot: "/repo", defaultModelSelection: null }],
      threads,
      ...(pending ? { researchProposals: [pending] } : {}),
    },
  }) as unknown as ShellFrame;
  const emit = () => {
    const frame = snapshot();
    for (const listener of listeners) listener(frame);
  };

  const client: ClientApi = {
    ...baseClient,
    subscribeShell(shellOptions, onItem) {
      for (const id of shellOptions.researchProposals ?? []) optedIn.add(id);
      events.push({ kind: "subscribe", ids: [...(shellOptions.researchProposals ?? [])] });
      onItem(snapshot());
      onItem({ kind: "synchronized" } as ShellFrame);
      listeners.add(onItem);
      return () => {
        listeners.delete(onItem);
        for (const id of shellOptions.researchProposals ?? []) optedIn.delete(id);
      };
    },
    dispatch: (async (command: Record<string, unknown>) => {
      const typed = command as Command;
      events.push({ kind: "dispatch", command: typed });
      if (typed.type === "thread.create") {
        createdId = (typed as { threadId: string }).threadId;
        threads = [...threads, {
          id: createdId, projectId: "p1", title: "First research question",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
          runtimeMode: "full-access", interactionMode: (typed as { interactionMode?: string }).interactionMode ?? "default",
          branch: "main", worktreePath: null, archivedAt: null, session: { threadId: createdId, status: "idle", lastError: null },
          latestTurn: null, latestUserMessageAt: new Date().toISOString(),
        }];
        emit();
        return { threadId: createdId, accepted: true };
      }
      if (typed.type === "thread.turn.start") {
        turnStarts.push(typed as Extract<Command, { type: "thread.turn.start" }>);
        if (options.parkTurnStart === true) return { accepted: true, researchSizePending: true };
        if (options.rejectTurnStart !== undefined) return Promise.reject(options.rejectTurnStart);
        turnStartHeld = new Promise<unknown>((resolve) => { resolveTurnStart = resolve as (value: unknown) => void; });
        return turnStartHeld as never;
      }
      if (typed.type === "research.proposal.answer") {
        answers.push(typed as Extract<Command, { type: "research.proposal.answer" }>);
        pending = null;
        emit();
        return { accepted: true };
      }
      return await (baseClient.dispatch as (command: Record<string, unknown>) => Promise<never>)(command);
    }) as unknown as ClientApi["dispatch"],
    query: (async (query: Record<string, unknown>) => {
      if (query.type === "research.proposals") {
        return pending && pending.threadId === query.threadId && optedIn.has(pending.threadId) ? [pending] : [];
      }
      return await (baseClient.query as (query: Record<string, unknown>) => Promise<never>)(query);
    }) as unknown as ClientApi["query"],
  };

  return {
    client,
    events,
    turnStarts,
    answers,
    resolveTurnStart: (value: unknown) => resolveTurnStart(value),
    propose() {
      if (createdId === null) fail("new thread research: no thread was created to propose for");
      pending = {
        id: "proposal-1", threadId: createdId, task: "First research question", target: "user-thread",
        plan: { size: { researchers: 1, critics: 1 }, models: {} }, leadModel: { instanceId: "claudeAgent", model: "claude-opus-5" }, expiresAt: null,
      };
      emit();
    },
  };
}

function orderOf(events: OrderedEvent[]): string[] {
  return events.map((event) => event.kind === "dispatch" ? `dispatch:${event.command.type}` : `subscribe:${[...event.ids].join(",")}`);
}

/** The first prompt of a thread drafted in Research mode shows the run-size modal and waits for the answer. */
export async function runNewThreadResearch(): Promise<void> {
  {
    const fixture = draftFixture();
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="create" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await visible(setup, "Build");
      await press(setup, "i");
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await visible(setup, "Research");
      await typeText(setup, "First research question");
      await press(setup, "enter");
      await until(setup, () => fixture.turnStarts.length === 1, "the first prompt never started a turn");
      // The real order: create, then the opt-in for the client-generated id, then the turn.
      const order = orderOf(fixture.events);
      const created = order.findIndex((entry) => entry === "dispatch:thread.create");
      const subscribed = order.findIndex((entry) => entry.startsWith("subscribe:") && !entry.endsWith(":"));
      const started = order.findIndex((entry) => entry === "dispatch:thread.turn.start");
      if (created < 0 || subscribed < 0 || started < 0 || !(created < subscribed && subscribed < started)) {
        fail(`new thread research: expected create, opt-in, then turn.start, saw\n${order.join("\n")}`);
      }
      const create = fixture.events[created] as Extract<OrderedEvent, { kind: "dispatch" }>;
      const start = fixture.turnStarts[0]!;
      if ((create.command as { interactionMode?: string }).interactionMode !== "research") fail("the new thread was not created in Research mode");
      if (start.threadId !== (create.command as { threadId: string }).threadId) fail("the turn started on another thread than the created one");
      if (start.interactionMode !== undefined) fail("the first turn carried its own mode instead of the thread's");
      // The server raises the question while the turn is in flight; the modal
      // appears on the opened thread and the prompt waits for the answer.
      await act(async () => fixture.propose());
      await until(setup, () => frame(setup).includes("Full research run"), "the run-size modal never showed on the new thread's first prompt");
      console.log("--- new thread: the run-size modal on the first prompt ---");
      console.log(frame(setup));
      await click(setup, "Start");
      await until(setup, () => fixture.answers.length === 1, "Start did not answer the proposal");
      if (fixture.answers[0]!.choice !== "start") fail("Start did not choose a full run");
      await act(async () => fixture.resolveTurnStart({ accepted: true, turnId: "turn-1", messageId: "m-1", delivery: "started", status: "running" }));
      await setup.flush();
      await gone(setup, "Full research run");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // A parked first prompt says the size is still to choose instead of going quiet.
  {
    const fixture = draftFixture({ parkTurnStart: true });
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="create" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await visible(setup, "Build");
      await press(setup, "i");
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      await typeText(setup, "First research question");
      await press(setup, "enter");
      await until(setup, () => fixture.turnStarts.length === 1, "the first prompt never started a turn");
      await visible(setup, "Run size still to choose");
      if (frame(setup).includes("Full research run")) fail("a parked question still opened the modal");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }

  // A start that fails puts the prompt back in the opened thread, not the old draft.
  {
    const fixture = draftFixture({ rejectTurnStart: new Error("turn start refused by test") });
    const setup = await testRender(<App client={fixture.client} onQuit={() => {}} launchView="create" />, { width: 140, height: 40, exitOnCtrlC: false });
    try {
      await setup.flush();
      await visible(setup, "Build");
      await press(setup, "i");
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
      // Longer than a thread title: the sidebar truncates it, so the tail only
      // shows when the composer's draft holds the restored text.
      await typeText(setup, `First research question ${"tailmark ".repeat(12).trim()}`);
      await press(setup, "enter");
      await until(setup, () => fixture.turnStarts.length === 1, "the first prompt never started a turn");
      await visible(setup, "turn start refused by test");
      await visible(setup, "tailmark");
      console.log("--- new thread: a failed start restores the prompt ---");
      console.log(frame(setup));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }
}
