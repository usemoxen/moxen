import { useEffect, useState } from "react";

import type { ClientApi } from "../../../server/api.js";
import type { StatsRange, UsageStats } from "../../model/stats.js";

export interface UsageStatsState {
  /** The chosen range's numbers; the previous range's stay up while the next load. */
  readonly stats: UsageStats | null;
  /** All time, always: the heatmap keeps every active day on screen and greys the ones outside the range. */
  readonly all: UsageStats | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * The stats screen's reads, made on open: all time once, and the chosen range
 * again whenever it changes (all time itself is the range `all` reuses).
 */
export function useUsageStats(client: Pick<ClientApi, "query">, open: boolean, range: StatsRange): UsageStatsState {
  const [all, setAll] = useState<UsageStats | null>(null);
  const [ranged, setRanged] = useState<UsageStats | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPending((count) => count + 1);
    client
      .query({ type: "usage.stats", range: "all" })
      .then((stats) => {
        if (!cancelled) {
          setAll(stats);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending((count) => count - 1));
    return () => {
      cancelled = true;
    };
  }, [client, open]);

  useEffect(() => {
    if (!open || range === "all") return;
    let cancelled = false;
    setPending((count) => count + 1);
    client
      .query({ type: "usage.stats", range })
      .then((stats) => {
        if (!cancelled) setRanged(stats);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending((count) => count - 1));
    return () => {
      cancelled = true;
    };
  }, [client, open, range]);

  return { stats: range === "all" ? all : (ranged ?? all), all, loading: pending > 0, error };
}
