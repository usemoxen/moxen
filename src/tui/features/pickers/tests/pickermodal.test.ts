import { describe, expect, it, vi } from "vitest";

import { pickRow } from "../pickermodal.js";

/**
 * Picker rows dispatch through {@link pickRow} on both mouse and keyboard so
 * a row taking an optional callback (Compact, Protect) never receives the
 * mouse event as that callback. Rendering runs only under bun (the OpenTUI
 * test renderer needs its bun-only FFI, which vitest's node runtime cannot
 * load), so this pins the shared call contract directly; the render-check
 * command-palette walkthrough pins the actual mouse path.
 */
describe("pickRow", () => {
  it("calls a callback-taking row with no args, so no event impersonates the callback", () => {
    const received: unknown[][] = [];
    let ranDefault = false;
    pickRow({
      key: "compact",
      label: "Compact session",
      onPick: (...args: unknown[]) => {
        received.push(args);
        const onDispatched = (args[0] ?? (() => { ranDefault = true; })) as () => void;
        onDispatched();
      },
    });
    expect(received).toEqual([[]]);
    expect(ranDefault).toBe(true);
  });

  it("passes a plain row through exactly once", () => {
    const onPick = vi.fn();
    pickRow({ key: "x", label: "X", onPick });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith();
  });
});
