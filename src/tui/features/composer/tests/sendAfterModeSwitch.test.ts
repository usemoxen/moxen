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

describe("sendAfterModeSwitch", () => {
  it("sends at once when no mode switch is in flight", async () => {
    const send = vi.fn();
    await expect(sendAfterModeSwitch(null, send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds the send until the in-flight switch lands, then sends in the new mode", async () => {
    const gate = deferred();
    const send = vi.fn();
    const gated = sendAfterModeSwitch(gate.promise, send);
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();
    gate.resolve(true);
    await expect(gated).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the send when the switch failed instead of sending in the old mode", async () => {
    const send = vi.fn();
    await expect(sendAfterModeSwitch(Promise.resolve(false), send)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
