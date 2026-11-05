import { CliError } from "../errors.js";

/**
 * When a scheduled message should run: an ISO date-time as given, or a bare
 * HH:MM as the next time the machine's local clock reads it (today, or
 * tomorrow once that has passed). One reading for `--at` and the agents' queue
 * tool, so the two cannot drift. `label` names the option in the error.
 */
export function parseScheduledTime(raw: string, now: Date = new Date(), label = "--at"): string {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  const parsed = Date.parse(raw.trim());
  if (!Number.isFinite(parsed)) throw new CliError("INVALID_THREAD_OPTION", `${label} takes an ISO date-time or HH:MM.`, { exitCode: 2 });
  return new Date(parsed).toISOString();
}
