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

/** How many of a thread's turns have reached a terminal state: the settle generation a notice reports. */
export function settleGenerationOf(turns: readonly { readonly completedAt?: string | null }[]): number {
  return turns.filter((turn) => turn.completedAt !== null && turn.completedAt !== undefined).length;
}

/**
 * Record that this task's thread reached a new settle. Only a notifying live
 * row keeps the obligation; a later settle raises the generation, so nothing
 * queued for an earlier one satisfies it.
 */
export async function markDelegationSettle(store: ThreadStore, threadId: string, generation: number): Promise<void> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === threadId && candidate.continuedIn === undefined);
  if (row === undefined || row.notify !== true) return;
  if ((row.settleGeneration ?? 0) >= generation) return;
  await store.updateDelegation(row.id, { settleGeneration: generation }).catch(() => undefined);
}

/** Record that a settle notice at this generation was queued, so recovery need not send it again. */
export async function markDelegationNoticeReported(store: ThreadStore, childThreadId: string, generation: number): Promise<void> {
  const rows = await store.readDelegations().catch(() => [] as StoredDelegation[]);
  const row = rows.find((candidate) => candidate.childThreadId === childThreadId && candidate.continuedIn === undefined);
  if (row === undefined) return;
  if ((row.reportedGeneration ?? 0) >= generation) return;
  await store.updateDelegation(row.id, { reportedGeneration: generation }).catch(() => undefined);
}
