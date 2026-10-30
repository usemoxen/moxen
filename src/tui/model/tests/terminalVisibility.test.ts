import { afterEach, describe, expect, it } from "vitest";

import { isTerminalVisible, setTerminalVisible } from "../../hooks/useTerminalVisible.js";
import { parseVisibilityReport, VISIBILITY_DISABLE, VISIBILITY_ENABLE, watchTerminalVisibility, type VisibilityRenderer } from "../terminalVisibility.js";

afterEach(() => setTerminalVisible(true));

function fakeRenderer() {
  let handlers: Array<(sequence: string) => boolean> = [];
  const painted: number[] = [];
  const renderer: VisibilityRenderer = {
    addInputHandler: (handler) => handlers.push(handler),
    removeInputHandler: (handler) => {
      handlers = handlers.filter((candidate) => candidate !== handler);
    },
    requestRender: () => {
      painted.push(painted.length);
    },
  };
  const receive = (sequence: string) => handlers.some((handler) => handler(sequence));
  return { renderer, painted, receive, handlerCount: () => handlers.length };
}

describe("visibility reports", () => {
  it("reads 2 as not visible and anything else as visible, as the specification asks", () => {
    expect(parseVisibilityReport("\x1b[?999;2n")).toBe(false);
    expect(parseVisibilityReport("\x1b[?999;1n")).toBe(true);
    expect(parseVisibilityReport("\x1b[?999;7n")).toBe(true);
    expect(parseVisibilityReport("\x1b[?997;2n")).toBeNull();
    expect(parseVisibilityReport("\x1b[I")).toBeNull();
  });

  it("paints nothing while hidden, and once on becoming visible again", () => {
    const { renderer, painted, receive } = fakeRenderer();
    const writes: string[] = [];
    watchTerminalVisibility(renderer, (data) => writes.push(data));
    expect(writes).toEqual([VISIBILITY_ENABLE]);

    renderer.requestRender();
    expect(painted).toHaveLength(1);

    expect(receive("\x1b[?999;2n")).toBe(true);
    expect(isTerminalVisible()).toBe(false);
    renderer.requestRender();
    renderer.requestRender();
    expect(painted).toHaveLength(1);

    expect(receive("\x1b[?999;1n")).toBe(true);
    expect(isTerminalVisible()).toBe(true);
    expect(painted).toHaveLength(2);
    renderer.requestRender();
    expect(painted).toHaveLength(3);
  });

  it("leaves other input to the renderer", () => {
    const { renderer, receive } = fakeRenderer();
    watchTerminalVisibility(renderer, () => {});
    expect(receive("\x1b[I")).toBe(false);
  });

  it("puts everything back when stopped, even while hidden: the mode off, painting on, visible", () => {
    const { renderer, painted, receive, handlerCount } = fakeRenderer();
    const writes: string[] = [];
    const stop = watchTerminalVisibility(renderer, (data) => writes.push(data));
    receive("\x1b[?999;2n");
    stop();
    expect(writes).toEqual([VISIBILITY_ENABLE, VISIBILITY_DISABLE]);
    expect(handlerCount()).toBe(0);
    expect(isTerminalVisible()).toBe(true);
    renderer.requestRender();
    expect(painted).toHaveLength(1);
  });
});
