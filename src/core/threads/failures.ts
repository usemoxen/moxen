/**
 * Failures with nowhere to go: an abort-time interrupt nobody awaits, a
 * throwing event subscriber, a failed idle probe. Throwing would take
 * down the pump or the sweep, and core has no store root to log to — so
 * the long-lived owner (the server) registers a sink here and core
 * reports through it. Without one the report is dropped, never thrown.
 *
 * One tiny hook, not a logger: the shape mirrors `onScheduledTurnDue`
 * in `schedule.ts`.
 */
export type ThreadFailureSink = (area: string, message: string) => void;

let sink: ThreadFailureSink | null = null;

/** Register (or, with null, remove) where detached core failures are reported. The returned fn removes only what it installed. */
export function onThreadFailure(next: ThreadFailureSink | null): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/** Report a detached failure. Never throws. */
export function reportThreadFailure(area: string, message: string): void {
  try {
    sink?.(area, message);
  } catch {
    // Reporting must never break the pump, the sweep or a turn.
  }
}

/** One line for a failure of unknown shape. */
export function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
