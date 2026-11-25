import { afterEach, describe, expect, it } from "vitest";
import { testHarness } from "../../core/testing/harness.js";
import { driverKindOfInstance } from "../../core/types.js";
import { settleRuns } from "../../core/testing/turns.js";
import { resetUsageLimitsForTests } from "../../core/usage/limits.js";
import { completeTurn, createThread, interruptTurn, openTurn, sendTurn } from "../../core/threads/threads.js";
import { parseQueuePolicy } from "../../core/threads/queue.js";
import { continueThread, readWorkQueue, runDueScheduledTurn, runWorkQueue, type OperationContext } from "../../core/threads/operations.js";
import type { TurnDriver } from "../../core/threads/execute.js";
import { DirectConnection } from "../connection.js";
import { decodeCommand, decodeQuery } from "../protocol.js";

afterEach(() => {
  resetUsageLimitsForTests();
});

function coreContext(harness: Awaited<ReturnType<typeof testHarness>>): OperationContext {
  const drivers = new Map<string, TurnDriver>();
  return {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (id) => {
      const kind = driverKindOfInstance(id)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = harness.drivers[kind]!();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
}

describe("server queue dispatch over a moved entry at the condition cap", () => {
  it("projects the server wait out, decodes the echo, reattaches on edit, and preserves handoff ordering", async () => {
    const harness = await testHarness();
    const ctx = coreContext(harness);
    const api = new DirectConnection({ storeRoot: harness.root, config: async () => harness.config, drivers: harness.drivers, builtinMcpServers: null });
    try {
      const source = await createThread(harness.store, {
        projectId: "p",
        title: "solo",
        env: { mode: "local", path: harness.work, branch: null },
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      });
      const done = (await sendTurn(harness.store, source.id, { prompt: "First" })).turn;
      await completeTurn(harness.store, source.id, done.id, { text: "Done." });
      // 16 satisfied client conditions (past `at`): the only block is the
      // internal handoff wait the move appends.
      const clients = Array.from({ length: 16 }, (_, index) => ({
        type: "at" as const,
        at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
      }));
      await sendTurn(harness.store, source.id, { prompt: "Second", queue: parseQueuePolicy({ conditions: clients }) });

      // A scheduled continuation: the destination handoff runs at its time,
      // and the moved entry waits on it first.
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const continued = await continueThread(ctx, { threadId: source.id, scheduledFor: at });
      const moved = (await harness.store.readTurns(continued.threadId)).find((turn) => turn.queue?.requestId?.startsWith("handoff:transfer:"))!;
      const handoffId = (await harness.store.readTurns(continued.threadId))[0]!.id;
      const wait = { type: "entry", threadId: continued.threadId, turnId: handoffId, serverWait: true as const };
      expect(moved.queue?.conditions).toHaveLength(17);

      // The queue.read projection hides the server-owned wait: 16
      // conditions, none naming the handoff turn, so no client can remove it.
      const readQuery = decodeQuery({ type: "queue.read" });
      if (readQuery.type !== "queue.read") throw new Error("unreachable");
      const read = await api.query(readQuery);
      const projected = read.entries.find((entry) => entry.threadId === continued.threadId && entry.turnId === moved.id)!;
      expect(projected.policy.conditions).toHaveLength(16);
      expect(projected.policy.conditions.some((condition) => condition.type === "entry" && condition.threadId === continued.threadId)).toBe(false);

      // The echo passes the real protocol gate (which caps at 16)...
      const command = decodeCommand({ type: "queue.edit", threadId: continued.threadId, turnId: moved.id, action: "edit", policy: projected.policy });
      expect(command).toMatchObject({ type: "queue.edit", action: "edit" });
      // ...dispatches through the server, and core reattaches the wait
      // exactly once.
      await api.dispatch(command);
      const edited = (await harness.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)!;
      expect(edited.queue?.conditions).toHaveLength(17);
      expect(edited.queue?.conditions.at(-1)).toEqual(wait);
      expect(edited.queue?.conditions.filter((condition) => condition.type === "entry")).toEqual([wait]);

      // An admission attempt before the handoff time starts nothing: the
      // reattached wait still orders the moved entry behind the handoff.
      expect(await runDueScheduledTurn(ctx, continued.threadId)).toBe(false);
      await runWorkQueue(ctx);
      expect(openTurn(await harness.store.readTurns(continued.threadId))).toBeNull();
      expect((await harness.store.readTurns(continued.threadId)).find((turn) => turn.id === moved.id)?.status).toBe("queued");
      await settleRuns();
      for (const threadId of [source.id, continued.threadId]) {
        for (const turn of await harness.store.readTurns(threadId)) {
          if (turn.status === "running") await interruptTurn(harness.store, threadId, turn.id);
        }
      }
    } finally {
      await api.close();
    }
  });
});
