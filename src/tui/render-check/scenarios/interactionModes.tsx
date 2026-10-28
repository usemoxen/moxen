import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";

import type { InteractionMode } from "../../../core/types.js";
import { Composer } from "../../features/composer/composer.js";
import { nextInteractionMode } from "../../model/modes.js";
import { MODE_COLOR } from "../../theme.js";
import { fail } from "../helpers.js";

/**
 * Shift+Tab cycles Build → Research → Orchestrate → Build. The composer's
 * left edge takes each mode's colour and the footer names any mode but Build.
 */
export async function runInteractionModes(): Promise<void> {
  function Harness() {
    const [mode, setMode] = useState<InteractionMode>("default");
    return (
      <Composer
        draft=""
        resetKey="k"
        onInput={() => {}}
        onSubmit={() => {}}
        onEscape={() => {}}
        onFocus={() => {}}
        focused
        placeholder="Message the agent"
        model="Claude Opus 5"
        permission="Full access"
        submitVerb="sends"
        running={false}
        width={80}
        mode={mode}
        onCycleMode={() => setMode(nextInteractionMode(mode))}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 82, height: 10, exitOnCtrlC: false });
  await setup.flush();
  const hex = (color: { r: number; g: number; b: number }) =>
    `#${[color.r, color.g, color.b].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
  /** The colour of the composer's left edge (the heavy bar in column 0). */
  const edge = (): string | null => {
    for (const line of setup.captureSpans().lines) {
      const span = line.spans.find((candidate) => candidate.text.startsWith("┃"));
      if (span) return hex(span.fg);
    }
    return null;
  };
  const expectations: ReadonlyArray<{ mode: InteractionMode; label: string | null }> = [
    { mode: "default", label: null },
    { mode: "research", label: "Full access · Research" },
    { mode: "orchestrate", label: "Full access · Orchestrate" },
    { mode: "default", label: null },
  ];
  for (const [index, expected] of expectations.entries()) {
    if (index > 0) {
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
    }
    const frame = setup.captureCharFrame();
    console.log(`--- composer: ${expected.mode} mode ---`);
    console.log(frame);
    if (expected.label !== null && !frame.includes(expected.label)) fail(`the footer does not name ${expected.mode} mode`);
    if (expected.label === null && /· (Research|Orchestrate)/u.test(frame)) fail("Build mode is named in the footer");
    const color = edge();
    if (color !== MODE_COLOR[expected.mode]) fail(`the composer edge is ${color ?? "missing"} in ${expected.mode} mode, not ${MODE_COLOR[expected.mode]}`);
  }
  // No destroy(), as in bootGate: tearing down a second renderer breaks the shared one.
}
