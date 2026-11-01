import { afterEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "../poll.js";

afterEach(() => vi.useRealTimers());

describe("UI polling", () => {
  it("does not accumulate requests when a read outlasts several intervals, and stops after cleanup", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const stop = startPolling(read, 20);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a refresh timer for a hidden or finished view", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(undefined);
    const stop = startPolling(read, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
