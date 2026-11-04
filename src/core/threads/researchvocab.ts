/**
 * The vocabulary of a research run's size: how many researchers and critics a
 * run may have, and the three reviews every run gets. Pure values, shared by
 * the server that enforces them and the clients that offer them.
 */

/** A run has one critic doing all three reviews, or three critics doing one each. There is no two. */
export const RESEARCH_CRITIC_COUNTS = [1, 3] as const;

export const RESEARCH_MAX_RESEARCHERS = 8;

/** The three reviews every run gets, in the order critics take them. */
export const RESEARCH_LENSES = ["evidence", "risks", "alternatives"] as const;
export type ResearchLens = (typeof RESEARCH_LENSES)[number];

/** Researchers 1 to 8 and critics 1 or 3. */
export function isValidResearchSize(size: { readonly researchers: number; readonly critics: number }): boolean {
  return Number.isInteger(size.researchers) && size.researchers >= 1 && size.researchers <= RESEARCH_MAX_RESEARCHERS &&
    (RESEARCH_CRITIC_COUNTS as readonly number[]).includes(size.critics);
}

export const RESEARCH_SIZE_MESSAGE = "Research size requires researchers 1 to 8 and critics 1 or 3.";
