import type { TurnUsagePause } from "../../core/types.js";
import { t } from "../i18n/index.js";
import { clockTime } from "./turns.js";

/**
 * The marker closing a turn that usage protection cut off, as plain lines the
 * row wraps. Joined by turn id from `ThreadEnvelope.turnUsagePauses`; the
 * reset is the allowance reset, not a promise of when recovery runs.
 */
export function usagePauseLines(pause: TurnUsagePause, now: number): string[] {
  const names = [...new Set(pause.windows.map((window) => window.label).filter((label) => label !== ""))];
  const reset = pause.resetsAt !== null && clockTime(pause.resetsAt, now) !== "" ? clockTime(pause.resetsAt, now) : null;
  return [
    names.length > 0 ? t("timeline.usagePausedWindow", { window: names.join(", ") }) : t("timeline.usagePausedProvider", { provider: pause.provider }),
    reset === null ? t("timeline.usagePausedResetUnknown") : t("timeline.usagePausedReset", { at: reset }),
    ...(pause.hasUncommittedChanges === true ? [t("timeline.usagePausedUncommitted")] : []),
  ];
}
