import { act, useState } from "react";

import { useTerminalVisible } from "../../hooks/useTerminalVisible.js";
import { useContextBreakdown, usePlanUsage } from "../../features/sidepanel/useSidePanel.js";
import type { ClientApi } from "../../../server/api.js";
import { ModelSceneRenderable, SceneBackdrop } from "../../ui/scenes/scenebackdrop.js";
import type { BaseRenderable } from "@opentui/core";
import { watchTerminalVisibility } from "../../model/terminalVisibility.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * A terminal that reports it is hidden (mode 2033) is not painted: what
 * changes meanwhile shows on its next frame once it can be seen, and not before.
 */
export async function runTerminalVisibility(): Promise<void> {
  let bump: () => void = () => {};
  let reads = 0;
  const client = { query: async (query: { type: string }) => {
    reads += 1;
    return query.type === "usage.limits" ? { providers: {} } : { breakdown: null, live: false };
  } } as ClientApi;
  function Counter() {
    const [count, setCount] = useState(0);
    const visible = useTerminalVisible();
    usePlanUsage(client, "turn", 20);
    useContextBreakdown(client, "thread", true, "turn", 20);
    bump = () => setCount((current) => current + 1);
    return <>
      <SceneBackdrop scene="grid" width={30} height={3} />
      <text bg="#000000" style={{ zIndex: 1 }}>{`count ${count} ${visible ? "visible" : "hidden"}`}</text>
    </>;
  }
  const setup = await testRender(<Counter />, { width: 30, height: 3, exitOnCtrlC: false });
  const writes: string[] = [];
  const stop = watchTerminalVisibility(setup.renderer, (data) => writes.push(data));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await setup.flush();
    });
  const frame = () => setup.captureCharFrame();
  const findScene = (node: BaseRenderable): ModelSceneRenderable | undefined =>
    node instanceof ModelSceneRenderable ? node : node.getChildren().map(findScene).find((child) => child !== undefined);
  const scene = findScene(setup.renderer.root);
  if (scene === undefined) fail("the animated backdrop did not mount");
  let advances = 0;
  const advance = scene.advance.bind(scene);
  scene.advance = (time, pointer) => { advances += 1; return advance(time, pointer); };
  const report = (state: number) =>
    act(async () => {
      (setup.renderer as unknown as { stdin: { emit(event: string, data: Buffer): void } }).stdin.emit("data", Buffer.from(`\x1b[?999;${state}n`));
    });

  await settle();
  if (!frame().includes("count 0 visible")) fail("the counter did not draw");
  if (reads <= 2) fail("visible side-panel data did not refresh");

  await report(2);
  await settle();
  const hiddenFrame = frame();
  const hiddenReads = reads;
  const hiddenAdvances = advances;
  await act(async () => bump());
  await settle();
  if (frame() !== hiddenFrame) fail("the screen was painted while the terminal reported it hidden");
  if (reads !== hiddenReads) fail("side-panel data kept polling while the terminal was hidden");
  if (advances !== hiddenAdvances) fail("the backdrop clock kept waking while the terminal was hidden");

  await report(1);
  await settle();
  console.log("--- visibility: painted again once visible ---");
  console.log(frame());
  if (!frame().includes("count 1 visible")) fail("the change made while hidden was not painted once visible");
  if (reads === hiddenReads) fail("side-panel refresh did not resume when the terminal became visible");
  if (advances === hiddenAdvances) fail("the backdrop clock did not resume when the terminal became visible");

  stop();
  if (writes.at(-1) !== "\x1b[?2033l") fail("the mode was not switched off on stop");
  await act(async () => setup.renderer.destroy());
}
