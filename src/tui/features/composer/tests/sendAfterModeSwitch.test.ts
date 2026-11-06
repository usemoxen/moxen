import { describe, expect, it, vi } from "vitest";

import { sendAfterModeSwitch } from "../useInteractionMode.js";

/** A mode switch still reaching the server, resolved by the test. */
function deferred() {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("sendAfterModeSwitch", () => {
  it("sends at once when no mode switch is in flight", async () => {
    const send = vi.fn();
    await expect(sendAfterModeSwitch(() => null, send)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds the send until the in-flight switch lands, then sends in the new mode", async () => {
    let current: Promise<boolean> | null = null;
    const gate = deferred();
    current = gate.promise;
    const send = vi.fn();
    const gated = sendAfterModeSwitch(() => current, send);
    await tick();
    expect(send).not.toHaveBeenCalled();
    current = null;
    gate.resolve(true);
    await expect(gated).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the send when the switch failed instead of sending in the old mode", async () => {
    let current: Promise<boolean> | null = Promise.resolve(false);
    const send = vi.fn();
    const gated = sendAfterModeSwitch(() => current, send);
    current = null;
    await expect(gated).resolves.toBe("switch-failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("chains onto a newer switch that arrived while waiting", async () => {
    let current: Promise<boolean> | null = null;
    const first = deferred();
    const second = deferred();
    current = first.promise;
    const send = vi.fn();
    const gated = sendAfterModeSwitch(() => current, send);
    await tick();
    expect(send).not.toHaveBeenCalled();
    // The first switch landed, but a second is in flight: the send waits on.
    current = second.promise;
    first.resolve(true);
    await tick();
    expect(send).not.toHaveBeenCalled();
    current = null;
    second.resolve(true);
    await expect(gated).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets an older failure go once the newer switch landed", async () => {
    let current: Promise<boolean> | null = null;
    const first = deferred();
    const second = deferred();
    current = first.promise;
    const send = vi.fn();
    const gated = sendAfterModeSwitch(() => current, send);
    current = second.promise;
    first.resolve(false);
    await tick();
    expect(send).not.toHaveBeenCalled();
    current = null;
    second.resolve(true);
    await expect(gated).resolves.toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the send when the latest switch failed", async () => {
    let current: Promise<boolean> | null = null;
    const first = deferred();
    const second = deferred();
    current = first.promise;
    const send = vi.fn();
    const gated = sendAfterModeSwitch(() => current, send);
    current = second.promise;
    first.resolve(true);
    await tick();
    current = null;
    second.resolve(false);
    await expect(gated).resolves.toBe("switch-failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("times out a hung switch instead of wedging every send", async () => {
    const send = vi.fn();
    await expect(sendAfterModeSwitch(() => new Promise<boolean>(() => {}), send, 20)).resolves.toBe("switch-timed-out");
    expect(send).not.toHaveBeenCalled();
  });
});
