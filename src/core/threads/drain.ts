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

let draining = false;

/** True while a restart's drain waits for running work: nothing new may start. */
export function isDraining(): boolean {
  return draining;
}

/**
 * The process that owns the sessions turns the drain on when a restart is
 * requested, and off again once the drain has finished (a stop that never
 * came leaves the server taking work again, rather than wedged).
 */
export function setDraining(next: boolean): void {
  draining = next;
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
