/**
 * A thread's mode: Build (`"default"`, the value envelopes have always
 * carried), Research and Orchestrate (MXN-137, procedures in
 * `threads/modes.ts`), and Review (MXN-286: a delegated task's or one
 * prompt's mode, never a thread's own staying mode).
 *
 * Plan mode was removed (MXN-136). What was saved with it still loads — a
 * stored thread or a config that says `plan` reads as Build — but asking
 * for it now is refused, so a script that relies on it hears why.
 */
import { CliError } from "./errors.js";
import type { InteractionMode } from "./types.js";

export const INTERACTION_MODES: readonly InteractionMode[] = ["default", "research", "orchestrate", "review"];

/**
 * The modes a thread itself stays in: Build, Research, Orchestrate.
 * Review is a delegate and one-off mode only (`delegate`'s `mode`,
 * `/review`), so it is never a Shift+Tab stop and never a thread's own
 * mode, config value or handover target.
 */
export const STICKY_INTERACTION_MODES: readonly InteractionMode[] = ["default", "research", "orchestrate"];

/** How a client names a mode. */
export function interactionModeLabel(mode: InteractionMode): string {
  return mode === "research" ? "Research" : mode === "orchestrate" ? "Orchestrate" : mode === "review" ? "Review" : "Build";
}

const isMode = (value: unknown): value is InteractionMode =>
  typeof value === "string" && (INTERACTION_MODES as readonly string[]).includes(value);

/** A mode as saved (a thread record, a config file): a removed or unknown one reads as Build. */
export function storedInteractionMode(value: unknown): InteractionMode {
  return isMode(value) ? value : "default";
}

/**
 * A mode someone asks for now (a command, a CLI flag): `plan` and unknown
 * values are refused. Review is refused too unless the caller allows it —
 * it runs a delegated task or one prompt, never a thread of its own.
 */
export function requestedInteractionMode(
  value: unknown,
  where: string,
  allowed: readonly InteractionMode[] = STICKY_INTERACTION_MODES,
): InteractionMode {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as InteractionMode;
  if (value === "plan") {
    throw new CliError("PLAN_MODE_REMOVED", "Plan mode was removed: threads run in Build mode. Drop the plan mode option.", {
      exitCode: 2,
      details: { interactionMode: value },
    });
  }
  if (value === "review" && !(allowed as readonly string[]).includes("review")) {
    throw new CliError(
      "INVALID_THREAD_OPTION",
      `${where} cannot put a thread in Review mode: delegate with mode "review" or send one prompt with /review. A thread's own mode stays Build, Research or Orchestrate.`,
      {
        exitCode: 2,
        details: { interactionMode: value },
      },
    );
  }
  throw new CliError("INVALID_THREAD_OPTION", `${where} interactionMode must be one of ${allowed.join(", ")}.`, {
    exitCode: 2,
    details: { interactionMode: value },
  });
}
