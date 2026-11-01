/** Poll immediately, then at most once at a time; callers handle read errors and stale results. */
export function startPolling(read: () => Promise<unknown>, intervalMs: number | null): () => void {
  let stopped = false;
  let pending = false;
  const poll = async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      await read();
    } finally {
      pending = false;
    }
  };
  void poll();
  const timer = intervalMs === null ? null : setInterval(() => void poll(), intervalMs);
  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
  };
}
