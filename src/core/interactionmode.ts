/**
 * A thread's mode. Build (`"default"`, the value envelopes have always
 * carried) is the only one for now; Research and Orchestrate join it as
 * modes of their own (MXN-137).
 *
 * Plan mode was removed (MXN-136). What was saved with it still loads — a
 * stored thread or a config that says `plan` reads as Build — but asking
 * for it now is refused, so a script that relies on it hears why.
 */
import { CliError } from "./errors.js";
import type { InteractionMode } from "./types.js";

export const INTERACTION_MODES: readonly InteractionMode[] = ["default"];

const isMode = (value: unknown): value is InteractionMode =>
  typeof value === "string" && (INTERACTION_MODES as readonly string[]).includes(value);

/** A mode as saved (a thread record, a config file): a removed or unknown one reads as Build. */
export function storedInteractionMode(value: unknown): InteractionMode {
  return isMode(value) ? value : "default";
}

/** A mode someone asks for now (a command, a CLI flag): `plan` and unknown values are refused. */
export function requestedInteractionMode(value: unknown, where: string): InteractionMode {
  if (isMode(value)) return value;
  if (value === "plan") {
    throw new CliError("PLAN_MODE_REMOVED", "Plan mode was removed: threads run in Build mode. Drop the plan mode option.", {
      exitCode: 2,
      details: { interactionMode: value },
    });
  }
  throw new CliError("INVALID_THREAD_OPTION", `${where} interactionMode must be one of ${INTERACTION_MODES.join(", ")}.`, {
    exitCode: 2,
    details: { interactionMode: value },
  });
}
