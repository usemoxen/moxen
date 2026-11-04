import { useRef, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import type { ResearchRole } from "../../../server/api.js";
import { scrollPane } from "../../app/utils.js";
import {
  agentAt, defaultAgentIndex, focusRoleOf, stepAgent, stepRole, type AgentRef, type RunAgent, type RunSummary,
} from "../../model/researchrun.js";

interface ViewState {
  /** The column keys act on; null follows the phase. */
  readonly role: ResearchRole | null;
  /** The agent the user picked in each role; absent follows the one at work. */
  readonly picks: Readonly<Partial<Record<ResearchRole, number>>>;
}

const NOTHING: ViewState = { role: null, picks: {} };

/**
 * What the run view remembers about one run: the column keys act on and the
 * agent shown in each column. A run nobody touched follows the work (the
 * phase's column, the agent running in it); a pick stays until the next one.
 * Kept per lead, so a trip into a role thread and back finds the same view.
 */
export function useResearchRunView() {
  const [views, setViews] = useState<ReadonlyMap<string, ViewState>>(new Map());
  const scrollRefs = useRef<Record<ResearchRole, RefObject<ScrollBoxRenderable | null>>>({
    researcher: { current: null }, critic: { current: null }, finalizer: { current: null },
  });
  const update = (leadId: string, change: (current: ViewState) => ViewState) =>
    setViews((current) => new Map(current).set(leadId, change(current.get(leadId) ?? NOTHING)));

  const roleOf = (summary: RunSummary): ResearchRole => views.get(summary.leadThreadId)?.role ?? focusRoleOf(summary);
  const refOf = (summary: RunSummary, role: ResearchRole): AgentRef => ({
    role, index: views.get(summary.leadThreadId)?.picks[role] ?? defaultAgentIndex(summary, role),
  });
  const select = (summary: RunSummary, ref: AgentRef) =>
    update(summary.leadThreadId, (current) => ({ role: ref.role, picks: { ...current.picks, [ref.role]: ref.index } }));
  return {
    scrollRefs: scrollRefs.current,
    /** The column keys act on now. */
    roleOf,
    /** The agent a column shows now. */
    refOf,
    agentOf: (summary: RunSummary, role: ResearchRole): RunAgent | null => agentAt(summary, refOf(summary, role)),
    /** Shows `ref` in its column and moves the keys there. */
    select,
    focusRole: (summary: RunSummary, role: ResearchRole) => update(summary.leadThreadId, (current) => ({ ...current, role })),
    /** Left and right: the previous or next agent of the whole roster. */
    stepAgent: (summary: RunSummary, direction: 1 | -1) => select(summary, stepAgent(summary, refOf(summary, roleOf(summary)), direction)),
    /** Tab: the next column. */
    stepRole: (summary: RunSummary, direction: 1 | -1) =>
      update(summary.leadThreadId, (current) => ({ ...current, role: stepRole(roleOf(summary), direction) })),
    /** Arrow and page keys scroll the focused column. */
    scroll: (summary: RunSummary, keyName: string) => scrollPane(scrollRefs.current[roleOf(summary)].current, keyName),
  };
}

export type ResearchRunViewApi = ReturnType<typeof useResearchRunView>;
