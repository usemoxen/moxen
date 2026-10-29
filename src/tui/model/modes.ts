/**
 * The composer's side of a thread's mode (`InteractionMode`): Shift+Tab
 * cycles Build → Research → Orchestrate and stays there, while `/research` /
 * `/orchestrate` are for one prompt: the thread goes back to its own mode
 * after it. The procedures
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
  /** The mode the prompt runs in: this one only, the thread's own mode is not changed. */
  readonly mode: InteractionMode;
  /** Text after the command, sent in that mode; empty when there is none (the mode is held for the next prompt). */
  readonly rest: string;
}

/**
 * A draft that opens with `/research` or `/orchestrate`, or null. With text
 * after it, that prompt runs in the mode (one-off); alone, it arms the mode
 * for the next prompt you send.
 */
export function parseModeCommand(draft: string): ModeCommand | null {
  const match = /^\/(research|orchestrate)(?:\s+([\s\S]*))?$/u.exec(draft.trim());
  if (match === null) return null;
  return { mode: match[1] as InteractionMode, rest: (match[2] ?? "").trim() };
}
