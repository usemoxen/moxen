/**
 * MXN-280: stopping a new thread right after it starts must end the turn.
 * The stop lands after `sendTurn` records the turn as running but before
 * the provider run starts (session still starting, or the prompt still
 * going out), so the store abort finds no live run to stop — and the turn
 * must not then go out anyway, leaving a provider run with no store turn.
 */
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { settleRuns } from "../../testing/turns.js";
import { driverKindOfInstance } from "../../types.js";
import type { ProviderSessionStartInput, ProviderSendTurnInput } from "../../providers/spi.js";
import { CliError } from "../../errors.js";
import type { TurnDriver, TurnOutcome } from "../execute.js";
import { startTurn, type OperationContext } from "../operations.js";
import { createThread, interruptTurn } from "../threads.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function world(driver: (base: TurnDriver) => TurnDriver) {
  const harness = await testHarness();
  const base = harness.drivers.claude!();
  const wrapped = driver(base);
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (id) => (driverKindOfInstance(id) === "claude" ? wrapped : harness.drivers[driverKindOfInstance(id)!]!()),
  };
  const thread = await createThread(harness.store, {
    projectId: "p",
    title: "Quick stop",
    env: { mode: "local", path: harness.work, branch: null },
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  });
  return { ...harness, ctx, thread };
}

describe("stopping a turn that has not started yet", () => {
  it("never sends the prompt when the stop lands while the session is still starting", async () => {
    const entered = deferred();
    const gate = deferred();
    const sent: string[] = [];
    const sessions = new Set<string>();
    const stopped: string[] = [];
    let started = false;
    const w = await world((base) =>
      Object.assign(Object.create(base) as TurnDriver, {
        hasSession: (threadId: string) => Effect.succeed(sessions.has(threadId)),
        startSession: (input: ProviderSessionStartInput) =>
          Effect.promise(async () => {
            if (!started) {
              started = true;
              entered.resolve();
              await gate.promise;
            }
            sessions.add(input.threadId);
            return {};
          }),
        stopSession: (threadId: string) =>
          Effect.sync(() => {
            sessions.delete(threadId);
            stopped.push(threadId);
          }),
        sendTurn: (input: ProviderSendTurnInput) => {
          sent.push(input.prompt);
          return base.sendTurn(input);
        },
      }),
    );
    const run = startTurn(w.ctx, { threadId: w.thread.id, prompt: "Hello?" });
    // The send is parked inside session start: the exact window the stop lands in.
    await entered.promise;
    // The TUI stop path: the store turn is interrupted, with no provider run to abort yet.
    await interruptTurn(w.store, w.thread.id);
    gate.resolve();
    await run;
    await settleRuns();

    // The prompt never went out: the provider has no orphaned run, and the
    // session opened for the dead turn was closed again.
    expect(sent).toEqual([]);
    expect(stopped).toEqual([w.thread.id]);
    const [turn] = await w.store.readTurns(w.thread.id);
    expect(turn?.status).toBe("interrupted");
    expect((await w.store.readMessages(w.thread.id)).filter((row) => row.role === "assistant")).toEqual([]);

    // And the next message starts cleanly on the same thread.
    await startTurn(w.ctx, { threadId: w.thread.id, prompt: "Second try" });
    await settleRuns();
    expect(sent).toEqual(["Second try"]);
    const turns = await w.store.readTurns(w.thread.id);
    expect(turns.at(-1)?.status).toBe("completed");
  });

  it("stops the provider run when the stop lands while the prompt is going out", async () => {
    const entered = deferred();
    const gate = deferred();
    let live = false;
    let interrupts = 0;
    const w = await world((base) =>
      Object.assign(Object.create(base) as TurnDriver, {
        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.promise(async () => {
            entered.resolve();
            await gate.promise;
            live = true;
            return await Effect.runPromise(base.sendTurn(input));
          }),
        interruptTurn: (_threadId: string) => {
          interrupts += 1;
          live = false;
          return Effect.void;
        },
        awaitTurn: async (threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnOutcome> => {
          // Like the real drivers: an aborted wait rejects instead of settling.
          if (signal?.aborted === true) throw new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {});
          return await base.awaitTurn(threadId, turnId, signal);
        },
      }),
    );
    const run = startTurn(w.ctx, { threadId: w.thread.id, prompt: "Hello?" });
    // The send is parked with the prompt still going out.
    await entered.promise;
    await interruptTurn(w.store, w.thread.id);
    gate.resolve();
    await run;
    await settleRuns();

    // The run that just started was stopped at once, not left running: the
    // abort's interrupt found no open turn, so the runner interrupted again
    // once the prompt was out.
    expect(live).toBe(false);
    expect(interrupts).toBeGreaterThanOrEqual(2);
    const [turn] = await w.store.readTurns(w.thread.id);
    expect(turn?.status).toBe("interrupted");
  });
});
