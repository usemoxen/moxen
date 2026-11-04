import { useCallback, useEffect, useState } from "react";

import type { ClientApi, ResearchPlan, ResearchProposal } from "../../../server/api.js";
import { startPolling } from "../../hooks/poll.js";

/** How often the open thread is asked whether a run size is waiting for an answer. */
const POLL_MS = 400;

/**
 * Lets the server ask this client for a run size. A proposal only reaches a
 * client that opted in for the thread, so the opt-in is held while the thread
 * can start a run (`enabled`: Research mode is on, or `/research` is typed),
 * and dropped otherwise: the server then runs one researcher instead, which is
 * also what happens when this client goes away mid-question.
 */
export function useResearchProposal(
  client: ClientApi,
  threadId: string | null,
  enabled: boolean,
  setError: (message: string) => void,
): {
  proposal: ResearchProposal | null;
  start: (plan: ResearchPlan) => void;
  single: () => void;
} {
  const [proposal, setProposal] = useState<ResearchProposal | null>(null);
  useEffect(() => {
    setProposal(null);
    if (!enabled || threadId === null) return;
    let cancelled = false;
    const unsubscribe = client.subscribeShell({ researchProposals: [threadId] }, () => undefined, () => undefined);
    const stop = startPolling(
      () =>
        client
          .query({ type: "research.proposals", threadId })
          .then((list) => {
            if (cancelled) return;
            const next = list[0] ?? null;
            setProposal((current) => (current?.id === next?.id ? current : next));
          })
          .catch(() => undefined),
      POLL_MS,
    );
    return () => {
      cancelled = true;
      stop();
      unsubscribe();
    };
  }, [client, threadId, enabled]);

  const answer = useCallback(
    (body: { choice: "start"; plan: ResearchPlan } | { choice: "single" }) => {
      if (proposal === null) return;
      const proposalId = proposal.id;
      setProposal(null);
      void client.dispatch({ type: "research.proposal.answer", proposalId, ...body }).catch((cause: unknown) => setError(String(cause).slice(0, 120)));
    },
    [client, proposal, setError],
  );
  return {
    proposal,
    start: (plan) => answer({ choice: "start", plan }),
    single: () => answer({ choice: "single" }),
  };
}
