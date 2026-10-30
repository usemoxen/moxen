import { act } from "react";
import { testRender } from "../testrender.js";

import { DateTimeModal } from "../../ui/datetimemodal.js";
import { fail } from "../helpers.js";

/**
 * The Schedule message picker: digit fields that step with the arrows,
 * type over, move with ←/→, and submit a real moment on enter.
 */
export async function runScheduleModal(): Promise<void> {
  const submitted: Date[] = [];
  let closed = 0;
  const setup = await testRender(
    <DateTimeModal
      screenWidth={70}
      screenHeight={16}
      left={3}
      top={2}
      width={64}
      height={10}
      onSubmit={(at) => submitted.push(at)}
      onClose={() => (closed += 1)}
    />,
    { width: 70, height: 16, exitOnCtrlC: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await setup.flush();
  const first = setup.captureCharFrame();
  console.log("--- schedule picker ---");
  console.log(first);
  for (const expected of ["Schedule message", String(new Date().getFullYear()), "▲", "▼", "soonest +5 min"]) {
    if (!first.includes(expected)) fail(`schedule picker is missing "${expected}"`);
  }

  // It opens on the earliest allowed time and will not go back from there.
  // The year is the field that never wraps: left, left, left reaches it, and down is refused.
  const opened = Date.now();
  for (let i = 0; i < 3; i += 1) await act(async () => setup.mockInput.pressArrow("left"));
  await act(async () => setup.mockInput.pressArrow("down"));
  await setup.flush();
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const earliest = submitted[0];
  if (earliest === undefined) fail("enter did not submit the picked time");
  else if (earliest.getTime() < opened + 4 * 60_000 || earliest.getTime() > opened + 6 * 60_000 + 1_000) {
    fail(`opened on ${earliest.toString()}, expected about five minutes from now`);
  }

  // Forward is open: up makes it next year, and down brings it back to the earliest.
  await act(async () => setup.mockInput.pressArrow("up"));
  await setup.flush();
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const next = submitted[1];
  if (next === undefined || earliest === undefined || next.getFullYear() !== earliest.getFullYear() + 1) {
    fail("up on the year did not move it forward");
  }
  await act(async () => setup.mockInput.pressArrow("down"));
  await setup.flush();
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const back = submitted[2];
  if (back === undefined || earliest === undefined || back.getFullYear() !== earliest.getFullYear()) {
    fail("down on the year did not come back to the earliest");
  }

  // A lone escape waits out the key parser's timeout before it is a key.
  await act(async () => setup.mockInput.pressEscape());
  await new Promise((resolve) => setTimeout(resolve, 150));
  await setup.flush();
  if (closed !== 1) fail("esc did not close the picker");
}
