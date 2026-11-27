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
import type { ThreadStore } from "./store.js";
import type { StoredDelegation } from "./types.js";

/**
 * Record that this task's thread reached a new settle. Only a notifying live
 * row keeps the obligation. The generation is a counter on the row, not a
 * count of the thread's turns: a revert removes turns, and the settle after
 * it must still read as newer than anything already reported.
 */
export async function markDelegationSettle(store: ThreadStore, threadId: string): Promise<void> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  if (row === undefined || row.notify !== true) return;
  await store.updateDelegation(row.id, { settleGeneration: (row.settleGeneration ?? 0) + 1 }).catch(() => undefined);
}

/** The newest settle recorded for this task's live row: what a notice observed now will report. */
export async function delegationSettleGeneration(store: ThreadStore, childThreadId: string): Promise<number> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined);
  return row?.settleGeneration ?? 0;
}

/** Record that a settle notice at this generation was queued, so recovery need not send it again. */
export async function markDelegationNoticeReported(store: ThreadStore, childThreadId: string, generation: number): Promise<void> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined);
  if (row === undefined) return;
  if ((row.reportedGeneration ?? 0) >= generation) return;
  await store.updateDelegation(row.id, { reportedGeneration: generation }).catch(() => undefined);
}
