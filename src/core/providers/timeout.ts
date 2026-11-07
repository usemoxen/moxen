/**
 * One shared bounded wait for stop and interrupt paths: `Promise.race`
 * against a timer that neither keeps the process alive nor leaks (unref'd,
 * always cleared). Rejections propagate; only the deadline resolves
 * `TIMED_OUT`.
 */
export const TIMED_OUT = Symbol("moxen-timeout");

export async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reject when `signal` aborts, so a joiner waiting on a start a stop just
 * abandoned goes fresh at once instead of hanging on the zombie. The
 * listener is removed once the race settles.
 */
export function abortRace<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("The start was abandoned by a stop."));
  let onAbort!: () => void;
  const abandoned = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("The start was abandoned by a stop."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, abandoned]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}
