import type { QueryResult } from "./protocol.js";

export type EmbeddingsHeartbeatStatus = QueryResult<"memory.embeddings.status">;

export interface EmbeddingsHeartbeat {
  /** Status polls that completed since start. */
  beats: number;
  /** Slowest completed poll, in milliseconds. */
  maxHeartbeatMs: number;
  /** Polls that started but have not settled yet. */
  pending: number;
  /** Stop starting new polls. A poll already in flight still settles quietly. */
  stop(): void;
}

/**
 * Polls `memory.embeddings.status` alongside other work, the way
 * `scripts/verify-memory-embeddings.ts` watches a long embeddings run.
 * One poll at a time: a tick while one is in flight is skipped.
 *
 * A failed poll is ignored, never thrown: the heartbeat is observational —
 * progress logging plus the `beats` / `maxHeartbeatMs` counters the caller
 * asserts on — and a poll can legitimately fail at teardown, when a query
 * parked at `close()` rejects with `SERVER_DISCONNECTED`. Letting that
 * rejection escape the fire-and-forget chain is an unhandled rejection and
 * fails the process after every validation passed (MXN-320).
 */
export function startEmbeddingsHeartbeat(
  status: () => Promise<EmbeddingsHeartbeatStatus>,
  onProgress: (progress: string) => void,
  intervalMs = 50,
): EmbeddingsHeartbeat {
  const heartbeat: EmbeddingsHeartbeat = {
    beats: 0,
    maxHeartbeatMs: 0,
    pending: 0,
    stop: () => clearInterval(timer),
  };
  let lastProgress = "";
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    heartbeat.pending += 1;
    const started = performance.now();
    void status()
      .then((result) => {
        heartbeat.beats += 1;
        heartbeat.maxHeartbeatMs = Math.max(heartbeat.maxHeartbeatMs, performance.now() - started);
        const progress = result.file ?? result.state;
        if (progress !== lastProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        heartbeat.pending -= 1;
        polling = false;
      });
  }, intervalMs);
  return heartbeat;
}
