import { act, useState } from "react";

import { OverflowText } from "../../ui/overflowtext.js";
import { fail } from "../helpers.js";
import { testRender } from "../testrender.js";

/** Exercise the actual mouse target and selection clock, including resetting on exit. */
export async function runOverflowText(): Promise<void> {
  let select: (value: boolean) => void = () => {};
  let rename: (value: string) => void = () => {};
  function Host() {
    const [active, setActive] = useState(false);
    const [label, setLabel] = useState("abcdefghijklmnopqrstuvwxyz");
    select = setActive;
    rename = setLabel;
    return <box style={{flexDirection: "column"}}>
      <box style={{flexDirection: "row", height: 1}}>
        <OverflowText width={12} padToWidth>{"abcdefghijklmnopqrstuvwxyz"}</OverflowText>
        <text>{"| fixed"}</text>
      </box>
      <box style={{flexDirection: "row", height: 1}}>
        <OverflowText width={12} padToWidth active={active}>{label}</OverflowText>
        <text>{"| fixed"}</text>
      </box>
      <box style={{width: 8, height: 1}}>
        <OverflowText width={40} active={active}>{"abcdefghijklmnopqrstuvwxyz"}</OverflowText>
      </box>
    </box>;
  }
  const setup = await testRender(<Host />, {width: 30, height: 4, exitOnCtrlC: false});
  const frame = () => setup.captureCharFrame().split("\n");
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3500;
    do {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); await setup.flush(); });
      if (predicate()) return;
    } while (Date.now() < deadline);
    fail(`overflow text did not reach the expected frame:\n${setup.captureCharFrame()}`);
  };
  try {
    await setup.flush();
    if (!frame()[0]!.startsWith("abcdefghijk…| fixed")) fail("idle overflow did not keep the columns aligned");
    await act(async () => select(true));
    // Both labels must advance; a busy renderer can skip the first 150 ms window.
    await waitFor(() => /^[b-z]/.test(frame()[1]!) && /^[b-z]/.test(frame()[2]!));
    if (!frame()[0]!.startsWith("abcdefghijk…") || frame()[1]!.indexOf("| fixed") !== 12) fail("selection animated another label or shifted its neighbour");
    await act(async () => rename("ZYXWVUTSRQPONMLK"));
    await setup.flush();
    if (!frame()[1]!.startsWith("ZYXWVUTSRQPO")) fail("a changed label did not restart at its beginning");
    await act(async () => select(false));
    await setup.flush();
    if (!frame()[1]!.startsWith("ZYXWVUTSRQP…")) fail("deselection did not restore the beginning");
    await act(async () => setup.mockMouse.moveTo(2, 0));
    await waitFor(() => /^[b-z]/.test(frame()[0]!));
    await act(async () => setup.mockMouse.moveTo(28, 3));
    await setup.flush();
    if (!frame()[0]!.startsWith("abcdefghijk…")) fail("leaving the label did not reset its scroll");
    console.log("--- long labels: hover and selection reveal text without moving adjacent columns ---");
    console.log(setup.captureCharFrame());
  } finally { setup.renderer.destroy(); }
}
