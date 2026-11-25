import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testHarness } from "../../testing/harness.js";
import { completeTurn, createThread, openTurn, sendTurn } from "../threads.js";
import { flushTurnRunners, type TurnDriver } from "../execute.js";
import { describeTask, continueThread, continueOwnThread, type OperationContext } from "../operations.js";
import { driverKindOfInstance } from "../../types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function world() {
  const harness = await testHarness();
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = { store: harness.store, storeRoot: harness.root, config: harness.config, driverFor: (id) => {
    const kind = driverKindOfInstance(id)!;
    let driver = drivers.get(kind);
    if (!driver) { driver = harness.drivers[kind]!(); drivers.set(kind, driver); }
    return driver;
  } };
  const make = (title: string) => createThread(harness.store, { projectId: "p", title, env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
  return { ...harness, ctx, make };
}

/** The opening prompt of a continued thread: the hand-off document itself. */
async function openingPrompt(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<string> {
  const messages = await w.store.readMessages(threadId);
  const told = messages.find((message) => message.role === "user");
  if (told === undefined) throw new Error(`no user message on ${threadId}`);
  return told.text;
}

/** Wait until the thread has no open turn, flushing the (async) turn runners. */
async function settled(w: Awaited<ReturnType<typeof world>>, threadId: string): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 100) {
    await flushTurnRunners(100);
    if (openTurn(await w.store.readTurns(threadId)) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`thread ${threadId} never settled`);
}

describe("a hand-off chain", () => {
  const GOAL = "Audit every route for missing auth checks; the goalfinder marker must survive every hop.";

  it("stays bounded across 25 generated continues, keeping the goal and the last request", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const task = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: task.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const first = (await sendTurn(w.store, task.id, { prompt: GOAL })).turn;
    await completeTurn(w.store, task.id, first.id, { text: "Routing audit underway; nothing finished yet." });

    const sizes: number[] = [];
    let current = task.id;
    const HOPS = 25;
    for (let hop = 1; hop <= HOPS; hop += 1) {
      const continued = await continueThread(w.ctx, { threadId: current, automatic: true });
      current = continued.threadId;
      await settled(w, current);
      const prompt = await openingPrompt(w, current);
      sizes.push(prompt.length);
      // The chain's own context must survive: the original goal, and the
      // last request the chain is still working on.
      expect(prompt).toContain("goalfinder marker");
      expect(prompt).toContain("The last request, verbatim");
    }

    // Every hop's hand-off fits a context window on its own.
    expect(Math.max(...sizes)).toBeLessThan(120_000);
    // And no hop doubles the last: growth is at most linear with a small
    // slope after the first carry, never exponential.
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]!).toBeLessThanOrEqual(sizes[0]! + 20_000 * index);
    }
    // The chain resolves as a task: the parent still reaches its task and
    // the live continuation never reads as gone.
    const described = await describeTask(w.ctx, parent.id, task.id);
    expect(described.child.id).not.toBe(task.id);
    expect(described.parent.id).toBe(parent.id);
  }, 120_000);

  it("stays bounded across agent thread_continue summaries, keeping the wrap-up and the request", async () => {
    const w = await world();
    const task = await w.make("task");
    let current = task.id;
    const first = (await sendTurn(w.store, task.id, { prompt: GOAL })).turn;
    await completeTurn(w.store, task.id, first.id, { text: "Started the audit." });

    const sizes: number[] = [];
    for (let hop = 1; hop <= 21; hop += 1) {
      if (hop % 3 === 1) {
        // A real user message resets the consecutive agent-continuation streak.
        const steer = `User steer ${hop}: keep the goalfinder marker in scope.`;
        const sent = await sendTurn(w.store, current, { prompt: steer });
        await completeTurn(w.store, current, sent.turn.id, { text: `Heard steer ${hop}.` });
      }
      const continued = await continueOwnThread(w.ctx, { threadId: current, summary: `Hop ${hop}: ${GOAL.slice(0, 40)} — audit half done, continuing.` });
      current = continued.threadId;
      await settled(w, current);
      const prompt = await openingPrompt(w, current);
      sizes.push(prompt.length);
      expect(prompt).toContain("goalfinder marker");
      expect(prompt).toContain("## Model's wrap-up");
      expect(prompt).toContain(`Hop ${hop}:`);
    }

    // Once the chain settles, every hop's document is the same bounded shape:
    // fresh wrap-up plus carried requests, never the chain's earlier documents.
    expect(Math.max(...sizes)).toBeLessThan(120_000);
    const settledSizes = sizes.slice(1);
    expect(Math.max(...settledSizes) - Math.min(...settledSizes)).toBeLessThanOrEqual(4_000);
  }, 120_000);
});

describe("a hand-off that fails", () => {
  it("leaves no half-written destination, breaks no task resolution, and its reservation is rejoined by the retry", async () => {
    const w = await world();
    const parent = await w.make("orchestrator");
    const task = await w.make("task");
    const now = new Date().toISOString();
    await w.store.appendDelegation({ id: "d1", parentThreadId: parent.id, childThreadId: task.id, prompt: "Build it", status: "running", notify: true, createdAt: now, updatedAt: now });
    const first = (await sendTurn(w.store, task.id, { prompt: "Build it" })).turn;
    await completeTurn(w.store, task.id, first.id, { text: "Half done." });

    // The message ledger fails to read while the hand-off is being built.
    const realRead = w.store.readMessages.bind(w.store);
    let fail = true;
    vi.spyOn(w.store, "readMessages").mockImplementation(async (threadId: string, options?: { reportTornTail?: boolean }) => {
      if (fail) {
        fail = false;
        throw new Error("message ledger row unreadable");
      }
      return realRead(threadId, options);
    });
    await expect(continueThread(w.ctx, { threadId: task.id, automatic: true })).rejects.toThrow("message ledger row unreadable");

    // Nothing half-wrote: the source is unchanged, the reserved destination was
    // never created, nothing was adopted, and the task still resolves for the parent.
    expect((await w.store.readTurns(task.id)).map((turn) => turn.status)).toEqual(["completed"]);
    const reserved = (await w.store.readActivities(task.id)).find((activity) => activity.kind === "thread.continued")?.payload?.threadId as string;
    expect(await w.store.readThreadRecord(reserved)).toBeNull();
    expect(await describeTask(w.ctx, parent.id, task.id)).toMatchObject({ child: { id: task.id } });
    expect((await w.store.readDelegations()).find((row) => row.id === "d1")?.continuedIn).toBeUndefined();

    // The retry rejoins the reservation rather than creating a second thread,
    // lands the hand-off bounded, and the task now resolves to the continuation.
    const continued = await continueThread(w.ctx, { threadId: task.id, automatic: true });
    expect(continued.threadId).toBe(reserved);
    await settled(w, continued.threadId);
    const rows = await w.store.readDelegations();
    expect(rows.find((row) => row.id === "d1")?.continuedIn).toBe(continued.threadId);
    expect(rows.find((row) => row.childThreadId === continued.threadId)?.parentThreadId).toBe(parent.id);
    expect(await describeTask(w.ctx, parent.id, task.id)).toMatchObject({ child: { id: continued.threadId } });
    expect(await openingPrompt(w, continued.threadId)).toContain("Build it");
  }, 60_000);
});
