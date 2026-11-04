import { useEffect, useMemo, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import { applyThreadFrame, emptyThreadState, timeline, type ThreadState } from "../../model/thread.js";
import { groupTurns, type TurnGroup } from "../../model/turns.js";
import { waitSpans } from "../../model/waits.js";

/**
 * One role thread read live, the way the open thread is: its own
 * subscription, folded into turn groups for the same timeline the chat pane
 * draws. Nothing is read for `null` (a slot that has not started, a sliver).
 */
export function useRoleTranscript(client: ClientApi, threadId: string | null): { state: ThreadState; groups: TurnGroup[] } {
  const [state, setState] = useState<ThreadState>(emptyThreadState);
  useEffect(() => {
    setState(emptyThreadState());
    if (threadId === null) return;
    return client.subscribeThread(
      threadId,
      {},
      (item) => setState((current) => applyThreadFrame(current, item)),
      () => undefined,
    );
  }, [client, threadId]);
  const groups = useMemo(
    () => groupTurns(timeline(state), waitSpans(state.activities), state.thread?.turnThroughput),
    [state],
  );
  return { state, groups };
}
