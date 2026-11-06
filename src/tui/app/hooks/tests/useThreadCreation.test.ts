import { describe, expect, it, vi } from "vitest";

import { autoRelease } from "../useThreadCreation.js";

describe("autoRelease", () => {
  it("releases at once when asked, and never twice", async () => {
    const stop = vi.fn();
    const release = autoRelease(stop, 20);
    release();
    release();
    expect(stop).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases on its own when nobody does", async () => {
    const stop = vi.fn();
    autoRelease(stop, 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
