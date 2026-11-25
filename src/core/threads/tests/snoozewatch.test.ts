/**
 * The periodic pass that ends a condition-held snooze (`task_snooze`): it keeps
 * a candidate set from the store's events and reconciles it by rescan, so the
 * two-second tick does not reread every thread record. The judgement itself is
 * `wakeSnoozeNow`, pinned where the queue reads it (`queue.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

import { testHarness } from "../../testing/harness.js";
import { driverKindOfInstance } from "../../types.js";
import type { TurnDriver } from "../execute.js";
import type { OperationContext } from "../operations.js";
import { SNOOZE_CANDIDATE_RESCAN_MS, SnoozeWatch } from "../snoozewatch.js";
import { createThread, snoozeThread } from "../threads.js";
import { openThreadStore } from "../store.js";

async function world() {
  const harness = await testHarness();
  const drivers = new Map<string, TurnDriver>();
  const ctx: OperationContext = {
    store: harness.store,
    storeRoot: harness.root,
    config: harness.config,
    driverFor: (instance) => {
      const kind = driverKindOfInstance(instance)!;
      let driver = drivers.get(kind);
      if (!driver) {
        driver = harness.drivers[kind]!();
        drivers.set(kind, driver);
      }
      return driver;
    },
  };
  const make = (title: string) =>
    createThread(harness.store, { projectId: "p", title, env: { mode: "local", path: harness.work, branch: null }, modelSelection: { instanceId: "codex", model: "test-model" } });
  return { ...harness, ctx, make };
}

const snoozedUntil = (at: number) => new Date(at).toISOString();

describe("SnoozeWatch", () => {
  it("judges the threads its candidates name after the reconciliation, not every record on each tick", async () => {
    const w = await world();
    const waiting = await w.make("snoozed task");
    const other = await w.make("someone else");
    for (let index = 0; index < 5; index++) await w.make(`idle ${index}`);
    // Due inside the rescan window, so the ticks below prove the candidate set
    // carries the snooze without a full scan.
    const due = Date.now() + 30_000;
    await snoozeThread(w.store, waiting.id, null, [{ type: "at", at: snoozedUntil(due) }]);
    const watch = new SnoozeWatch(async () => w.ctx);
    try {
      // The first tick reconciles: every record, once.
      expect(await watch.tick(Date.now())).toEqual([]);
      const records = vi.spyOn(w.store, "readThreadRecord");
      const ids = vi.spyOn(w.store, "listThreadIds");
      // Nothing changed and the time has not come: the pass judges its one candidate.
      expect(await watch.tick(Date.now() + 1_000)).toEqual([]);
      expect(ids).not.toHaveBeenCalled();
      // Only the candidate is read: none of the other records is touched.
      expect(new Set(records.mock.calls.map(([id]) => id))).toEqual(new Set([waiting.id]));
      records.mockClear();
      // Only the thread a change touched is read again, beside the candidate.
      await w.store.writeThreadRecord({ ...(await w.store.readThreadRecord(other.id))!, title: "renamed" });
      expect(await watch.tick(Date.now() + 2_000)).toEqual([]);
      const touched = records.mock.calls.map(([id]) => id);
      expect(touched).toContain(other.id);
      expect(new Set(touched)).toEqual(new Set([other.id, waiting.id]));
      records.mockClear();
      // Due at last: the candidate was kept all along, with no rescan needed.
      expect(await watch.tick(due + 1_000)).toEqual([waiting.id]);
      expect(ids).not.toHaveBeenCalled();
    } finally {
      watch.close();
    }
  });

  it("finds a snooze another process wrote on its rescan, and drops a thread it woke", async () => {
    const w = await world();
    const thread = await w.make("written elsewhere");
    const watch = new SnoozeWatch(async () => w.ctx);
    try {
      expect(await watch.tick(Date.now())).toEqual([]);
      // A second process's store has its own bus: nothing here hears its write.
      const elsewhere = await openThreadStore(w.root);
      await snoozeThread(elsewhere, thread.id, null, [{ type: "at", at: snoozedUntil(Date.now() - 1_000) }]);
      // The next sweep inside the rescan window knows no candidate for it.
      expect(await watch.tick(Date.now() + 1_000)).toEqual([]);
      // The reconciliation finds it, and it is due at once.
      expect(await watch.tick(Date.now() + SNOOZE_CANDIDATE_RESCAN_MS + 1_000)).toEqual([thread.id]);
      // Woken, so it is no longer a candidate. The wake's own write is an event
      // of this process: one pass carries it out, and then nothing is read at all.
      await watch.tick(Date.now() + SNOOZE_CANDIDATE_RESCAN_MS + 1_500);
      const records = vi.spyOn(w.store, "readThreadRecord");
      expect(await watch.tick(Date.now() + SNOOZE_CANDIDATE_RESCAN_MS + 2_000)).toEqual([]);
      expect(records).not.toHaveBeenCalled();
    } finally {
      watch.close();
    }
  });
});
