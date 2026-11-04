import { RESEARCH_CRITIC_COUNTS, RESEARCH_MAX_RESEARCHERS } from "../../core/threads/researchvocab.js";
import type { ResearchPlan, ResearchSize } from "../../server/api.js";

/**
 * The run size picker's state: researchers 1 to 8 as a total for the run, and
 * critics as one of two choices (1 or 3, never 2). Pure, so the keys and the
 * clicks it answers can be pinned without a screen.
 */

export type PickerRow = "researchers" | "critics";

export const PICKER_ROWS: readonly PickerRow[] = ["researchers", "critics"];

export interface PickerState {
  readonly size: ResearchSize;
  readonly row: PickerRow;
}

/** Clamps whatever the proposal suggested to a size the server accepts. */
export function initialPicker(plan: ResearchPlan): PickerState {
  const researchers = Math.min(RESEARCH_MAX_RESEARCHERS, Math.max(1, Math.round(plan.size.researchers)));
  const critics = (RESEARCH_CRITIC_COUNTS as readonly number[]).includes(plan.size.critics) ? plan.size.critics : plan.size.critics > 1 ? 3 : 1;
  return { size: { researchers, critics }, row: "researchers" };
}

/** Left or right on the focused row: researchers step by one, critics jump between their two choices. */
export function stepPicker(state: PickerState, direction: 1 | -1, row: PickerRow = state.row): PickerState {
  if (row === "researchers") {
    const researchers = Math.min(RESEARCH_MAX_RESEARCHERS, Math.max(1, state.size.researchers + direction));
    return { ...state, row, size: { ...state.size, researchers } };
  }
  const choices = RESEARCH_CRITIC_COUNTS;
  const at = choices.findIndex((count) => count === state.size.critics);
  const critics = choices[Math.min(choices.length - 1, Math.max(0, at + direction))]!;
  return { ...state, row, size: { ...state.size, critics } };
}

export function setResearchers(state: PickerState, researchers: number): PickerState {
  return { ...state, row: "researchers", size: { ...state.size, researchers: Math.min(RESEARCH_MAX_RESEARCHERS, Math.max(1, researchers)) } };
}

export function setCritics(state: PickerState, critics: number): PickerState {
  if (!(RESEARCH_CRITIC_COUNTS as readonly number[]).includes(critics)) return state;
  return { ...state, row: "critics", size: { ...state.size, critics } };
}

export function moveRow(state: PickerState, direction: 1 | -1): PickerState {
  const at = PICKER_ROWS.indexOf(state.row);
  return { ...state, row: PICKER_ROWS[(at + direction + PICKER_ROWS.length) % PICKER_ROWS.length]! };
}

/** Threads the run opens: the lead, every researcher and critic, and one finalizer. */
export function threadCount(size: ResearchSize): number {
  return 1 + size.researchers + size.critics + 1;
}
