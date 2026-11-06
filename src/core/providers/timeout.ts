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
