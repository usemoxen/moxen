import { act, useState } from "react";

import { useTerminalVisible } from "../../hooks/useTerminalVisible.js";
import { watchTerminalVisibility } from "../../model/terminalVisibility.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/**
 * A terminal that reports it is hidden (mode 2033) is not painted: what
 * changes meanwhile shows on its next frame once it can be seen, and not before.
 */
export async function runTerminalVisibility(): Promise<void> {
  let bump: () => void = () => {};
  function Counter() {
    const [count, setCount] = useState(0);
    const visible = useTerminalVisible();
    bump = () => setCount((current) => current + 1);
    return <text>{`count ${count} ${visible ? "visible" : "hidden"}`}</text>;
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
  const report = (state: number) =>
    act(async () => {
      (setup.renderer as unknown as { stdin: { emit(event: string, data: Buffer): void } }).stdin.emit("data", Buffer.from(`\x1b[?999;${state}n`));
    });

  await settle();
  if (!frame().includes("count 0 visible")) fail("the counter did not draw");

  await report(2);
  await settle();
  const hiddenFrame = frame();
  await act(async () => bump());
  await settle();
  if (frame() !== hiddenFrame) fail("the screen was painted while the terminal reported it hidden");

  await report(1);
  await settle();
  console.log("--- visibility: painted again once visible ---");
  console.log(frame());
  if (!frame().includes("count 1 visible")) fail("the change made while hidden was not painted once visible");

  stop();
  if (writes.at(-1) !== "\x1b[?2033l") fail("the mode was not switched off on stop");
}
