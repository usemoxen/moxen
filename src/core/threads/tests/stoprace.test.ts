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
import { executeTurn } from "../execute.js";
import { startTurn, type OperationContext } from "../operations.js";
import { createThread, interruptTurn, sendTurn } from "../threads.js";

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

describe("stopping a turn parked behind another", () => {
  it("hands a turn promoted by the stop to a runner instead of stranding it", async () => {
    const entered = deferred();
    const gate = deferred();
    const sent: string[] = [];
    let started = false;
    const w = await world((base) =>
      Object.assign(Object.create(base) as TurnDriver, {
        startSession: (input: ProviderSessionStartInput) =>
          Effect.promise(async () => {
            if (!started) {
              started = true;
              entered.resolve();
              await gate.promise;
            }
            return {};
          }),
        sendTurn: (input: ProviderSendTurnInput) => {
          sent.push(input.prompt);
          return base.sendTurn(input);
        },
      }),
    );
    const run = startTurn(w.ctx, { threadId: w.thread.id, prompt: "first" });
    await entered.promise;
    // A second message queues behind the starting turn; the stop interrupts
    // the first and promotes the second to running with a live owner.
    await sendTurn(w.store, w.thread.id, { prompt: "second", delivery: "queue" });
    await interruptTurn(w.store, w.thread.id);
    gate.resolve();
    await run;
    await settleRuns();

    // The promoted turn got a runner: it ran to completion, and the thread
    // takes the next message instead of sitting wedged on a running turn.
    expect(sent).toEqual(["second"]);
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
    await startTurn(w.ctx, { threadId: w.thread.id, prompt: "third" });
    await settleRuns();
    expect(sent).toEqual(["second", "third"]);
  });

  it("leaves a session a newer turn owns alone when an older stopped send checks late", async () => {
    const entered = deferred();
    const gateStart = deferred();
    const sentSecond = deferred();
    const releaseSecond = deferred();
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
              await gateStart.promise;
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
          if (input.prompt === "second") sentSecond.resolve();
          return base.sendTurn(input);
        },
        awaitTurn: async (threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnOutcome> => {
          await releaseSecond.promise;
          return await base.awaitTurn(threadId, turnId, signal);
        },
      }),
    );
    const first = startTurn(w.ctx, { threadId: w.thread.id, prompt: "first" });
    await entered.promise;
    await interruptTurn(w.store, w.thread.id);
    // A newer turn starts on the session the stopped send opened, and is
    // still on it when the stopped send finally checks.
    const second = startTurn(w.ctx, { threadId: w.thread.id, prompt: "second" });
    await sentSecond.promise;
    gateStart.resolve();
    await first;
    releaseSecond.resolve();
    await second;
    await settleRuns();

    // The late check saw the open turn and left its session alone.
    expect(stopped).toEqual([]);
    expect(sessions.has(w.thread.id)).toBe(true);
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
  });

  it("stops at the runner when the stop lands after the send's final check", async () => {
    const entered = deferred();
    const gate = deferred();
    const sent: string[] = [];
    let updated = false;
    const w = await world((base) =>
      Object.assign(Object.create(base) as TurnDriver, {
        updateMcpServers: async (threadId: string, servers: readonly { name: string }[]) => {
          if (!updated) {
            updated = true;
            entered.resolve();
            await gate.promise;
          }
          await base.updateMcpServers?.(threadId, servers as never);
        },
        sendTurn: (input: ProviderSendTurnInput) => {
          sent.push(input.prompt);
          return base.sendTurn(input);
        },
      }),
    );
    const run = startTurn(w.ctx, { threadId: w.thread.id, prompt: "first" });
    // Parked past the send's own liveness check: only the runner's stands in the way.
    await entered.promise;
    await sendTurn(w.store, w.thread.id, { prompt: "second", delivery: "queue" });
    await interruptTurn(w.store, w.thread.id);
    gate.resolve();
    await run;
    await settleRuns();

    // The stopped prompt never went out; the promoted turn still ran.
    expect(sent).toEqual(["second"]);
    const turns = await w.store.readTurns(w.thread.id);
    expect(turns.map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
    // And the stopped turn is not owed again: it was stopped, not unanswered.
    expect(turns[0]).not.toMatchObject({ unanswered: true });
  });

  it("does not interrupt a newer turn's run when re-interrupting after a mid-send stop", async () => {
    const entered = deferred();
    const gate = deferred();
    const sentSecond = deferred();
    const releaseSecond = deferred();
    let interrupts = 0;
    let first = true;
    const w = await world((base) =>
      Object.assign(Object.create(base) as TurnDriver, {
        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.promise(async () => {
            if (first) {
              first = false;
              entered.resolve();
              await gate.promise;
            } else if (input.prompt === "second") {
              sentSecond.resolve();
            }
            return await Effect.runPromise(base.sendTurn(input));
          }),
        interruptTurn: (_threadId: string) => {
          interrupts += 1;
          return Effect.void;
        },
        awaitTurn: async (threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnOutcome> => {
          if (signal?.aborted === true) throw new CliError("TURN_ABORTED", `Turn ${turnId} was aborted before settling.`, {});
          await releaseSecond.promise;
          return await base.awaitTurn(threadId, turnId, signal);
        },
      }),
    );
    const stopped = startTurn(w.ctx, { threadId: w.thread.id, prompt: "first" });
    await entered.promise;
    await interruptTurn(w.store, w.thread.id);
    // A newer turn starts its own provider run before the stopped prompt goes out.
    const second = startTurn(w.ctx, { threadId: w.thread.id, prompt: "second" });
    await sentSecond.promise;
    gate.resolve();
    await stopped;
    releaseSecond.resolve();
    await second;
    await settleRuns();

    // Only the abort's own interrupt fired: the re-interrupt saw the newer
    // running turn and left its run alone.
    expect(interrupts).toBe(1);
    expect((await w.store.readTurns(w.thread.id)).map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
  });

  it("interrupts the provider run when a background turn was stopped before its runner started", async () => {
    const w = await world((base) => {
      let interrupts = 0;
      const driver = Object.assign(Object.create(base) as TurnDriver, {
        interruptTurn: (_threadId: string) => {
          interrupts += 1;
          return Effect.void;
        },
      });
      (driver as { interrupts?: () => number }).interrupts = () => interrupts;
      return driver;
    });
    const sent = await sendTurn(w.store, w.thread.id, { prompt: "background work" });
    // Stopped after the provider started its own turn but before this
    // process ran it: there is no prompt to withhold, only a live run.
    await interruptTurn(w.store, w.thread.id, sent.turn.id);
    const driver = w.ctx.driverFor("claudeAgent");
    await executeTurn({ store: w.store, driver, threadId: w.thread.id, storeTurnId: sent.turn.id, prompt: "background work", driverTurnId: "native-1" });
    await settleRuns();

    expect(((driver as unknown as { interrupts?: () => number }).interrupts ?? (() => -1))()).toBe(1);
    expect((await w.store.readTurns(w.thread.id))[0]?.status).toBe("interrupted");
  });
});
