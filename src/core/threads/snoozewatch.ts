/**
 * The periodic pass that ends a snooze waiting on conditions (`task_snooze`).
 *
 * It keeps the threads whose snooze waits on conditions as a candidate set,
 * fed by the store's change events and reconciled by a rescan every
 * `SNOOZE_CANDIDATE_RESCAN_MS` — the same shape `UsageProtection` keeps for its
 * own pass, so a two-second tick reads the threads that matter rather than
 * every thread record on the machine. The judgement itself is
 * `wakeSnoozeNow`: one rule for the watch, queue admission and the
 * reconciliation pass.
 */
import type { QueueRow } from "./queue.js";
import { wakeSnoozeNow, type OperationContext } from "./operations.js";

/**
 * How often the candidate set is rebuilt from every thread record, so a snooze
 * written by another process (or before a rescan) is not missed. The events of
 * this process cover the common case in between.
 */
export const SNOOZE_CANDIDATE_RESCAN_MS = 60_000;

export class SnoozeWatch {
  private readonly candidates = new Set<string>();
  private readonly dirty = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private scannedAt: number | null = null;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: () => Promise<OperationContext>) {}

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Judge the candidates and return the threads it woke. `rows` is the caller's
   * queue snapshot, used for the conditions that read other threads; the
   * candidates and their dependencies are read here.
   */
  tick(now = Date.now(), rows: readonly QueueRow[] = []): Promise<string[]> {
    const next = this.chain.then(() => this.step(now, rows));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async step(now: number, snapshot: readonly QueueRow[]): Promise<string[]> {
    if (this.closed) return [];
    const ctx = await this.context();
    if (!this.unsubscribe) {
      this.unsubscribe = ctx.store.subscribe((event) => {
        if (event.type === "backend.thread.changed") this.dirty.add(event.threadId);
      });
    }
    const rescan = this.scannedAt === null || now - this.scannedAt >= SNOOZE_CANDIDATE_RESCAN_MS;
    const ids = new Set([...this.candidates, ...this.dirty]);
    // Consume before awaiting: events emitted during the pass belong to the next one.
    this.dirty.clear();
    if (rescan) {
      this.scannedAt = now;
      for (const id of await ctx.store.listThreadIds().catch(() => [] as string[])) ids.add(id);
    }
    const rows = [...snapshot];
    const woken: string[] = [];
    for (const id of ids) {
      const wake = await wakeSnoozeNow(ctx, id, rows, now).catch(() => null);
      if (wake === null) continue;
      if (wake.woken) woken.push(id);
      // A thread still waiting stays a candidate; one whose snooze ended (or
      // that holds none) drops out until an event or the rescan brings it back.
      if (wake.waiting) this.candidates.add(id);
      else this.candidates.delete(id);
    }
    return woken;
  }
}
