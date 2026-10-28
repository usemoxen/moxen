/**
 * The composer's side of a thread's mode (`InteractionMode`): Shift+Tab
 * cycles Build → Research → Orchestrate, and `/research` / `/orchestrate`
 * switch one on, or back to Build when it is already on. The procedures
 * themselves are the server's (`core/threads/modes.ts`).
 */
import { interactionModeLabel } from "../../core/interactionmode.js";
import type { InteractionMode } from "../../core/types.js";

const CYCLE: readonly InteractionMode[] = ["default", "research", "orchestrate"];

export function nextInteractionMode(mode: InteractionMode): InteractionMode {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]!;
}

export { interactionModeLabel };

export interface ModeCommand {
  /** The mode the thread is in afterwards. */
  readonly mode: InteractionMode;
  /** Text after the command, sent once the mode is set; empty when there is none. */
  readonly rest: string;
}

/**
 * A draft that opens with `/research` or `/orchestrate`, or null. Alone, the
 * command toggles (the same one again is Build); with text after it, the mode
 * is switched on and the text goes out in it.
 */
export function parseModeCommand(draft: string, current: InteractionMode): ModeCommand | null {
  const match = /^\/(research|orchestrate)(?:\s+([\s\S]*))?$/u.exec(draft.trim());
  if (match === null) return null;
  const named = match[1] as InteractionMode;
  const rest = (match[2] ?? "").trim();
  if (rest.length > 0) return { mode: named, rest };
  return { mode: current === named ? "default" : named, rest: "" };
}
