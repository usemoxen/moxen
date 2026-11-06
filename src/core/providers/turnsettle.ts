/**
 * Shared turn-settling for the Claude and Codex drivers: one waiter
 * registry, one settle-and-publish, so a turn is published exactly once.
 *
 * Plain functions, no Effect service or Layer. A turn settles at most once
 * because settling is guarded on the transcript: the first call marks the
 * turn (its status leaves `"running"`), resolves its waiters and publishes
 * its terminal event; every later call — an interrupt landing after the
 * result settled the turn, a result arriving after an interrupt settled it,
 * a stop closing an already settled turn — finds nothing running and does
 * nothing. Without the publish, live text buffered for the turn
 * (`trackLiveText`) was never cleared and usage protection never saw the
 * turn end; without the guard, the same turn would publish twice.
 */
import type { ProviderDriverKind, ProviderRuntimeEvent, ThreadId, TurnId } from "./spi.js";
import { dropTurnWaiter } from "./spi.js";

export type TerminalTurnStatus = "completed" | "failed" | "interrupted";

export interface TurnWaiter<TOutcome> {
  readonly resolve: (outcome: TOutcome) => void;
  readonly reject: (cause: unknown) => void;
}

export type TurnWaiters<TOutcome> = Map<TurnId, Array<TurnWaiter<TOutcome>>>;

/**
 * Park an `awaitTurn` caller on its turn. A caller that aborts drops only
 * its own waiter, so the turn's other waiters still settle.
 */
export function parkTurnWaiter<TOutcome>(args: {
  readonly waiters: TurnWaiters<TOutcome>;
  readonly turnId: TurnId;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => unknown;
}): Promise<TOutcome> {
  return new Promise<TOutcome>((resolve, reject) => {
    const waiter: TurnWaiter<TOutcome> = { resolve, reject };
    const list = args.waiters.get(args.turnId) ?? [];
    list.push(waiter);
    args.waiters.set(args.turnId, list);
    args.signal?.addEventListener(
      "abort",
      () => {
        dropTurnWaiter(args.waiters.get(args.turnId) ?? [], waiter);
        reject(args.onAbort());
      },
      { once: true },
    );
  });
}

/**
 * Resolve every waiter parked on `turnId` with `outcome`; the registry
 * entry is dropped so a later waiter on the same turn reads the settled
 * transcript instead of parking.
 */
export function resolveTurnWaiters<TOutcome>(waiters: TurnWaiters<TOutcome>, turnId: TurnId, outcome: TOutcome): void {
  const pending = waiters.get(turnId) ?? [];
  waiters.delete(turnId);
  for (const waiter of pending) waiter.resolve(outcome);
}

/**
 * The terminal event for a settled turn. `raw` rides along only on
 * failures, where the transcript's error alone loses the provider's
 * own detail (Claude's `result` subtype, say).
 */
export function terminalTurnEvent(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  turnId: TurnId,
  status: TerminalTurnStatus,
  raw?: unknown,
): ProviderRuntimeEvent {
  return {
    type: status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted",
    provider,
    threadId,
    turnId,
    ...(status === "failed" && raw !== undefined ? { raw } : {}),
  };
}

/**
 * Settle the open turn, resolve its waiters and publish its terminal
 * event — or do nothing when no turn is running. `apply` marks the turn
 * on the transcript (its status must leave `"running"`) and builds the
 * outcome; that mark is what makes a second call a no-op.
 */
export function settleAndPublishTurn<Turn extends { readonly id: string; status: string }, TOutcome>(args: {
  readonly open: Turn | null | undefined;
  readonly waiters: TurnWaiters<TOutcome>;
  readonly status: TerminalTurnStatus;
  readonly apply: (turn: Turn) => TOutcome;
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly event: (turnId: TurnId) => ProviderRuntimeEvent;
}): Turn | null {
  const turn = args.open ?? null;
  if (!turn || turn.status !== "running") return null;
  const outcome = args.apply(turn);
  resolveTurnWaiters(args.waiters, turn.id, outcome);
  args.publish(args.event(turn.id));
  return turn;
}
