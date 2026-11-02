import { useCallback, useEffect, useState } from "react";
import type { ClientApi } from "../../../server/api.js";
import type { CommandOf, QueryResults } from "../../../server/protocol.js";
import { startPolling } from "../../hooks/poll.js";

export type QueueEntry = QueryResults["queue.read"]["entries"][number];
export type QueuePolicy = NonNullable<CommandOf<"thread.turn.start">["queue"]>;
export type QueueCondition = QueuePolicy["conditions"][number];

export function useWorkQueue(client: ClientApi) {
  const [entries, setEntries] = useState<readonly QueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    const result = await client.query({ type: "queue.read" });
    setEntries(result?.entries ?? []);
  }, [client]);
  useEffect(() => {
    let stopped = false;
    const stop = startPolling(async () => {
      try { const result = await client.query({ type: "queue.read" }); if (!stopped) setEntries(result?.entries ?? []); }
      catch (cause) { if (!stopped) setError(String(cause)); }
    }, 2000);
    return () => { stopped = true; stop(); };
  }, [client]);
  const edit = useCallback(async (targets: readonly QueueEntry[], action: CommandOf<"queue.edit">["action"], change?: (policy: QueuePolicy) => QueuePolicy) => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      for (const entry of targets) await client.dispatch({ type: "queue.edit", threadId: entry.threadId, turnId: entry.turnId, action, ...(change ? { policy: change(entry.policy) } : {}) });
      await refresh();
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  }, [client, refresh, saving]);
  const add = useCallback(async (threadId: string, prompt: string) => {
    setError(null);
    try {
      await client.dispatch({ type: "thread.turn.start", threadId, message: { text: prompt }, wakeSettled: true, queue: { conditions: [], held: true, order: Date.now(), sequential: true, continuation: "same-thread" } });
      await refresh();
    } catch (cause) { setError(String(cause)); }
  }, [client, refresh]);
  return { entries, error, saving, edit, add };
}
