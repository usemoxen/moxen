/**
 * The pre-restart drain: what the shared server does between being asked to
 * stop for a restart and actually stopping.
 *
 * A restart after an update used to kill every running turn mid-work. The
 * drain holds that off for a grace window (`restartDrainTimeout`): while it
 * lasts nothing new starts — sends that would run now are refused (`SERVER_DRAINING`),
 * queue admission and settle promotions hold their entries — and running
 * turns are left to finish. Past the window (or on a forced stop) the rest
 * are interrupted with a reason that says the restart stopped them, and the
 * server stops; queued and scheduled work is never touched and runs once the
 * next server is up.
 *
 * The flag is process-wide, like the schedule timers: only the process that
 * owns the sessions (the shared server) turns it on, and every start path in
 * this directory honours it.
 */
import { CliError } from "../errors.js";
import type { CliConfig } from "../types.js";
import { durationMs } from "./idle.js";

/** How long a restart waits for running turns when `restartDrainTimeout` says nothing. */
export const RESTART_DRAIN_DEFAULT_MS = 120_000;

/** Recorded as the reason an interrupted turn was stopped by a restart's drain. */
export const RESTART_INTERRUPT_REASON = "The server was restarted, stopping its work.";

/** Recorded as why a promotion or a recovery went back to the queue for the restart. */
export const RESTART_HELD_SUMMARY = "Held for the server restart";

/**
 * Who is draining. The gate is process-wide — every start path in this
 * directory reads it — but it belongs to the callers that turned it on: a
 * connection closing in the same process must not release a drain another
 * one is still waiting on.
 */
const owners = new Set<object>();

/** A gate turned on without an owner (a test, or a caller with nothing to close). */
let unowned = false;

/** True while a restart's drain waits for running work: nothing new may start. */
export function isDraining(): boolean {
  return unowned || owners.size > 0;
}

/**
 * Turn the drain on for `owner` — the connection stopping for a restart —
 * or join the drain already running: the gate stays on until the last owner
 * releases it.
 */
export function startDraining(owner: object): void {
  owners.add(owner);
}

/**
 * Release `owner`'s drain. Another owner's drain keeps the gate on, so a
 * second connection closing cannot lift a drain it never started.
 */
export function stopDraining(owner: object): void {
  owners.delete(owner);
}

/**
 * The gate with no owner at all, for tests and for a caller that has nothing
 * to close later: `false` clears every drain, owned or not.
 */
export function setDraining(next: boolean): void {
  unowned = next;
  if (!next) owners.clear();
}

/** How long the drain waits for running turns: `restartDrainTimeout` (`0` interrupts at once). */
export function restartDrainTimeoutMs(config: CliConfig): number {
  const parsed = durationMs(config.restartDrainTimeout);
  return parsed === null || parsed < 0 ? RESTART_DRAIN_DEFAULT_MS : parsed;
}

/** What a send refused by the drain reports. */
export function serverDrainingError(): CliError {
  return new CliError(
    "SERVER_DRAINING",
    "The moxen server is restarting, so this turn cannot start now; send again once it is back.",
    { exitCode: 9 },
  );
}
