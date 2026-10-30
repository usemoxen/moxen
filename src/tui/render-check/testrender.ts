import { testRender as render } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";

/**
 * Where every captured frame goes when the visual harness (`shots.tsx`) is
 * running; null in a plain render-check, where `testRender` is the real one.
 * The label is the `--- name ---` line the scenario logged just before it
 * captured, which is how the scenarios already name what they draw.
 */
export const frameSink: { current: ((setup: TestRendererSetup, label: string) => void) | null } = { current: null };

let pendingLabel = "";
const LABEL = /^--- (.*) ---$/;

/** Silences the scenarios' console output and remembers their labels; returns the undo. */
export function listenForLabels(): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    const match = LABEL.exec(text);
    if (match) pendingLabel = match[1] ?? "";
  };
  return () => {
    console.log = original;
  };
}

/** `testRender` from `@opentui/react/test-utils`, with each frame capture reported to `frameSink`. */
export const testRender: typeof render = async (node, options) => {
  const setup = await render(node, options);
  const capture = setup.captureCharFrame.bind(setup);
  setup.captureCharFrame = () => {
    const frame = capture();
    frameSink.current?.(setup, pendingLabel);
    return frame;
  };
  return setup;
};
