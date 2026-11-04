import { describe, expect, it } from "vitest";

import { initialPicker, moveRow, setCritics, setResearchers, stepPicker, threadCount } from "../researchpicker.js";

describe("the run size picker", () => {
  it("never offers two critics: the critics row jumps between 1 and 3", () => {
    let state = initialPicker({ size: { researchers: 2, critics: 1 } });
    state = stepPicker(moveRow(state, 1), 1);
    expect(state.size.critics).toBe(3);
    expect(stepPicker(state, 1).size.critics).toBe(3);
    expect(stepPicker(state, -1).size.critics).toBe(1);
    expect(setCritics(state, 2)).toBe(state);
  });

  it("clamps a proposal the server would refuse to a size it accepts", () => {
    expect(initialPicker({ size: { researchers: 12, critics: 2 } }).size).toEqual({ researchers: 8, critics: 3 });
    expect(initialPicker({ size: { researchers: 0, critics: 0 } }).size).toEqual({ researchers: 1, critics: 1 });
  });

  it("keeps researchers between 1 and 8 and counts the lead and finalizer in the threads", () => {
    const state = initialPicker({ size: { researchers: 8, critics: 3 } });
    expect(stepPicker(state, 1).size.researchers).toBe(8);
    expect(setResearchers(state, 0).size.researchers).toBe(1);
    expect(threadCount(state.size)).toBe(13);
  });
});
