import { flushTurnRunners } from "../threads/execute.js";

/** The flush returns immediately on settlement, but silently gives up at its
 * limit. Assertion waits need enough room for a loaded Windows filesystem. */
export const settleRuns = () => flushTurnRunners(8000);
