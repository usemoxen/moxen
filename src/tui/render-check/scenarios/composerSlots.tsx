import { testRender } from "../testrender.js";

import { Composer } from "../../features/composer/composer.js";
import { fail } from "../helpers.js";

/**
 * The composer's fixed grid. Top row: mode, model and effort on the left, plan
 * usage and context on the right. Bottom row: permission and background tasks
 * on the left, copy, external and stop on the right. Every control keeps its
 * slot whatever the provider reports, so nothing moves when the provider does.
 */
export async function runComposerSlots(): Promise<void> {
  const frameOf = async (width: number, options: { withStatus?: boolean; running?: boolean; draft?: string } = {}) => {
    const { withStatus = true, running = false, draft = "Alright, check this out now:" } = options;
    const setup = await testRender(
      <Composer
        draft={draft}
        resetKey="k"
        onInput={() => {}}
        onSubmit={() => {}}
        onEscape={() => {}}
        onFocus={() => {}}
        focused
        placeholder="Message the agent"
        model="Claude Sonnet 5.5"
        effort="Medium"
        permission="Full access"
        submitVerb="sends"
        running={running}
        width={width}
        mode="default"
        onCycleMode={() => {}}
        onModelClick={() => {}}
        onEffortClick={() => {}}
        onPermissionClick={() => {}}
        onCopyClick={() => {}}
        onExternalEditClick={() => {}}
        onStopClick={() => {}}
        {...(withStatus
          ? {
              contextUsage: { percent: 18, usedLabel: "181k", maxLabel: "1m" } as never,
              planUsage: [
                { short: "5h", percent: 14 },
                { short: "wk", percent: 51 },
              ] as never,
              backgroundSummary: "1 shell",
            }
          : {})}
      />,
      { width: width + 2, height: 14, exitOnCtrlC: false },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    return frame;
  };

  for (const width of [64, 110]) {
    const frame = await frameOf(width);
    if (process.env.COMPOSER_DEBUG) console.log(`--- composer @${width}\n${frame}`);
    const lines = frame.split("\n");
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    const label = `composer @${width}`;
    for (const needle of ["Build", "Claude Sonnet 5.5", "Medium", "Full access"]) {
      if (at(needle) === -1) fail(`${label}: "${needle}" is not on screen`);
    }
    // Selectors above the draft, permission and actions under it.
    if (!(at("Build") < at("Alright"))) fail(`${label}: the selectors are not above the draft`);
    if (!(at("Full access") > at("Alright"))) fail(`${label}: the permission is not under the draft`);
    // Narrow, what does not fit is behind "more"; wide, every control is on screen in its slot.
    const narrow = width < 80;
    for (const needle of ["copy", "external"]) {
      if (at(needle) === -1 && !(narrow && at("⋯ more") !== -1)) fail(`${label}: "${needle}" is not on screen`);
    }
    if (!narrow) {
      const top = lines.find((line) => line.includes("Build")) ?? "";
      if (!top.includes("5h 14%") || !top.includes("181k/1m") || top.indexOf("5h 14%") < top.indexOf("Medium")) fail(`${label}: usage and context are not on the right of the selectors' row`);
      const bottom = lines.find((line) => line.includes("Full access")) ?? "";
      const order = ["Full access", "1 shell", "copy", "external"].map((needle) => bottom.indexOf(needle));
      if (order.some((column) => column === -1) || order.some((column, index) => index > 0 && column < order[index - 1]!)) fail(`${label}: the bottom row is not permission, background, then the actions`);
    }
  }

  // Nothing moves with the provider's data: the same rows and columns with usage, context and shells as without any.
  const slots = async (withStatus: boolean) => {
    const rows = (await frameOf(90, { withStatus })).split("\n");
    const find = (needle: string) => rows.findIndex((line) => line.includes(needle));
    const column = (needle: string) => rows[find(needle)]?.indexOf(needle) ?? -1;
    return { build: find("Build"), buildAt: column("Build"), permission: find("Full access"), permissionAt: column("Full access"), copy: find("copy"), externalAt: column("external") };
  };
  const withStatus = await slots(true);
  const without = await slots(false);
  if (JSON.stringify(withStatus) !== JSON.stringify(without)) fail(`the composer moves with the provider's data: ${JSON.stringify(withStatus)} vs ${JSON.stringify(without)}`);

  // A running turn shows stop, and the slots stay where they were.
  const running = await frameOf(110, { running: true });
  if (!running.includes("stop")) fail("stop is not on screen while a turn runs");
}
