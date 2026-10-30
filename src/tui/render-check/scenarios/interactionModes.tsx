import { act, useState } from "react";
import { testRender } from "../testrender.js";

import type { InteractionMode } from "../../../core/types.js";
import { Composer } from "../../features/composer/composer.js";
import { nextInteractionMode } from "../../model/modes.js";
import { applyTheme, MODE_COLOR } from "../../theme.js";
import { fail } from "../helpers.js";

/**
 * Shift+Tab cycles Build → Research → Orchestrate → Build. The composer's
 * left edge takes each mode's colour and the footer leads with every mode.
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
  const expectations: ReadonlyArray<{ mode: InteractionMode; label: string }> = [
    { mode: "default", label: "Build" },
    { mode: "research", label: "Research" },
    { mode: "orchestrate", label: "Orchestrate" },
    { mode: "default", label: "Build" },
  ];
  for (const [index, expected] of expectations.entries()) {
    if (index > 0) {
      await act(async () => setup.mockInput.pressTab({ shift: true }));
      await setup.flush();
    }
    const frame = setup.captureCharFrame();
    console.log(`--- composer: ${expected.mode} mode ---`);
    console.log(frame);
    if (!frame.includes(`${expected.label} · Claude Opus 5`)) fail(`the footer does not lead with ${expected.mode} mode`);
    const color = edge();
    if (color !== MODE_COLOR[expected.mode]) fail(`the composer edge is ${color ?? "missing"} in ${expected.mode} mode, not ${MODE_COLOR[expected.mode]}`);
  }
  // A theme switch reaches a mounted composer on its next draw.
  applyTheme("dracula");
  try {
    await act(async () => setup.mockInput.pressTab({ shift: true }));
    await setup.flush();
    const color = edge();
    if (color !== MODE_COLOR.research) fail(`the composer edge is ${color ?? "missing"} after a theme change, not ${MODE_COLOR.research}`);
  } finally {
    applyTheme("moxen");
  }
  // No destroy(), as in bootGate: tearing down a second renderer breaks the shared one.
}
