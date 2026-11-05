import type { TurnUsagePause } from "../../core/types.js";
import { t } from "../i18n/index.js";
import { clockTime } from "./turns.js";

/**
 * The marker closing a turn that usage protection cut off, as plain lines the
 * row wraps. Joined by turn id from `ThreadEnvelope.turnUsagePauses`; the
 * reset is the allowance reset, not a promise of when recovery runs.
 */
export function usagePauseLines(pause: TurnUsagePause, now: number): string[] {
  // A hold the user asked for has no window and no reset: only a message ends it.
  if (pause.forced === true) return [t("timeline.protectedByYou"), t("timeline.protectedEnds"), ...(pause.hasUncommittedChanges === true ? [t("timeline.usagePausedUncommitted")] : [])];
  const names = [...new Set(pause.windows.map((window) => window.label).filter((label) => label !== ""))];
  const reset = pause.resetsAt !== null && clockTime(pause.resetsAt, now) !== "" ? clockTime(pause.resetsAt, now) : null;
  return [
    names.length > 0 ? t("timeline.usagePausedWindow", { window: names.join(", ") }) : t("timeline.usagePausedProvider", { provider: pause.provider }),
    reset === null ? t("timeline.usagePausedResetUnknown") : t("timeline.usagePausedReset", { at: reset }),
    ...(pause.hasUncommittedChanges === true ? [t("timeline.usagePausedUncommitted")] : []),
  ];
}

/** The marker's header: a hold the user placed is theirs, not the allowance's. */
export function usagePauseTitle(pause: TurnUsagePause): string {
  return t(pause.forced === true ? "timeline.protectedTitle" : "timeline.usagePaused");
}

/** The bare `/protect` command, which holds the open thread by hand. */
export function isProtectCommand(text: string): boolean {
  return text.trim() === "/protect";
}
