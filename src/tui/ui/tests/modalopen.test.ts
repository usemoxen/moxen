import { describe, expect, it } from "vitest";

import { isModalOpen, modalOpened, resetModalOpen } from "../modalopen.js";

describe("modal open", () => {
  it("is open while any modal is, and a release only counts once", () => {
    expect(isModalOpen()).toBe(false);
    const first = modalOpened();
    const second = modalOpened();
    expect(isModalOpen()).toBe(true);
    first();
    first();
    // The doubled release must not close the other modal.
    expect(isModalOpen()).toBe(true);
    second();
    expect(isModalOpen()).toBe(false);
  });

  it("forgets modals on reset, and their late release does nothing", () => {
    const release = modalOpened();
    resetModalOpen();
    expect(isModalOpen()).toBe(false);
    const other = modalOpened();
    release();
    expect(isModalOpen()).toBe(true);
    other();
    expect(isModalOpen()).toBe(false);
  });
});
