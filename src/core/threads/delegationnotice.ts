/**
 * Durable settle obligations for a delegated task's parent.
 *
 * A task's run callback queues its parent's settle notice, but a process can
 * die between the terminal turn (and its review outcome) being written and
 * that callback running. Recovery must not depend on the predecessor's batch
 * still existing, so each settle also records its generation on the live
 * delegation row; a notice records the generation it was queued for. Startup
 * reconciliation sends whatever is still owed.
 */
import { isMaintenanceTurn } from "./maintenance.js";
import type { ThreadStore } from "./store.js";
import type { StoredDelegation, StoredMessage, StoredTurn } from "./types.js";

async function liveRow(store: ThreadStore, childThreadId: string): Promise<StoredDelegation | undefined> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  return rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined);
}

/**
 * Record that this task's thread reached a new settle. Only a notifying live
 * row keeps the obligation, and Moxen's own compaction settles no work. The
 * generation is a counter on the row, not a count of the thread's turns: a
 * revert removes turns, and the settle after it must still read as newer than
 * anything already reported.
 */
export async function markDelegationSettle(store: ThreadStore, threadId: string, turn: StoredTurn): Promise<void> {
  const row = await liveRow(store, threadId);
  if (row === undefined || row.notify !== true) return;
  // A compaction written before the turn marker existed is known by its prompt.
  const messages = await store.readMessages(threadId).catch(() => [] as StoredMessage[]);
  if (isMaintenanceTurn(turn, messages)) return;
  await store.updateDelegationWith(row.id, (current) => ({ settleGeneration: (current.settleGeneration ?? 0) + 1 })).catch(() => undefined);
}

/** The newest settle recorded for this task's live row: what a notice observed now will report. */
export async function delegationSettleGeneration(store: ThreadStore, childThreadId: string): Promise<number> {
  return (await liveRow(store, childThreadId))?.settleGeneration ?? 0;
}

/** Record that a settle notice at this generation was queued, so recovery need not send it again. */
export async function markDelegationNoticeReported(store: ThreadStore, childThreadId: string, generation: number): Promise<void> {
  const row = await liveRow(store, childThreadId);
  if (row === undefined) return;
  // Compared under the ledger lock: of two notices queued at once, the older
  // one must not lower what the newer one recorded.
  await store.updateDelegationWith(row.id, (current) => (
    (current.reportedGeneration ?? 0) >= generation ? null : { reportedGeneration: generation }
  )).catch(() => undefined);
}
